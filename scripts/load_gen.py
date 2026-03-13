#!/usr/bin/env python3
"""
Wicklee load generator — drives concurrent Ollama inference on fleet nodes
and prints live tok/s per node so you can watch the dashboard react.

Usage:
    # Quick test — both nodes, default model on each, 60 s
    python scripts/load_gen.py --nodes localhost:11434 geiserbmc:11434

    # Override model and run longer with more parallel streams
    python scripts/load_gen.py \
        --nodes localhost:11434 geiserbmc:11434 \
        --model llama3.2:3b \
        --streams 2 \
        --duration 300

    # Single node, heavier prompt
    python scripts/load_gen.py --nodes geiserbmc:11434 --prompt long

Flags:
    --nodes       HOST:PORT[,...]  Comma-sep or space-sep list of Ollama endpoints
    --model       Model name (default: use whatever is loaded on the node)
    --streams     Parallel streams per node (default: 1)
    --duration    Seconds to run (default: 120; 0 = run until Ctrl-C)
    --prompt      short | medium | long | reasoning  (default: medium)
    --no-colour   Disable ANSI colour output
"""

import argparse
import json
import sys
import threading
import time
import urllib.request
from collections import defaultdict, deque
from datetime import datetime

# ── Prompts ──────────────────────────────────────────────────────────────────

PROMPTS = {
    "short": "Count from 1 to 50.",
    "medium": (
        "Explain the difference between transformer self-attention and cross-attention. "
        "Give a concrete example of each with pseudo-code."
    ),
    "long": (
        "Write a detailed technical guide (at least 800 words) on how to implement "
        "a Retrieval-Augmented Generation (RAG) pipeline from scratch using only "
        "standard Python libraries, covering document ingestion, chunking strategy, "
        "embedding, vector search, and response synthesis."
    ),
    "reasoning": (
        "A farmer has 17 sheep. All but 9 die. How many are left? "
        "Work through this step by step, then solve: if a snail climbs 3m up a wall "
        "during the day and slides 2m back at night, starting from the bottom of a "
        "10m wall, on which day does it reach the top?"
    ),
}

# ── ANSI colours ─────────────────────────────────────────────────────────────

COLOURS = ["\033[36m", "\033[33m", "\033[32m", "\033[35m", "\033[34m"]
RESET   = "\033[0m"
BOLD    = "\033[1m"
DIM     = "\033[2m"
RED     = "\033[31m"
GREEN   = "\033[32m"


def strip_colour(s: str) -> str:
    import re
    return re.sub(r"\033\[[0-9;]*m", "", s)


# ── Per-node stats ────────────────────────────────────────────────────────────

class NodeStats:
    def __init__(self, host: str):
        self.host      = host
        self.lock      = threading.Lock()
        self.requests  = 0          # completed requests
        self.tokens    = 0          # total tokens generated
        self.errors    = 0
        self.active    = 0          # currently in-flight streams
        # Rolling tok/s: ring buffer of (timestamp, token_count) tuples
        self._ring: deque = deque(maxlen=30)
        self.last_tps  = 0.0
        self.peak_tps  = 0.0

    def record_tokens(self, n: int):
        with self.lock:
            self.tokens += n
            now = time.monotonic()
            self._ring.append((now, n))
            # Compute tok/s over the last 10 s
            cutoff = now - 10.0
            window = [(t, c) for t, c in self._ring if t >= cutoff]
            if len(window) >= 2:
                elapsed = window[-1][0] - window[0][0]
                total   = sum(c for _, c in window)
                self.last_tps = total / elapsed if elapsed > 0 else 0.0
                if self.last_tps > self.peak_tps:
                    self.peak_tps = self.last_tps

    def record_complete(self):
        with self.lock:
            self.requests += 1

    def record_error(self):
        with self.lock:
            self.errors += 1


# ── Inference worker ─────────────────────────────────────────────────────────

