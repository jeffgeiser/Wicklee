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
    /// `wicklee inspect [--since 24h] [--json]`
    Inspect { since: Option<String>, json: bool },
    /// `wicklee findings [--all] [--json]`
    Findings { all: bool, json: bool },
    /// `wicklee verify FINDING_ID [--force] [--yes] [--json]`
    Verify { finding_id: String, force: bool, yes: bool, json: bool },
    /// `wicklee fingerprint MODEL[,MODEL...] [--cold] [--sequence] [--runs N]
    /// [--num-ctx N] [--force] [--yes] [--json]`
    Fingerprint {
        models: Vec<String>,
        kind: &'static str,
        runs: Option<u64>,
        num_ctx: Option<u64>,
        force: bool,
        yes: bool,
        json: bool,
    },
}

/// Column the description starts in, and the width text wraps at.
const NAME_WIDTH: usize = 16;
const WRAP_AT: usize = 62;

/// Finding lines carry an id and an evidence label before the text.
const ID_WIDTH: usize = 10;
const LABEL_WIDTH: usize = 10;

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
        "inspect" => {
            let json = args.iter().any(|a| a == "--json");
            // `--since 24h`, and `--since=24h`.
            let since = args
                .iter()
                .position(|a| a == "--since")
                .and_then(|i| args.get(i + 1).cloned())
                .or_else(|| {
                    args.iter()
                        .find_map(|a| a.strip_prefix("--since=").map(str::to_string))
                });
            Invocation::Run(Command::Inspect { since, json })
        }
        "fingerprint" => {
            let flag = |name: &str| args.iter().any(|a| a == name);
            let value = |name: &str| -> Option<u64> {
                let eq = format!("{name}=");
                args.iter()
                    .position(|a| a == name)
                    .and_then(|i| args.get(i + 1))
                    .or_else(|| args.iter().find(|a| a.starts_with(&eq)))
                    .and_then(|v| v.trim_start_matches(&eq[..]).parse().ok())
            };
            // A comma-separated list is a sequence, so `--sequence` is only
            // needed to replay one model against itself.
            let models: Vec<String> = args
                .iter()
                .skip(1)
                .find(|a| !a.starts_with('-'))
                .map(|m| {
                    m.split(',')
                        .map(str::trim)
                        .filter(|m| !m.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let kind = if flag("--cold") {
                "cold_load"
            } else if flag("--sequence") || models.len() > 1 {
                "workflow_replay"
            } else {
                "decode_rate"
            };
            Invocation::Run(Command::Fingerprint {
                models,
                kind,
                runs: value("--runs"),
                num_ctx: value("--num-ctx"),
                force: flag("--force"),
                yes: flag("--yes") || flag("-y"),
                json: flag("--json"),
            })
        }
        "verify" => {
            let flag = |name: &str| args.iter().any(|a| a == name);
            Invocation::Run(Command::Verify {
                finding_id: args
                    .iter()
                    .skip(1)
                    .find(|a| !a.starts_with('-'))
                    .cloned()
                    .unwrap_or_default(),
                force: flag("--force"),
                yes: flag("--yes") || flag("-y"),
                json: flag("--json"),
            })
        }
        "findings" => Invocation::Run(Command::Findings {
            all: args.iter().any(|a| a == "--all"),
            json: args.iter().any(|a| a == "--json"),
        }),
        other => Invocation::Unknown(format!(
            "wicklee: unknown subcommand {other:?}\n\nAvailable:\n  \
             wicklee inspect [--since 24h] [--json]   what is happening\n  \
             wicklee ready [MODEL] [--json]           which models can run now\n  \
             wicklee findings [--all] [--json]        findings, open or resolved\n  \
             wicklee fingerprint MODEL [--cold]       measure it, with consent\n  \
             wicklee verify FINDING_ID                re-measure a finding\n\n\
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
            fetch_and_render(&url, port, json, "a readiness answer", is_readiness_answer, render_ready).await
        }
        Command::Inspect { since, json } => {
            let mut url = format!("http://127.0.0.1:{port}/v1/inspect");
            if let Some(w) = since.as_deref() {
                url.push_str("?since=");
                url.push_str(&urlencode(w));
            }
            fetch_and_render(&url, port, json, "an inspection", is_inspect_answer, render_inspect).await
        }
        Command::Fingerprint { models, kind, runs, num_ctx, force, yes, json } => {
            run_fingerprint(port, models, kind, runs, num_ctx, force, yes, json).await
        }
        Command::Verify { finding_id, force, yes, json } => {
            run_verify(port, finding_id, force, yes, json).await
        }
        Command::Findings { all, json } => {
            let mut url = format!("http://127.0.0.1:{port}/v1/findings");
            if all {
                url.push_str("?all=true");
            }
            fetch_and_render(&url, port, json, "a list of findings", is_findings_answer, render_findings).await
        }
    }
}

/// The two-step consent handshake, then the run. Shared by `fingerprint` and
/// `verify`, which differ only in the route, the body and the renderer.
///
/// The first POST carries no consent, so the agent answers 400 with the plan
/// and the sentence describing it. That is deliberate rather than a round trip
/// wasted: the agent is the only party that knows what is loaded and at what
/// context, so it is the only one that can say what the run would disturb.
/// This prints that sentence and asks.
async fn consented_run(
    port: u16,
    route: &str,
    mut body: serde_json::Value,
    yes: bool,
    json: bool,
    render: fn(&serde_json::Value) -> String,
) -> i32 {
    let url = format!("http://127.0.0.1:{port}{route}");
    let client = reqwest::Client::new();
    let post = |b: serde_json::Value| {
        let client = client.clone();
        let url = url.clone();
        async move { client.post(&url).json(&b).send().await }
    };

    // Step one: ask what it would do.
    let Ok(resp) = post(body.clone()).await else {
        eprintln!("wicklee: the agent is not responding on 127.0.0.1:{port}.");
        eprintln!("{}", start_hint());
        return 1;
    };
    let status = resp.status();
    let Some(answer) = resp.json::<serde_json::Value>().await.ok().filter(|b| {
        // An older agent's SPA fallback answers 200 with HTML, which parses as
        // nothing this command recognises.
        b.get("plan").is_some() || b.get("error").is_some() || b.get("outcome").is_some()
    }) else {
        eprintln!("wicklee: the agent on 127.0.0.1:{port} does not serve {route}.");
        eprintln!("         Check which build is running with: wicklee --status");
        return 1;
    };

    // A refusal, or a host that cannot run it. Printed as the reason rather
    // than as a failure: most of these are "wait a minute", not "it broke".
    if answer.get("plan").is_none() && answer.get("outcome").is_none() {
        eprintln!("wicklee: {}", answer["error"].as_str().unwrap_or("the run was refused"));
        if let Some(hint) = answer["hint"].as_str() {
            eprintln!("         {hint}");
        }
        return 1;
    }
    if !status.is_success() && answer.get("plan").is_some() {
        print!("{}", answer["consent_text"].as_str().unwrap_or_default());
        // Verify's first run is a baseline and measures nothing by itself.
        // Worth saying before the yes, not after.
        if answer["is_baseline"] == serde_json::json!(true) {
            println!("  this is the first run, so it becomes the baseline. Change something, then run it again");
        }
        if !yes {
            use std::io::Write;
            print!("\nRun it? [y/N] ");
            let _ = std::io::stdout().flush();
            let mut reply = String::new();
            if std::io::stdin().read_line(&mut reply).is_err()
                || !matches!(reply.trim().to_ascii_lowercase().as_str(), "y" | "yes")
            {
                println!("Not run.");
                return 1;
            }
        }
    }

    // Step two: with consent.
    body["consent"] = serde_json::json!(true);
    let Ok(resp) = post(body).await else {
        eprintln!("wicklee: the agent stopped responding partway through the run.");
        return 1;
    };
    let status = resp.status();
    let Ok(result) = resp.json::<serde_json::Value>().await else {
        eprintln!("wicklee: the run did not return a result this command understands.");
        return 1;
    };
    if !status.is_success() {
        eprintln!("wicklee: {}", result["error"].as_str().unwrap_or("the run was refused"));
        return 1;
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&result).unwrap_or_default());
    } else {
        print!("{}", render(&result));
    }
    0
}

