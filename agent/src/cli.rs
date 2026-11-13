//! Subcommand dispatch and text rendering.
//!
//! The CLI is a client of the running agent, like the existing `--status`
//! flag. It reads the same `/v1` routes a dashboard or an agent would, so
//! there is one code path and the text output cannot drift from the JSON —
//! `--json` prints what the renderer was given, verbatim.
//!
//! A first argument that does not start with `--` is a subcommand. Everything
//! else, including `wicklee` with no arguments and every existing flag,
//! reaches the agent path untouched.

/// What the argument list asks for.
pub(crate) enum Invocation {
    /// Not a subcommand. Run the agent, or let an existing flag handle it.
    Agent,
    Run(Command),
    /// A subcommand that does not exist, with the message to print.
    Unknown(String),
}

pub(crate) enum Command {
    /// `wicklee ready [MODEL] [--json]`
    Ready { model: Option<String>, json: bool },
}

/// Column the description starts in, and the width text wraps at.
const NAME_WIDTH: usize = 16;
const WRAP_AT: usize = 62;

pub(crate) fn parse(args: &[String]) -> Invocation {
    let Some(first) = args.first() else {
        return Invocation::Agent;
    };
    if first.starts_with('-') {
        return Invocation::Agent;
    }
    match first.as_str() {
        "ready" => {
            let json = args.iter().any(|a| a == "--json");
            let model = args
                .iter()
                .skip(1)
                .find(|a| !a.starts_with('-'))
                .cloned();
            Invocation::Run(Command::Ready { model, json })
        }
        other => Invocation::Unknown(format!(
            "wicklee: unknown subcommand {other:?}\n\nAvailable:\n  \
             wicklee ready [MODEL] [--json]   which models can run now\n\n\
             Run `wicklee` with no arguments to start the agent in the foreground."
        )),
    }
}

/// Run a subcommand against the agent on `port`. Returns the process exit code.
pub(crate) async fn run(cmd: Command, port: u16) -> i32 {
    match cmd {
        Command::Ready { model, json } => {
            let mut url = format!("http://127.0.0.1:{port}/v1/readiness");
            if let Some(m) = model.as_deref() {
                url.push_str("?model=");
                url.push_str(&urlencode(m));
            }
            match reqwest::get(&url).await {
                Ok(resp) => {
                    let status = resp.status();
                    let parsed: Option<serde_json::Value> = resp.json().await.ok();
                    // An agent without /v1 falls through to the SPA handler,
                    // which answers 200 with HTML. Rendering that as an empty
                    // table would read as "nothing is loaded" when the truth
                    // is "this build cannot answer the question".
                    let Some(body) = parsed.filter(|b| {
                        !status.is_success() || is_readiness_answer(b)
                    }) else {
                        eprintln!(
                            "wicklee: the agent on 127.0.0.1:{port} did not return a readiness answer."
                        );
                        eprintln!(
                            "         It is probably an older build that does not serve /v1 yet. \
                             Check which one is running with: wicklee --status"
                        );
                        return 1;
                    };
                    if !status.is_success() {
                        // A model this host has never seen is a 404, and saying
                        // so is more useful than printing an empty table.
                        eprintln!(
                            "wicklee: {}",
                            body["error"].as_str().unwrap_or("the agent returned an error")
                        );
                        if let Some(hint) = body["hint"].as_str() {
                            eprintln!("         {hint}");
                        }
                        return 1;
                    }
                    if json {
                        println!("{}", serde_json::to_string_pretty(&body).unwrap_or_default());
                    } else {
                        print!("{}", render_ready(&body));
                    }
                    0
                }
                Err(_) => {
                    eprintln!("wicklee: the agent is not responding on 127.0.0.1:{port}.");
                    eprintln!("{}", start_hint());
                    1
                }
            }
        }
    }
}

