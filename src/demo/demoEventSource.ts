/**
 * Fake EventSource for the demo build. Drives the real FleetStreamContext
 * frame-processing path with synthetic fleet frames at 1 Hz — the entire
 * live dashboard (events, smoothing, thermal transitions, model swaps)
 * runs its production code against generated data.
 */

import { demoFrame } from './demoFleet';

export class DemoEventSource {
  onopen:    (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror:   (() => void) | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(_url?: string) {
    // First frame + open on the next tick so handlers are attached.
    setTimeout(() => {
      this.onopen?.();
      this.tick();
      this.timer = setInterval(() => this.tick(), 1000);
    }, 50);
  }

  private tick() {
    try {
      this.onmessage?.({ data: JSON.stringify(demoFrame(Date.now())) });
    } catch { /* never break the loop on a frame bug */ }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