/// `wicklee fingerprint MODEL[,MODEL...]`
#[allow(clippy::too_many_arguments)]
async fn run_fingerprint(
    port: u16,
    models: Vec<String>,
    kind: &'static str,
    runs: Option<u64>,
    num_ctx: Option<u64>,
    force: bool,
    yes: bool,
    json: bool,
) -> i32 {
    if models.is_empty() {
        eprintln!("wicklee: name a model. `wicklee fingerprint qwen3:8b`");
        eprintln!("         A comma-separated list runs them as a sequence.");
        return 2;
    }
    let mut body = serde_json::json!({ "kind": kind, "models": models, "force": force });
    if let Some(r) = runs {
        body["runs"] = serde_json::json!(r);
    }
    if let Some(c) = num_ctx {
        body["num_ctx"] = serde_json::json!(c);
    }
    consented_run(port, "/v1/fingerprint", body, yes, json, render_fingerprint).await
}

/// `wicklee verify F-xxxxxx`
async fn run_verify(port: u16, finding_id: String, force: bool, yes: bool, json: bool) -> i32 {
    if finding_id.is_empty() {
        eprintln!("wicklee: name a finding. `wicklee verify F-1a2b3c`");
        eprintln!("         `wicklee findings` lists them.");
        return 2;
    }
    let body = serde_json::json!({ "finding_id": finding_id, "force": force });
    consented_run(port, "/v1/verify", body, yes, json, render_verify).await
}