/// How to start the agent on this platform.
fn start_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "         Start it with: sudo wicklee --install-service  (or: sudo launchctl kickstart -k system/dev.wicklee.agent)"
    }
    #[cfg(target_os = "linux")]
    {
        "         Start it with: sudo wicklee --install-service  (or: sudo systemctl start wicklee)"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        "         Start it with: wicklee --install-service"
    }
}

/// Minimal percent-encoding for a model name in a query string.
///
/// Model tags contain `:` and `/`, which a query value must not carry raw.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Whether a 200 body is actually a readiness answer.
///
/// Either shape the route serves: the whole fleet of models, or one model.
pub(crate) fn is_readiness_answer(body: &serde_json::Value) -> bool {
    body["models"].is_array() || body["readiness"].is_object()
}

/// The "which models can run safely now" section.
///
/// Takes the response as given rather than a parsed type, so the renderer
/// reads exactly what the route serves and a field added to the answer cannot
/// silently stop being printed.
pub(crate) fn render_ready(body: &serde_json::Value) -> String {
    let rows: Vec<&serde_json::Value> = match (&body["models"], &body["readiness"]) {
        (serde_json::Value::Array(a), _) => a.iter().collect(),
        (_, r) if r.is_object() => vec![r],
        _ => Vec::new(),
    };

    let mut out = String::from("WHICH MODELS CAN RUN SAFELY NOW\n");
    if rows.is_empty() {
        out.push_str("  Nothing is known yet. The agent learns what is installed from\n");
        out.push_str("  the runtime; check that it is reachable with: wicklee --status\n");
        return out;
    }

    for row in &rows {
        let name = row["model"].as_str().unwrap_or("?");
        let text = describe(row);
        out.push_str(&wrap(name, &text));
    }

    if body["activity_signal"] == serde_json::Value::Bool(false) {
        out.push_str(
            "\nNot checked: whether any model is in use (this runtime does not\n  \
             report expires_at, so there is no activity signal).\n",
        );
    }
    out
}

/// One model's one-line description.
fn describe(row: &serde_json::Value) -> String {
    let activity = match (row["in_use"].as_bool(), row["last_activity_ms"].as_i64()) {
        (Some(true), Some(ts)) => {
            let secs = (row["observed_at_ms"].as_i64().unwrap_or(ts) - ts).max(0) / 1_000;
            format!("in use {secs} s ago")
        }
        (Some(true), None) => "in use".to_string(),
        (Some(false), _) => "idle".to_string(),
        (None, _) => "activity unknown".to_string(),
    };

    match row["readiness"].as_str().unwrap_or("") {
        "ready_now" => format!("Ready now, {activity}"),
        "requires_loading" => match row["fit_basis"].as_str() {
            Some("measured") => "Requires loading, and fits on a measured footprint".to_string(),
            _ => "Requires loading, and fits on a calibrated estimate".to_string(),
        },
        "may_require_eviction" => format!("May require eviction: {}", eviction(row)),
        "cannot_determine" => format!("Cannot determine: {}", undetermined(row)),
        other => format!("Unrecognised state {other:?} — this CLI is older than the agent"),
    }
}

fn eviction(row: &serde_json::Value) -> String {
    let victims: Vec<&str> = row["would_displace"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v["model"].as_str()).collect())
        .unwrap_or_default();
    let in_use: Vec<&str> = row["would_displace"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|v| v["in_use"] == serde_json::Value::Bool(true))
                .filter_map(|v| v["model"].as_str())
                .collect()
        })
        .unwrap_or_default();
    let busy = match in_use.as_slice() {
        [] => String::new(),
        [one] => format!(", including {one}, which is in use"),
        many => format!(", including {}, which are in use", many.join(" and ")),
    };

    match row["displacement"].as_str().unwrap_or("") {
        "likely_all" => format!("likely clears all {} resident models{busy}", victims.len()),
        "likely" => format!(
            "likely clears {}{}",
            victims.first().copied().unwrap_or("the resident model"),
            if in_use.is_empty() { "" } else { ", which is in use" }
        ),
        _ if victims.is_empty() => {
            "may clear one or more resident models, and the log does not say which".to_string()
        }
        _ => "may clear one or more resident models".to_string(),
    }
}