def infer_stream(host: str, model: str | None, prompt: str,
                 stats: NodeStats, stop_event: threading.Event):
    """Single streaming inference request. Returns when generation completes."""
    url  = f"http://{host}/api/generate"
    body = {"prompt": prompt, "stream": True}
    if model:
        body["model"] = model

    try:
        data = json.dumps(body).encode()
        req  = urllib.request.Request(url, data=data,
                                      headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            token_count = 0
            for raw_line in resp:
                if stop_event.is_set():
                    break
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # Ollama sends one JSON object per token when stream=True
                token_count += 1
                stats.record_tokens(1)
                if obj.get("done"):
                    break
        stats.record_complete()
    except Exception as exc:
        stats.record_error()
        # Surface to stderr without interrupting the display loop
        print(f"\r{RED}[{host}] error: {exc}{RESET}         ", file=sys.stderr)


def worker_loop(host: str, model: str | None, prompt: str,
                stats: NodeStats, stop_event: threading.Event):
    """Runs back-to-back inference requests until stop_event is set."""
    with stats.lock:
        stats.active += 1
    try:
        while not stop_event.is_set():
            infer_stream(host, model, prompt, stats, stop_event)
    finally:
        with stats.lock:
            stats.active -= 1


# ── Live display ─────────────────────────────────────────────────────────────

def render(nodes: list[NodeStats], colour: bool, start: float,
           duration: int, stop_event: threading.Event):
    """
    Prints a live status block that refreshes in-place.
    Each node gets one line. Fleet totals at bottom.
    """
    # Move cursor up by (len(nodes) + 4) lines after first render
    lines_to_clear = len(nodes) + 5
    first = True

    while not stop_event.is_set():
        now     = time.monotonic()
        elapsed = now - start
        remaining = max(0, duration - elapsed) if duration > 0 else None

        lines = []

        ts = datetime.now().strftime("%H:%M:%S")
        timer_str = (
            f"  {DIM}{ts}  elapsed {elapsed:.0f}s  "
            f"remaining {remaining:.0f}s{RESET}"
            if remaining is not None
            else f"  {DIM}{ts}  elapsed {elapsed:.0f}s  running until Ctrl-C{RESET}"
        )
        lines.append(
            f"{BOLD}{'─' * 68}{RESET}" if colour else "─" * 68
        )
        lines.append(
            (f"{BOLD}  Wicklee Load Generator{RESET}" if colour
             else "  Wicklee Load Generator") + timer_str
        )
        lines.append(
            (f"{BOLD}{'─' * 68}{RESET}" if colour else "─" * 68)
        )

        fleet_tps   = 0.0
        fleet_peak  = 0.0
        fleet_tok   = 0
        fleet_req   = 0
        fleet_err   = 0

        for idx, s in enumerate(nodes):
            with s.lock:
                tps   = s.last_tps
                peak  = s.peak_tps
                tok   = s.tokens
                req   = s.requests
                err   = s.errors
                act   = s.active

            fleet_tps  += tps
            fleet_peak += peak
            fleet_tok  += tok
            fleet_req  += req
            fleet_err  += err

            bar_width = 20
            bar_fill  = int(min(tps / max(peak, 1.0) * bar_width, bar_width))
            bar = "█" * bar_fill + "░" * (bar_width - bar_fill)

            col = COLOURS[idx % len(COLOURS)] if colour else ""
            rst = RESET if colour else ""

            tps_str  = f"{tps:6.1f} tok/s"
            peak_str = f"peak {peak:5.1f}"
            req_str  = f"{req} req"
            err_str  = f"  {RED}{err} err{rst}" if err else ""
            act_str  = f"  {act} active" if act > 0 else ""

            lines.append(
                f"  {col}{s.host:<22}{rst} {bar} {tps_str}  {peak_str}  {req_str}{err_str}{act_str}"
            )

        lines.append(
            (f"{BOLD}{'─' * 68}{RESET}" if colour else "─" * 68)
        )
        fleet_bar_fill = int(min(fleet_tps / max(fleet_peak, 1.0) * 20, 20))
        fleet_bar = "█" * fleet_bar_fill + "░" * (20 - fleet_bar_fill)
        lines.append(
            f"  {'fleet total':<22} {fleet_bar} {fleet_tps:6.1f} tok/s  "
            f"peak {fleet_peak:5.1f}  {fleet_req} req  {fleet_tok} tok"
        )

        # Move cursor up and overwrite on subsequent renders
        output = "\n".join(lines)
        if not first and colour:
            sys.stdout.write(f"\033[{lines_to_clear}A")
        sys.stdout.write(output + "\n")
        sys.stdout.flush()
        first = False
        lines_to_clear = len(lines)

        time.sleep(0.5)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Wicklee inference load generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--nodes", nargs="+", required=True,
        metavar="HOST:PORT",
        help="Ollama endpoint(s), e.g. localhost:11434 192.168.1.10:11434",
    )
    parser.add_argument("--model",    default=None,     help="Model name (default: node's loaded model)")
    parser.add_argument("--streams",  type=int, default=1, help="Parallel streams per node (default: 1)")
    parser.add_argument("--duration", type=int, default=120, help="Seconds to run; 0 = forever (default: 120)")
    parser.add_argument("--prompt",   choices=list(PROMPTS), default="medium", help="Prompt size preset")
    parser.add_argument("--no-colour", action="store_true", help="Disable colour output")
    args = parser.parse_args()

    colour = not args.no_colour and sys.stdout.isatty()
    prompt = PROMPTS[args.prompt]

    # Build per-node stats objects
    all_stats: list[NodeStats] = [NodeStats(h) for h in args.nodes]

    stop_event = threading.Event()
    threads: list[threading.Thread] = []

    # Launch worker threads
    for stats in all_stats:
        for _ in range(args.streams):
            t = threading.Thread(
                target=worker_loop,
                args=(stats.host, args.model, prompt, stats, stop_event),
                daemon=True,
            )
            t.start()
            threads.append(t)

    start = time.monotonic()

    # Duration watchdog
    if args.duration > 0:
        def watchdog():
            time.sleep(args.duration)
            stop_event.set()
        threading.Thread(target=watchdog, daemon=True).start()

    print(f"\nStarting load gen — {len(args.nodes)} node(s) × {args.streams} stream(s)"
          f" — prompt '{args.prompt}' ({len(prompt)} chars)"
          f" — {'∞' if args.duration == 0 else str(args.duration) + 's'}")
    if args.model:
        print(f"Model: {args.model}")
    print("Press Ctrl-C to stop early.\n")

    try:
        render(all_stats, colour, start, args.duration, stop_event)
    except KeyboardInterrupt:
        stop_event.set()

    # Wait for in-flight requests to drain (up to 5 s)
    deadline = time.monotonic() + 5
    for t in threads:
        remaining_wait = max(0, deadline - time.monotonic())
        t.join(timeout=remaining_wait)

    # Final summary
    print("\n\nFinal summary:")
    print("─" * 50)
    for s in all_stats:
        elapsed = time.monotonic() - start
        avg_tps = s.tokens / elapsed if elapsed > 0 else 0
        print(f"  {s.host}")
        print(f"    Requests completed : {s.requests}")
        print(f"    Total tokens       : {s.tokens}")
        print(f"    Peak tok/s         : {s.peak_tps:.1f}")
        print(f"    Avg tok/s          : {avg_tps:.1f}")
        print(f"    Errors             : {s.errors}")
    print("─" * 50)


if __name__ == "__main__":
    main()