/// A verify run, and the comparison when there is one to make.
fn render_verify(body: &serde_json::Value) -> String {
    let mut out = String::new();
    let f = &body["finding"];
    out.push_str(&format!(
        "{}  {}\n",
        f["id"].as_str().unwrap_or("?"),
        f["title"].as_str().unwrap_or(""),
    ));

    let run = &body["run"];
    let line = |label: &str, r: &serde_json::Value| {
        format!(
            "    {label:<12}{:.1} tok/s   ({:.1} to {:.1}, n={})\n",
            r["median"].as_f64().unwrap_or_default(),
            r["low"].as_f64().unwrap_or_default(),
            r["high"].as_f64().unwrap_or_default(),
            r["receipts"].as_array().map_or(0, Vec::len),
        )
    };

    match body["comparison"].as_object() {
        None => {
            out.push_str("\n  baseline recorded\n");
            out.push_str(&line("this run", run));
            out.push_str(
                "\n  Change something, then run the same command again to compare.\n",
            );
        }
        Some(_) => {
            let c = &body["comparison"];
            // The top-level verdict, not the one inside the comparison: that
            // one is the serde name, and "no_measurable_change" is not a
            // sentence anyone wants to read.
            out.push_str(&format!("\n  {}\n", body["verdict"].as_str().unwrap_or("?")));
            out.push_str(&format!(
                "    {:<12}{:.1} tok/s\n",
                "baseline",
                c["baseline_median"].as_f64().unwrap_or_default(),
            ));
            out.push_str(&line("this run", run));
            out.push_str(&format!(
                "    {:<12}{:+.1}%\n",
                "change",
                c["change_pct"].as_f64().unwrap_or_default(),
            ));
            // The reason a difference is not called one. Printed, because
            // "no measurable change" with a 12% delta beside it reads as a
            // bug unless the overlap is on the screen too.
            if let Some(why) = c["not_measurable_because"].as_str() {
                out.push_str(&format!("    {:<12}{why}\n", "because"));
            }
            for change in c["config_changes"].as_array().into_iter().flatten() {
                out.push_str(&format!("    {:<12}{}\n", "changed", change.as_str().unwrap_or("")));
            }
            if c["config_changes"].as_array().is_some_and(Vec::is_empty) {
                out.push_str(&format!(
                    "    {:<12}nothing Wicklee can see differed between the two runs\n",
                    "changed",
                ));
            }
        }
    }
    out
}