fn undetermined(row: &serde_json::Value) -> String {
    if row["footprint"].is_null() {
        return "its footprint has never been measured and no file size is known".to_string();
    }
    if row["headroom"].is_null() {
        return "free accelerator memory is unknown on this host".to_string();
    }
    "a required input is missing".to_string()
}

/// Lay out one row: the name in its column, the text wrapped under it.
fn wrap(name: &str, text: &str) -> String {
    let mut out = String::new();
    let mut col = 0usize;
    let mut first = true;
    for word in text.split_whitespace() {
        if col == 0 {
            if first {
                out.push_str(&format!("  {name:<NAME_WIDTH$}"));
                first = false;
            } else {
                out.push_str(&" ".repeat(NAME_WIDTH + 2));
            }
            out.push_str(word);
            col = word.len();
        } else if col + 1 + word.len() <= WRAP_AT {
            out.push(' ');
            out.push_str(word);
            col += 1 + word.len();
        } else {
            out.push('\n');
            out.push_str(&" ".repeat(NAME_WIDTH + 2));
            out.push_str(word);
            col = word.len();
        }
    }
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_leading_flag_or_no_arguments_still_runs_the_agent() {
        for a in [vec![], args(&["--status"]), args(&["--version"]), args(&["-V"])] {
            assert!(
                matches!(parse(&a), Invocation::Agent),
                "{a:?} must not be read as a subcommand"
            );
        }
    }

    #[test]
    fn ready_takes_an_optional_model_and_a_json_flag() {
        let Invocation::Run(Command::Ready { model, json }) = parse(&args(&["ready"])) else {
            panic!("expected ready");
        };
        assert_eq!(model, None);
        assert!(!json);

        let Invocation::Run(Command::Ready { model, json }) =
            parse(&args(&["ready", "qwen3.5:4b", "--json"]))
        else {
            panic!("expected ready");
        };
        assert_eq!(model.as_deref(), Some("qwen3.5:4b"));
        assert!(json);

        // Flag order does not matter, and the flag is not taken as the model.
        let Invocation::Run(Command::Ready { model, json }) =
            parse(&args(&["ready", "--json", "coder:14b"]))
        else {
            panic!("expected ready");
        };
        assert_eq!(model.as_deref(), Some("coder:14b"));
        assert!(json);
    }

    #[test]
    fn an_unknown_subcommand_says_so_rather_than_starting_the_agent() {
        let Invocation::Unknown(msg) = parse(&args(&["inspekt"])) else {
            panic!("a typo must not boot a daemon");
        };
        assert!(msg.contains("unknown subcommand"));
        assert!(msg.contains("wicklee ready"), "it lists what does exist");
    }

    #[test]
    fn a_model_tag_survives_the_query_string() {
        assert_eq!(urlencode("qwen3.5:4b"), "qwen3.5%3A4b");
        assert_eq!(urlencode("library/llama3.1:8b"), "library%2Fllama3.1%3A8b");
    }

    /// The renderer is fed the real route output, built by the real classifier,
    /// so the text cannot drift from the JSON it describes.
    fn real_answer() -> serde_json::Value {
        use crate::readiness::{Headroom, Inputs, assess};
        use crate::residency::{Cause, ModelState, Residency, Transition, TransitionKind};
        const T0: i64 = 1_700_000_000_000;
        const GB: u64 = 1024 * 1024 * 1024;

        let state = |model: &str, residency, size: Option<u64>, vram: Option<u64>| ModelState {
            model: model.to_string(),
            digest: Some(format!("sha256:{model}")),
            residency,
            size_bytes: size,
            size_vram_bytes: vram,
            context_length: size.map(|_| 4096),
            expires_at_ms: None,
            last_activity_ms: None,
            installed_size_bytes: None,
            measured: None,
            observed_at_ms: T0,
        };

        let mut coder = state("coder:14b", Residency::Loaded, Some(10 * GB), Some(10 * GB));
        coder.last_activity_ms = Some(T0 + 48_000);
        let classifier = state("classifier:3b", Residency::Loaded, Some(2 * GB), Some(2 * GB));
        let mut reasoner = state("reasoner:14b", Residency::NotLoaded, None, None);
        reasoner.installed_size_bytes = Some(20 * GB);
        let embed = state("embed:small", Residency::NotLoaded, None, None);

        let tr = |id: u64, ts: i64, model: &str, kind| Transition {
            id,
            ts_ms: ts,
            model: model.to_string(),
            kind,
            cause: Cause::User,
            before: None,
            after: None,
            co_resident: vec![],
        };
        let mut log = Vec::new();
        for (i, ts) in [T0, T0 + 30_000].into_iter().enumerate() {
            let b = i as u64 * 10;
            log.push(tr(b + 1, ts, "coder:14b", TransitionKind::Unloaded));
            log.push(tr(b + 2, ts, "classifier:3b", TransitionKind::Unloaded));
            log.push(tr(b + 3, ts, "big:70b", TransitionKind::Loaded));
        }
        log.push(tr(99, T0 + 40_000, "coder:14b", TransitionKind::Loaded));
        log.push(tr(100, T0 + 40_000, "classifier:3b", TransitionKind::Loaded));

        let states = vec![&coder, &classifier, &reasoner, &embed];
        let models = assess(&Inputs {
            states,
            transitions: &log,
            headroom: Some(Headroom { free_bytes: 3 * GB, source: "nvml" }),
            activity_signal: true,
            now_ms: T0 + 60_000,
        });
        serde_json::json!({ "models": models, "activity_signal": true })
    }

    #[test]
    fn the_section_reads_like_the_spec_example() {
        let out = render_ready(&real_answer());
        println!("{out}");

        assert!(out.starts_with("WHICH MODELS CAN RUN SAFELY NOW\n"));
        assert!(out.contains("coder:14b       Ready now, in use 12 s ago"), "got:\n{out}");
        assert!(out.contains("classifier:3b   Ready now, idle"), "got:\n{out}");
        // The eviction line names the in-use victim, which is the whole point.
        assert!(out.contains("May require eviction: likely clears all 2 resident"), "got:\n{out}");
        assert!(out.contains("including coder:14b, which is in use"), "got:\n{out}");
        assert!(out.contains("Cannot determine:"), "got:\n{out}");

        // Wrapped lines line up under the description column.
        for line in out.lines().filter(|l| l.starts_with(&" ".repeat(NAME_WIDTH + 2))) {
            assert!(line.len() <= NAME_WIDTH + 2 + WRAP_AT, "line too wide: {line:?}");
        }
    }

    #[test]
    fn html_from_an_older_agent_is_not_mistaken_for_an_empty_answer() {
        // The SPA fallback answers 200 with HTML, so "did it parse as JSON" is
        // not enough on its own — an empty object parses fine.
        assert!(!is_readiness_answer(&serde_json::json!({})));
        assert!(!is_readiness_answer(&serde_json::json!({ "ok": true })));
        // Both shapes the route really serves.
        assert!(is_readiness_answer(&serde_json::json!({ "models": [] })));
        assert!(is_readiness_answer(&serde_json::json!({ "readiness": { "model": "a" } })));
    }

    #[test]
    fn an_empty_answer_says_nothing_is_known_rather_than_nothing_is_ready() {
        let out = render_ready(&serde_json::json!({ "models": [], "activity_signal": true }));
        assert!(out.contains("Nothing is known yet"), "got:\n{out}");
        assert!(!out.contains("Ready now"));
    }

    #[test]
    fn a_runtime_with_no_activity_signal_says_what_it_could_not_check() {
        let mut body = real_answer();
        body["activity_signal"] = serde_json::Value::Bool(false);
        let out = render_ready(&body);
        assert!(out.contains("Not checked: whether any model is in use"), "got:\n{out}");
    }
}