/// A finished run, as text.
fn render_fingerprint(body: &serde_json::Value) -> String {
    let o = &body["outcome"];
    let mut out = String::new();
    out.push_str(&format!(
        "{} · {}\n",
        o["kind"].as_str().unwrap_or("test"),
        o["test_id"].as_str().unwrap_or("?"),
    ));

    for r in o["results"].as_array().into_iter().flatten() {
        out.push_str(&format!(
            "\n  {} at context {}\n",
            r["model"].as_str().unwrap_or("?"),
            r["num_ctx"],
        ));
        for (label, key, unit) in [
            ("generation", "decode_tps", "tok/s"),
            ("prefill", "prompt_tps", "tok/s"),
            ("load", "load_ms", "ms"),
            ("wall", "wall_ms", "ms"),
        ] {
            let s = &r[key];
            if s.is_null() {
                continue;
            }
            // Median and range, never a mean: three inference runs are not
            // normally distributed, and the range is the part that shows it.
            out.push_str(&format!(
                "    {label:<12}{:.1} {unit}   ({:.1} to {:.1}, n={})\n",
                s["median"].as_f64().unwrap_or_default(),
                s["low"].as_f64().unwrap_or_default(),
                s["high"].as_f64().unwrap_or_default(),
                s["n"].as_u64().unwrap_or_default(),
            ));
        }
        for f in r["failures"].as_array().into_iter().flatten() {
            out.push_str(&format!("    failed      {}\n", f.as_str().unwrap_or("?")));
        }
    }

    if let Some(total) = o["total_wall_ms"].as_u64() {
        out.push_str(&format!(
            "\n  sequence    {:.1}s total, {} load{}\n",
            total as f64 / 1000.0,
            o["loads_observed"].as_u64().unwrap_or_default(),
            if o["loads_observed"].as_u64() == Some(1) { "" } else { "s" },
        ));
    }

    if let Some(note) = o["restore_note"].as_str() {
        out.push_str(&format!(
            "\n  restored    {}\n              {}\n",
            o["restored"]
                .as_array()
                .map(|a| a.iter().filter_map(|m| m.as_str()).collect::<Vec<_>>().join(", "))
                .unwrap_or_default(),
            note,
        ));
    }

    // Said plainly: a run whose receipts were not kept measured something, but
    // it is not a baseline anything can be compared against later.
    if body["receipts_persisted"] == serde_json::json!(false) {
        out.push_str(&format!(
            "\n  warning     {} of {} receipts stored. Without them this run is not a baseline.\n",
            body["receipts_stored"],
            o["results"]
                .as_array()
                .map(|a| a.iter().filter_map(|r| r["receipts"].as_array().map(Vec::len)).sum::<usize>())
                .unwrap_or_default(),
        ));
    }
    out
}

/// Fetch a `/v1` route and render it, or explain why it could not.
///
/// Shared by `ready`, `inspect` and `findings`: the same three failure modes —
/// no agent, an older agent whose SPA handler answers 200 with HTML, and a 4xx
/// with a message worth printing — and one place that gets them right.
async fn fetch_and_render(
    url: &str,
    port: u16,
    json: bool,
    // What this route was asked for, for the message when it answers with
    // something else. It is the only thing the three callers differed by —
    // `ready` carried its own copy of this whole function until that was the
    // only difference left.
    wanted: &str,
    looks_right: fn(&serde_json::Value) -> bool,
    render: fn(&serde_json::Value) -> String,
) -> i32 {
    let Ok(resp) = reqwest::get(url).await else {
        eprintln!("wicklee: the agent is not responding on 127.0.0.1:{port}.");
        eprintln!("{}", start_hint());
        return 1;
    };
    let status = resp.status();
    let parsed: Option<serde_json::Value> = resp.json().await.ok();
    let Some(body) = parsed.filter(|b| !status.is_success() || looks_right(b)) else {
        eprintln!("wicklee: the agent on 127.0.0.1:{port} did not return {wanted}.");
        eprintln!(
            "         It is probably an older build that does not serve this route \
             yet. Check which one is running with: wicklee --status"
        );
        return 1;
    };
    if !status.is_success() {
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
        print!("{}", render(&body));
    }
    0
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

/// Whether a 200 body is an inspect answer.
pub(crate) fn is_inspect_answer(body: &serde_json::Value) -> bool {
    body["findings"].is_array() && body["not_checked"].is_array()
}

/// Whether a 200 body is a findings answer.
pub(crate) fn is_findings_answer(body: &serde_json::Value) -> bool {
    body["findings"].is_array() || body["finding"].is_object()
}

/// The whole `inspect` output: what is happening, then what can run, then what
/// was not checked.
///
/// The spec's example carries a third section, "WHAT TO CHANGE", whose every
/// line is a `wicklee verify` command. `verify` is step 6, so the section is
/// left out rather than printed with commands that do not run yet.
pub(crate) fn render_inspect(body: &serde_json::Value) -> String {
    let mut out = String::from("WHAT IS HAPPENING\n");
    let findings = body["findings"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if findings.is_empty() {
        out.push_str("  No significant issues found.\n");
    } else {
        for f in findings {
            out.push_str(&render_finding(f));
        }
    }

    out.push('\n');
    out.push_str(&render_ready(&serde_json::json!({
        "models":          body["readiness"].clone(),
        "activity_signal": body["activity_signal"].clone(),
    })));

    out.push_str(&render_not_checked(body));
    out.push_str(&render_history_scope(body));
    out
}

/// The `findings` output: the findings alone.
pub(crate) fn render_findings(body: &serde_json::Value) -> String {
    let rows: Vec<&serde_json::Value> = match (&body["findings"], &body["finding"]) {
        (serde_json::Value::Array(a), _) => a.iter().collect(),
        (_, f) if f.is_object() => vec![f],
        _ => Vec::new(),
    };
    let (open, resolved): (Vec<&serde_json::Value>, Vec<&serde_json::Value>) =
        rows.into_iter().partition(|f| f["resolved_at_ms"].is_null());

    let mut out = String::from("FINDINGS\n");
    if open.is_empty() {
        out.push_str("  No open findings.\n");
    } else {
        for f in &open {
            out.push_str(&render_finding(f));
        }
    }

    if !resolved.is_empty() {
        out.push_str("\nRESOLVED\n");
        for f in &resolved {
            out.push_str(&render_finding(f));
        }
    }

    out.push_str(&render_not_checked(body));

    // Three different states, and conflating them is the whole hazard: asked
    // and got them, asked and the store could not answer, did not ask.
    let asked = body["includes_resolved"] == serde_json::Value::Bool(true);
    if !asked && body["persisted"] == serde_json::Value::Bool(false) {
        out.push_str(
            "\nFindings are not being stored, so they last only until this agent\n  \
             restarts and there is no resolved history to list.\n",
        );
    } else if !asked {
        out.push_str("\nResolved findings are not listed. Add --all to include them.\n");
    } else if resolved.is_empty() {
        out.push_str("\nNo resolved findings on record.\n");
    }
    out
}

/// One finding: its id, then one line per statement with its evidence label.
fn render_finding(f: &serde_json::Value) -> String {
    let id = f["id"].as_str().unwrap_or("?");
    let mut out = String::new();
    let statements = f["statements"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if statements.is_empty() {
        // Should not happen: a finding needs an observed statement. Printing
        // the title is better than printing an id with nothing beside it.
        out.push_str(&wrap_statement(id, "", f["title"].as_str().unwrap_or("")));
        return out;
    }
    for (i, st) in statements.iter().enumerate() {
        let label = st["label"].as_str().unwrap_or("").to_ascii_uppercase();
        out.push_str(&wrap_statement(
            if i == 0 { id } else { "" },
            &label,
            st["text"].as_str().unwrap_or(""),
        ));
    }
    out.push('\n');
    out
}

/// The trailing "Not checked:" lines, one per rule that did not run.
fn render_not_checked(body: &serde_json::Value) -> String {
    let rows = body["not_checked"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if rows.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n");
    for n in rows {
        let (Some(rule), Some(reason)) = (n["rule"].as_str(), n["reason"].as_str()) else {
            continue;
        };
        out.push_str(&format!("Not checked: {rule} ({reason})\n"));
    }
    out
}

/// A note when the rules only had this process's log to read.
///
/// Without it a short history reads as a quiet host, which is exactly the
/// silent-empty-result failure the spec warns about for musl builds.
fn render_history_scope(body: &serde_json::Value) -> String {
    if body["history"]["persisted"] == serde_json::Value::Bool(false) {
        let n = body["history"]["transitions"].as_i64().unwrap_or(0);
        return format!(
            "\nHistory: {n} transitions, from this agent process only — \
             findings that need a longer\n  window cannot fire yet.\n"
        );
    }
    String::new()
}

/// Wrap a statement under an id column and an evidence-label column.
fn wrap_statement(id: &str, label: &str, text: &str) -> String {
    let indent = 2 + ID_WIDTH + LABEL_WIDTH;
    let mut out = format!("  {id:<ID_WIDTH$}{label:<LABEL_WIDTH$}");
    let mut col = 0usize;
    for word in text.split_whitespace() {
        if col == 0 {
            out.push_str(word);
            col = word.len();
        } else if col + 1 + word.len() <= WRAP_AT {
            out.push(' ');
            out.push_str(word);
            col += 1 + word.len();
        } else {
            out.push('\n');
            out.push_str(&" ".repeat(indent));
            out.push_str(word);
            col = word.len();
        }
    }
    out.push('\n');
    out
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
        "unknown_victim" if victims.is_empty() => {
            "may clear one or more resident models, and the log does not say which".to_string()
        }
        "unknown_victim" => "may clear one or more resident models".to_string(),
        // No level at all: it does not fit, and nothing else is resident.
        // There is no eviction that would help, which is a different answer
        // from "something will be cleared and we cannot say what".
        _ => "it does not fit in free memory, and nothing is resident to evict".to_string(),
    }
}

fn undetermined(row: &serde_json::Value) -> String {
    if row["footprint"].is_null() {
        return "its footprint has never been measured and no file size is known".to_string();
    }
    if row["headroom"].is_null() {
        return "free accelerator memory is unknown on this host".to_string();
    }
    // It appears to fit, on an estimate nothing has calibrated. Saying so is
    // the whole point: the previous wording for this case claimed it "may
    // require eviction", which asserted something about resident models that
    // was not true — and said it on a host with nothing resident at all.
    if row["footprint"]["basis"] == "estimated_weights_only"
        && row["footprint"]["calibrated"] != serde_json::Value::Bool(true)
    {
        return "it may fit, but its footprint is estimated from the installed file \
                size and nothing measured on this host has calibrated that estimate"
            .to_string();
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

    /// Built from the real classifier, like the spec-example test: a model
    /// that clears headroom on an uncalibrated estimate, and one that misses
    /// it with nothing resident. Neither may use eviction wording.
    #[test]
    fn nothing_claims_an_eviction_that_has_no_victim() {
        use crate::readiness::{Headroom, Inputs, assess};
        use crate::residency::{ModelState, Residency};
        const T0: i64 = 1_700_000_000_000;
        const GB: u64 = 1024 * 1024 * 1024;

        let never_loaded = |model: &str, installed: u64| ModelState {
            model: model.to_string(),
            digest: Some(format!("sha256:{model}")),
            residency: Residency::NotLoaded,
            size_bytes: None,
            size_vram_bytes: None,
            context_length: None,
            expires_at_ms: None,
            last_activity_ms: None,
            installed_size_bytes: Some(installed),
            measured: None,
            observed_at_ms: T0,
        };

        // Fits with room to spare, on a number nothing has calibrated.
        let roomy = never_loaded("embed:small", 2 * GB);
        // Does not fit, and nothing at all is resident to clear.
        let huge = never_loaded("reasoner:70b", 40 * GB);
        let states = vec![&roomy, &huge];
        let models = assess(&Inputs {
            states,
            transitions: &[],
            headroom: Some(Headroom { free_bytes: 8 * GB, source: "nvml" }),
            activity_signal: true,
            now_ms: T0 + 1_000,
        });
        let out = render_ready(&serde_json::json!({
            "models": models,
            "activity_signal": true,
        }));
        println!("{out}");

        // Neither line may imply a resident model, because there are none.
        assert!(!out.contains("clears"), "got:\n{out}");
        assert!(!out.contains("may clear"), "got:\n{out}");

        assert!(out.contains("embed:small"), "got:\n{out}");
        assert!(
            out.contains("it may fit, but its footprint is estimated"),
            "the uncalibrated case says why it cannot answer; got:\n{out}"
        );
        assert!(
            out.contains("nothing is resident to evict"),
            "the too-large case says there is nothing to displace; got:\n{out}"
        );
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

    // ── inspect and findings ─────────────────────────────────────────────────

    fn inspect_body() -> serde_json::Value {
        serde_json::json!({
            "findings": [{
                "id": "F-a3f29c",
                "rule": "cpu_split",
                "severity": "warning",
                "title": "coder:14b is partly outside accelerator memory",
                "models": ["coder:14b"],
                "statements": [
                    { "label": "observed",
                      "text": "coder:14b has had 40% of its runtime footprint (4.0 GiB) outside accelerator memory for 22 minutes, running at a 32768-token context." },
                    { "label": "inferred",
                      "text": "Its context grew from 8192 to 32768 tokens 3 minutes before the split, so KV cache rather than weights is the likely cause." },
                ],
                "first_seen_ms": 1_700_000_000_000_i64,
                "last_seen_ms": 1_700_000_060_000_i64,
            }],
            "not_checked": [
                { "rule": "baseline_regression", "reason": "no fingerprint baseline yet" },
            ],
            "readiness": [{
                "model": "coder:14b",
                "readiness": "ready_now",
                "in_use": true,
                "last_activity_ms": 1_700_000_000_000_i64,
                "observed_at_ms":   1_700_000_012_000_i64,
            }],
            "activity_signal": true,
            "history": { "transitions": 412, "persisted": true, "scope": "stored" },
        })
    }

    #[test]
    fn inspect_takes_a_window_in_either_spelling() {
        let Invocation::Run(Command::Inspect { since, json }) = parse(&args(&["inspect"])) else {
            panic!("expected inspect");
        };
        assert_eq!((since, json), (None, false));

        for spelling in [vec!["inspect", "--since", "24h"], vec!["inspect", "--since=24h"]] {
            let Invocation::Run(Command::Inspect { since, .. }) = parse(&args(&spelling)) else {
                panic!("expected inspect");
            };
            assert_eq!(since.as_deref(), Some("24h"), "{spelling:?}");
        }

        let Invocation::Run(Command::Inspect { since, json }) =
            parse(&args(&["inspect", "--json", "--since", "7d"]))
        else {
            panic!("expected inspect");
        };
        assert_eq!((since.as_deref(), json), (Some("7d"), true));
    }

    #[test]
    fn findings_takes_all_and_json() {
        let Invocation::Run(Command::Findings { all, json }) =
            parse(&args(&["findings", "--json"]))
        else {
            panic!("expected findings");
        };
        assert_eq!((all, json), (false, true));

        let Invocation::Run(Command::Findings { all, json }) =
            parse(&args(&["findings", "--all"]))
        else {
            panic!("expected findings");
        };
        assert_eq!((all, json), (true, false));
    }

    #[test]
    fn findings_separates_open_from_resolved() {
        let mut body = inspect_body();
        let mut was = body["findings"][0].clone();
        was["id"] = serde_json::json!("F-b11111");
        was["resolved_at_ms"] = serde_json::json!(1_700_000_500_000_i64);
        body["findings"] = serde_json::json!([body["findings"][0].clone(), was]);
        body["includes_resolved"] = serde_json::json!(true);
        body["persisted"] = serde_json::json!(true);

        let out = render_findings(&body);
        let (open_at, resolved_at) = (
            out.find("F-a3f29c").expect("open finding"),
            out.find("F-b11111").expect("resolved finding"),
        );
        let heading = out.find("RESOLVED").expect("a RESOLVED heading");
        assert!(open_at < heading, "open findings come first: {out}");
        assert!(heading < resolved_at, "the resolved one sits under it: {out}");
    }

    #[test]
    fn findings_distinguishes_not_asked_from_cannot_answer() {
        // Did not ask, and the store is there: say how to ask.
        let mut body = inspect_body();
        body["includes_resolved"] = serde_json::json!(false);
        body["persisted"] = serde_json::json!(true);
        let out = render_findings(&body);
        assert!(out.contains("Add --all"), "{out}");

        // Did not ask, and nothing is stored: say that instead, because --all
        // would not help.
        body["persisted"] = serde_json::json!(false);
        let out = render_findings(&body);
        assert!(out.contains("not being stored"), "{out}");
        assert!(!out.contains("Add --all"), "{out}");

        // Asked, got an answer, and there is nothing in it.
        body["includes_resolved"] = serde_json::json!(true);
        body["persisted"] = serde_json::json!(true);
        let out = render_findings(&body);
        assert!(out.contains("No resolved findings on record."), "{out}");
    }

    #[test]
    fn the_help_lists_every_subcommand_that_exists() {
        let Invocation::Unknown(msg) = parse(&args(&["wat"])) else {
            panic!("expected unknown");
        };
        for cmd in ["wicklee inspect", "wicklee ready", "wicklee findings"] {
            assert!(msg.contains(cmd), "{cmd} is missing from the help: {msg}");
        }
    }

    #[test]
    fn inspect_renders_three_sections_and_keeps_its_evidence_labels() {
        let out = render_inspect(&inspect_body());
        assert!(out.starts_with("WHAT IS HAPPENING\n"), "{out}");
        assert!(out.contains("WHICH MODELS CAN RUN SAFELY NOW"), "{out}");
        assert!(out.contains("F-a3f29c"), "{out}");
        assert!(out.contains("OBSERVED"), "{out}");
        assert!(out.contains("INFERRED"), "{out}");
        assert!(
            out.contains("Not checked: baseline_regression (no fingerprint baseline yet)"),
            "{out}"
        );
        // WHAT TO CHANGE is left out until `verify` exists, rather than
        // printing commands that do not run.
        assert!(!out.contains("WHAT TO CHANGE"), "{out}");
        assert!(!out.contains("wicklee verify"), "{out}");
    }

    #[test]
    fn a_clean_host_says_so_and_still_prints_readiness() {
        let mut body = inspect_body();
        body["findings"] = serde_json::json!([]);
        let out = render_inspect(&body);
        assert!(out.contains("No significant issues found."), "{out}");
        assert!(out.contains("WHICH MODELS CAN RUN SAFELY NOW"), "{out}");
        assert!(out.contains("coder:14b"), "readiness still prints: {out}");
    }

    #[test]
    fn an_unstored_history_is_declared_so_a_short_log_is_not_read_as_a_quiet_host() {
        let mut body = inspect_body();
        body["history"] = serde_json::json!({
            "transitions": 3, "persisted": false, "scope": "this process only",
        });
        let out = render_inspect(&body);
        assert!(out.contains("this agent process only"), "{out}");
        assert!(out.contains("3 transitions"), "{out}");

        // Stored history says nothing, because there is nothing to warn about.
        assert!(!render_inspect(&inspect_body()).contains("this agent process only"));
    }

    #[test]
    fn findings_output_lists_the_open_ones() {
        let mut body = inspect_body();
        body["includes_resolved"] = serde_json::json!(false);
        body["persisted"] = serde_json::json!(true);
        let out = render_findings(&body);
        assert!(out.starts_with("FINDINGS\n"), "{out}");
        assert!(out.contains("F-a3f29c"), "{out}");
        // Nothing resolved was served, so no empty section is printed.
        assert!(!out.contains("RESOLVED"), "{out}");

        body["findings"] = serde_json::json!([]);
        let empty = render_findings(&body);
        assert!(empty.contains("No open findings."), "{empty}");
    }

    #[test]
    fn statement_text_wraps_inside_the_label_columns() {
        let out = render_inspect(&inspect_body());
        let indent = " ".repeat(2 + ID_WIDTH + LABEL_WIDTH);
        let wrapped: Vec<&str> = out.lines().filter(|l| l.starts_with(&indent)).collect();
        assert!(!wrapped.is_empty(), "the long statement must wrap: {out}");
        for line in out.lines() {
            assert!(line.len() <= 2 + ID_WIDTH + LABEL_WIDTH + WRAP_AT, "too wide: {line:?}");
        }
    }

    #[test]
    fn an_spa_response_is_not_mistaken_for_an_answer() {
        // An older agent with no /v1/inspect falls through to the SPA handler,
        // which answers 200 with HTML. serde gives us a string, not an object.
        let html = serde_json::json!("<!doctype html>");
        assert!(!is_inspect_answer(&html));
        assert!(!is_findings_answer(&html));
        assert!(is_inspect_answer(&inspect_body()));
        assert!(is_findings_answer(&inspect_body()));
    }
}
