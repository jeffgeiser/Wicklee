//! Fingerprint — the only part of Phase 1 that sends inference requests.
//!
//! Everything else reads. `inspect` and `ready` answer from polls, receipts
//! other people posted, and the metrics store; none of them touches the
//! runtime. This module loads models, unloads them and sends generates, which
//! makes it the one place where Wicklee can change what the host is doing.
//!
//! That is why the shape here is a plan first and a run second. [`plan`] is a
//! pure function: it decides what the run would do, what it would disturb and
//! roughly how long it would take, and it can refuse — all without sending
//! anything. The operator sees that plan and says yes. Only then does [`run`]
//! send a request. A design that interleaved the two could not show the
//! operator what they were agreeing to.
//!
//! Three rules the protocol does not bend on:
//!
//! - **No user content, ever.** The prompt is generated here, from one fixed
//!   string, at a known token length. A fingerprint is comparable across hosts
//!   only if the prompt is identical on all of them, and a monitor that sends
//!   someone's text to measure a rate has no business doing so.
//! - **`num_ctx` is mandatory and never guessed.** V3 measured that omitting
//!   it reloads the model at the server default: 8192 down to 4096 with a
//!   multi-second reload. A test that did that would destroy the state it was
//!   measuring and corrupt its own first result. An unknown running context
//!   refuses the run rather than picking a number.
//! - **Every request is tagged.** The tracker records these transitions with
//!   [`Cause::Fingerprint`](crate::residency::Cause::Fingerprint), and the
//!   rules ignore that cause. Otherwise one consented measurement would
//!   manufacture the churn finding it was taken to check for.

use serde::Serialize;

use crate::ollama_client::GenerateResponse;
use crate::receipts::{Ambient, Receipt, ReceiptSource, StartState, Stats, receipt_id};
use crate::residency::ModelState;

/// Tokens in the synthetic prompt. Enough that prompt processing is
/// measurable rather than noise, small enough to fit any context a model is
/// loaded at — including the 4096 default, where a longer prompt would change
/// what is being measured.
pub(crate) const PROMPT_TOKENS: usize = 64;

/// Tokens each warm run generates. Fixed, because the generation rate is
/// tokens divided by time and a different count is a different measurement.
pub(crate) const OUTPUT_TOKENS: u64 = 128;

/// Runs per test unless the caller says otherwise. Three is the spec's
/// number and the minimum the fourth evidence rule accepts for a
/// before-and-after claim.
pub(crate) const DEFAULT_RUNS: u8 = 3;

/// Assumed generation rate for the time estimate, when nothing better is
/// known. Deliberately pessimistic: an estimate that runs under is a surprise
/// the operator already consented to, and one that runs over is not.
const ASSUMED_TPS: f64 = 15.0;

/// Assumed load time for a cold run, when nothing better is known.
const ASSUMED_LOAD_S: f64 = 8.0;

/// What a test measures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TestKind {
    /// Three warm runs on a resident model. Prompt-processing rate and
    /// generation rate. Changes nothing but the keep-alive clock.
    DecodeRate,
    /// Unload, load with no prompt, record the load. The expensive one, and
    /// the only one that takes a model away from whoever was using it.
    ColdLoad,
    /// A declared sequence of models, for the churn rule: total wall time and
    /// how many loads it took.
    WorkflowReplay,
}

impl TestKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::DecodeRate => "decode_rate",
            Self::ColdLoad => "cold_load",
            Self::WorkflowReplay => "workflow_replay",
        }
    }

    pub(crate) fn from_name(s: &str) -> Option<Self> {
        match s {
            "decode_rate" => Some(Self::DecodeRate),
            "cold_load" => Some(Self::ColdLoad),
            "workflow_replay" => Some(Self::WorkflowReplay),
            _ => None,
        }
    }

    /// Whether this kind takes a model away from whoever was using it.
    ///
    /// Only the cold test does: it unloads, by definition. A warm test and a
    /// replay send requests to models they name and unload nothing, so a
    /// model being in use is not a reason to refuse them — the first draft
    /// refused a replay of a busy model and told the operator it "will be
    /// unloaded anyway", which was not true of a replay.
    ///
    /// A replay can still displace a model it does not name, by loading
    /// something that does not fit alongside it. That is a headroom question
    /// `readiness` already answers and this plan does not ask yet; it belongs
    /// with step 6, which wires the two together. Until then the consent text
    /// says what the run will do and does not claim to know what else may
    /// move.
    pub(crate) fn unloads_models(self) -> bool {
        matches!(self, Self::ColdLoad)
    }
}

/// What to run. The stored form too: step 6 attaches one of these to a finding
/// so `verify` can re-run exactly the measurement the finding was built from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct TestSpec {
    pub(crate) kind: TestKind,
    pub(crate) models: Vec<String>,
    /// `None` means "whatever the model is running at", resolved by [`plan`]
    /// from `/api/ps`. A caller may pin it, and then a model running at
    /// something else is a refusal rather than a silent reload.
    pub(crate) num_ctx: Option<u64>,
    pub(crate) runs: u8,
}

impl TestSpec {
    /// A warm test at whatever context the models are running at. Only the
    /// tests build a spec this way today — the route assembles one field by
    /// field from the request body — so it is gated rather than left as dead
    /// code in the binary.
    #[cfg(test)]
    pub(crate) fn warm(models: Vec<String>) -> Self {
        Self { kind: TestKind::DecodeRate, models, num_ctx: None, runs: DEFAULT_RUNS }
    }
}

/// The synthetic prompt, at `tokens` tokens.
///
/// One word repeated, because the content is irrelevant and sameness is not:
/// every host must send the identical prompt or the numbers cannot be
/// compared. A token is roughly a word here, which is close enough — the
/// receipt records the runtime's own `prompt_eval_count`, so the real length
/// is measured rather than assumed.
pub(crate) fn synthetic_prompt(tokens: usize) -> String {
    let mut s = String::with_capacity(tokens * 8);
    for i in 0..tokens {
        if i > 0 {
            s.push(' ');
        }
        s.push_str("measure");
    }
    s
}

/// The request body for one run.
///
/// Temperature zero and a fixed seed so two runs differ by the host's
/// behaviour and not by sampling. `num_ctx` is always present — see the module
/// note on V3. `keep_alive` is absent, deliberately: Ollama has no "leave the
/// expiry alone" value, so sending one would overwrite the operator's own
/// `OLLAMA_KEEP_ALIVE` as a side effect of measuring.
pub(crate) fn request_body(model: &str, num_ctx: u64, output_tokens: u64, prompt: &str) -> serde_json::Value {
    serde_json::json!({
        "model":  model,
        "prompt": prompt,
        "stream": false,
        "options": {
            "num_ctx":     num_ctx,
            "num_predict": output_tokens,
            "temperature": 0,
            "seed":        0,
        }
    })
}

/// One model's part of a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct PlanStep {
    pub(crate) model: String,
    pub(crate) num_ctx: u64,
    pub(crate) runs: u8,
    /// Whether the model is unloaded first. True only for a cold test.
    pub(crate) unload_first: bool,
    /// Whether it was resident when the plan was made, and so whether it has
    /// to be loaded again afterwards.
    pub(crate) was_resident: bool,
}

/// What a run would do, shown to the operator before anything is sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Plan {
    pub(crate) kind: TestKind,
    pub(crate) steps: Vec<PlanStep>,
    /// Models that are resident and in use, which this run would disturb.
    /// Non-empty only under `--force`: otherwise it is a refusal.
    pub(crate) disturbs_in_use: Vec<String>,
    /// Models the run will reload afterwards because they were there first.
    pub(crate) will_restore: Vec<String>,
    pub(crate) estimated_s: u64,
    pub(crate) prompt_tokens: usize,
    pub(crate) output_tokens: u64,
}

/// Why a run will not start.
///
/// Every one of these is a refusal rather than a best effort. A fingerprint
/// that guesses a context, or quietly takes a model away from a live caller,
/// produces a number nobody can act on and a problem someone has to debug.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlanRefusal {
    NoModels,
    /// The model is not resident, and a warm test has nothing to measure.
    NotResident(String),
    /// Resident, but `/api/ps` did not say at what context. See the module
    /// note: there is no safe fallback.
    ContextUnknown(String),
    /// The caller pinned a context the model is not running at. Sending it
    /// would reload the model, which is the V3 bug on purpose.
    ContextMismatch { model: String, asked: u64, running: u64 },
    /// In use, and this kind of run would move it.
    InUse { model: String, idle_for_s: i64 },
}

impl PlanRefusal {
    /// The sentence the operator reads. Each one says what to do instead,
    /// because a refusal with no way forward reads as a bug.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::NoModels => "no model given. `wicklee fingerprint <model>`, or a comma-separated list for a sequence".into(),
            Self::NotResident(m) => format!(
                "{m} is not loaded, and a warm test measures a loaded model. Load it, or run \
                 `wicklee fingerprint --cold {m}` to measure the load itself"
            ),
            Self::ContextUnknown(m) => format!(
                "{m} is loaded but this runtime did not report the context it is running at. \
                 Wicklee will not guess: a request at the wrong num_ctx reloads the model at \
                 4096 and destroys what it was measuring. Pass --num-ctx to state it"
            ),
            Self::ContextMismatch { model, asked, running } => format!(
                "{model} is running at {running}, not {asked}. A request at {asked} would reload \
                 it. Drop --num-ctx to measure it as it is, or reload it at {asked} yourself first"
            ),
            Self::InUse { model, idle_for_s } => format!(
                "{model} was used {idle_for_s}s ago and this run would unload it. \
                 Wait until it is idle, or pass --force if you know the caller can take it"
            ),
        }
    }
}

/// How long a model counts as in use after its last observed activity.
///
/// The same minute `readiness` uses, and for the same reason: an inference
/// workload is bursty, so a model idle for ten seconds is between requests
/// rather than finished.
const IN_USE_WINDOW_MS: i64 = 60_000;

/// Decide what a run would do, and whether it may.
///
/// Pure. No I/O, no clock of its own — `now_ms` is passed in — so every
/// refusal and every estimate is reachable from a test with no runtime.
pub(crate) fn plan(
    spec: &TestSpec,
    states: &[&ModelState],
    now_ms: i64,
    force: bool,
) -> Result<Plan, PlanRefusal> {
    if spec.models.is_empty() {
        return Err(PlanRefusal::NoModels);
    }

    let find = |m: &str| states.iter().copied().find(|s| s.model == m);
    let mut steps = Vec::new();
    let mut disturbs = Vec::new();
    let mut restore = Vec::new();
    let mut estimate = 0.0_f64;

    for model in &spec.models {
        let state = find(model);
        let resident = state.is_some_and(|s| s.size_vram_bytes.is_some() || s.context_length.is_some());

        // A warm test has nothing to measure on a model that is not there.
        // A cold test is allowed to start from either state: it unloads first
        // if it has to, and loads from nothing if the model is already gone.
        if !resident && spec.kind == TestKind::DecodeRate {
            return Err(PlanRefusal::NotResident(model.clone()));
        }

        let running = state.and_then(|s| s.context_length);
        let num_ctx = match (spec.num_ctx, running) {
            // The caller pinned it and the model agrees, or the model is not
            // loaded so there is nothing to disagree with.
            (Some(asked), Some(run)) if asked == run => asked,
            (Some(asked), Some(run)) => {
                return Err(PlanRefusal::ContextMismatch { model: model.clone(), asked, running: run });
            }
            (Some(asked), None) => asked,
            (None, Some(run)) => run,
            // Not pinned and not reported. The one case with no safe answer.
            (None, None) => return Err(PlanRefusal::ContextUnknown(model.clone())),
        };

        if spec.kind.unloads_models()
            && let Some(idle_ms) = state
                .and_then(|s| s.last_activity_ms)
                .map(|last| now_ms - last)
                .filter(|idle| *idle < IN_USE_WINDOW_MS)
        {
            if !force {
                return Err(PlanRefusal::InUse {
                    model: model.clone(),
                    idle_for_s: idle_ms / 1_000,
                });
            }
            // Deduplicated: a replay may name one model more than once.
            if !disturbs.contains(model) {
                disturbs.push(model.clone());
            }
        }

        if resident && spec.kind == TestKind::ColdLoad && !restore.contains(model) {
            restore.push(model.clone());
        }

        let runs = spec.runs.max(1);
        estimate += match spec.kind {
            TestKind::ColdLoad => f64::from(runs) * ASSUMED_LOAD_S,
            // A generate is the tokens plus a second of request overhead.
            _ => f64::from(runs) * (OUTPUT_TOKENS as f64 / ASSUMED_TPS + 1.0),
        };

        steps.push(PlanStep {
            model: model.clone(),
            num_ctx,
            runs,
            unload_first: spec.kind == TestKind::ColdLoad && resident,
            was_resident: resident,
        });
    }

    Ok(Plan {
        kind: spec.kind,
        steps,
        disturbs_in_use: disturbs,
        will_restore: restore,
        estimated_s: estimate.ceil() as u64,
        prompt_tokens: PROMPT_TOKENS,
        output_tokens: OUTPUT_TOKENS,
    })
}

impl Plan {
    /// What the operator is agreeing to, in the order it will happen.
    ///
    /// Written out rather than summarised: the point of consent is that the
    /// person saying yes knows which models move and what cannot be put back.
    pub(crate) fn consent_text(&self) -> String {
        let mut out = String::new();
        // "steps", not "models": a replay may name the same model twice, and
        // calling that two models is wrong in the one place the operator is
        // reading carefully.
        out.push_str(&format!(
            "{} test · {} step{} · about {}s\n",
            self.kind.as_str(),
            self.steps.len(),
            if self.steps.len() == 1 { "" } else { "s" },
            self.estimated_s,
        ));
        for s in &self.steps {
            out.push_str(&format!(
                "  {}{} · {} run{} at context {}\n",
                if s.unload_first { "unload then load " } else { "" },
                s.model,
                s.runs,
                if s.runs == 1 { "" } else { "s" },
                s.num_ctx,
            ));
        }
        // What the run will actually send, which is not the same for a cold
        // test — consent text that describes the wrong request is not consent.
        if self.kind == TestKind::ColdLoad {
            out.push_str(
                "  prompt: one token, enough for the runtime to report its own load time\n",
            );
        } else {
            out.push_str(&format!(
                "  prompt: {} synthetic tokens, {} generated, temperature 0, fixed seed\n",
                self.prompt_tokens, self.output_tokens,
            ));
        }
        if !self.disturbs_in_use.is_empty() {
            out.push_str(&format!(
                "  --force: {} in use, and this run unloads it anyway\n",
                self.disturbs_in_use.join(", "),
            ));
        }
        if !self.will_restore.is_empty() {
            // Said before the run, not after, because it is the part the
            // operator cannot undo by declining later.
            out.push_str(&format!(
                "  afterwards: {} reloaded. Its original keep-alive expiry cannot be restored — \
                 the runtime has no way to set one, so it will expire from the end of this run \
                 rather than from whenever it was last used\n",
                self.will_restore.join(", "),
            ));
        }
        out
    }
}

/// One model's measurements.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct ModelResult {
    pub(crate) model: String,
    pub(crate) num_ctx: u64,
    /// `None` when every run failed. An empty range is not zero.
    pub(crate) decode_tps: Option<Stats>,
    pub(crate) prompt_tps: Option<Stats>,
    pub(crate) load_ms: Option<Stats>,
    pub(crate) wall_ms: Option<Stats>,
    pub(crate) receipts: Vec<String>,
    /// Runs that did not come back, and why. Reported rather than dropped: two
    /// successes out of three is a different measurement from three.
    pub(crate) failures: Vec<String>,
}

/// What a run produced.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Outcome {
    pub(crate) test_id: String,
    pub(crate) kind: TestKind,
    pub(crate) results: Vec<ModelResult>,
    /// Models reloaded afterwards, and the warning that goes with it.
    pub(crate) restored: Vec<String>,
    pub(crate) restore_note: Option<String>,
    /// For a sequence: total wall time and how many loads it took.
    pub(crate) total_wall_ms: Option<u64>,
    pub(crate) loads_observed: Option<u32>,
    pub(crate) started_ms: i64,
    pub(crate) finished_ms: i64,
}

/// A test run's id, derived from what it ran rather than from a counter, for
/// the same reason a finding's and a receipt's are.
pub(crate) fn test_id(plan: &Plan, started_ms: i64) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |b: &[u8]| {
        for byte in b.iter().chain(std::iter::once(&0x1f_u8)) {
            h ^= u64::from(*byte);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    eat(plan.kind.as_str().as_bytes());
    for s in &plan.steps {
        eat(s.model.as_bytes());
        eat(&s.num_ctx.to_le_bytes());
    }
    // Two runs of the same plan are two measurements, so unlike a receipt this
    // one does include the clock: step 6 compares a baseline against a later
    // run of the identical plan.
    eat(&started_ms.to_le_bytes());
    format!("T-{:08x}", h & 0xffff_ffff)
}

/// Build a receipt from one test run's response.
pub(crate) fn receipt_from_run(
    resp: &GenerateResponse,
    model: &str,
    num_ctx: u64,
    wall_ms: u64,
    test_id: &str,
    ambient: &Ambient,
) -> Receipt {
    let load_ns = resp.load_duration;
    Receipt {
        // The test id plus the model and this run's own total duration: two
        // runs in one test are two receipts, and a re-run is a new test.
        id: receipt_id(
            ReceiptSource::Fingerprint,
            &format!("{test_id}:{model}:{}", resp.total_duration.unwrap_or(wall_ms * 1_000_000)),
        ),
        ts_ms: ambient.ts_ms,
        source: ReceiptSource::Fingerprint,
        model: model.to_string(),
        digest: ambient.digest.clone(),
        // What the run actually asked for, not what the tracker last polled.
        context_length: Some(num_ctx),
        size_bytes: ambient.size_bytes,
        size_vram_bytes: ambient.size_vram_bytes,
        // V9: a cold start can only ever be ColdUnknown. The page-cache state
        // that would make it reproducible is not readable without unsafe FFI.
        start_state: if load_ns.is_some_and(|ns| ns > 100_000_000) {
            StartState::ColdUnknown
        } else {
            StartState::Loaded
        },
        load_ns,
        prompt_eval_count: resp.prompt_eval_count,
        prompt_eval_cached_count: resp.prompt_eval_cached_count,
        prompt_eval_ns: resp.prompt_eval_duration,
        eval_count: resp.eval_count,
        eval_ns: resp.eval_duration,
        total_ns: resp.total_duration,
        // The one source that has a wall time worth recording: Wicklee sent
        // this request itself, on the same host, so the figure is the
        // request's and not a network hop's.
        wall_ms: Some(wall_ms),
        co_resident: ambient.co_resident.clone(),
        thermal_state: ambient.thermal_state.clone(),
        test_id: Some(test_id.to_string()),
        finding_id: None,
    }
}

/// The client test runs use.
///
/// Its own, not the shared `local_http_client`: that one has a 5 s total
/// timeout, which is right for the short loopback calls it was built for and
/// wrong here. The first live run proved it — a warm run on a 4B model took
/// 4.7 s of wall time and the first of three was cut off at five, reported as
/// a transport failure of the test's own making.
///
/// So: no total timeout at all. A read timeout resets on each chunk and covers
/// a runtime that has actually stopped answering, while a cold load of a large
/// model on a busy host legitimately takes minutes.
fn test_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(600))
            .build()
            .unwrap_or_default()
    })
}

/// One request, and how long Wicklee waited for it.
///
/// The wall time is measured here rather than taken from `total_duration`
/// because the two differ: the runtime's figure excludes the HTTP round trip
/// and, on a cold load, some of what it spent before it started counting. A
/// receipt carries both, so a reader can see the gap instead of trusting one.
async fn one_request(
    client: &reqwest::Client,
    port: u16,
    body: &serde_json::Value,
) -> Result<(GenerateResponse, u64), String> {
    let url = format!("http://127.0.0.1:{port}/api/generate");
    let started = std::time::Instant::now();
    // No total timeout: a cold load of a large model on a busy host legitimately
    // takes minutes, and a test that gave up on it would report a failure that
    // was its own.
    let resp = client
        .post(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("runtime answered HTTP {}", resp.status()));
    }
    let parsed = resp
        .json::<GenerateResponse>()
        .await
        .map_err(|e| format!("response did not parse: {e}"))?;
    Ok((parsed, started.elapsed().as_millis() as u64))
}

/// The cold test's prompt: one space, generating one token.
///
/// **A deviation from the spec, forced by a measurement.** The protocol says
/// to load the model with no prompt and record `load_duration` and wall time.
/// The first half does not work: Ollama 0.40.16 answers a bare load with
/// `{"done": true, "done_reason": "load"}` and no durations at all, so a
/// no-prompt cold test can report nothing but its own wall clock — and wall
/// time alone cannot separate the load from the request around it.
///
/// Measured on the maintainer's M4, same model, back to back:
///
/// | request | load_duration | total | wall |
/// | --- | --- | --- | --- |
/// | bare load | absent | absent | 2862 ms |
/// | one token | 2304 ms | 2401 ms | 2432 ms |
/// | one token | 2307 ms | 2404 ms | 2442 ms |
///
/// One token costs about 100 ms of a 2.3 s load, separable as
/// `total - load`, and buys the runtime's own figure — repeatable to 3 ms
/// across runs where the wall clock is not. So the cold test sends one.
const COLD_PROMPT: &str = " ";

/// Load a model without sending it a prompt, or unload it.
///
/// `keep_alive: 0` is the documented unload. A load is the same call with no
/// `keep_alive` at all, for the reason [`request_body`] gives: Wicklee does
/// not get to decide how long someone else's model stays resident.
fn load_body(model: &str, num_ctx: u64, unload: bool) -> serde_json::Value {
    let mut v = serde_json::json!({
        "model": model,
        "options": { "num_ctx": num_ctx },
    });
    if unload {
        v["keep_alive"] = serde_json::json!(0);
    }
    v
}

/// Wait until the runtime stops listing a model, or give up.
///
/// An unload answers `{"done_reason": "unload"}` immediately, but the runner
/// takes a moment to actually free the weights. The first cold run of two
/// measured 2865.8 ms and the second 1.2 ms: run two's unload had not taken
/// effect when its load went out, so the test timed a warm hit and called it
/// a cold load. A cold measurement that is quietly warm is worse than no cold
/// measurement.
///
/// Polled rather than slept, the way `service.rs` polls for launchctl
/// deregistration: a fixed sleep is either too short on a loaded host or
/// wasted on an idle one, and neither tells the caller whether it worked.
/// Returns false on timeout, and the run records that as a failure instead of
/// reporting the number.
async fn wait_until_absent(client: &reqwest::Client, port: u16, model: &str) -> bool {
    use crate::ollama_client::PsResponse;
    let url = format!("http://127.0.0.1:{port}/api/ps");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let gone = match client.get(&url).timeout(std::time::Duration::from_secs(3)).send().await {
            Ok(r) if r.status().is_success() => match r.json::<PsResponse>().await {
                Ok(ps) => ps.find(model).is_none(),
                // An unreadable /api/ps is not evidence the model is gone.
                Err(_) => false,
            },
            _ => false,
        };
        if gone {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
}

/// Execute a consented plan.
///
/// Consent is the caller's business — by the time this runs, someone has said
/// yes to [`Plan::consent_text`]. What this owes them is that it does what the
/// plan said and nothing else, including putting back what it moved.
///
/// `states` is a snapshot from before the first request. Co-residency is read
/// from it rather than re-polled per run, because a cold test changes what is
/// resident and a receipt should record the host the measurement was taken on,
/// not the host midway through taking it.
pub(crate) async fn run(
    plan: &Plan,
    port: u16,
    states: &[ModelState],
    thermal: Option<String>,
    started_ms: i64,
) -> (Outcome, Vec<Receipt>) {
    let client = test_client();
    let test_id = test_id(plan, started_ms);
    let prompt = synthetic_prompt(plan.prompt_tokens);
    let refs: Vec<&ModelState> = states.iter().collect();
    let mut receipts = Vec::new();
    let mut results: Vec<ModelResult> = Vec::new();
    let mut loads_observed = 0_u32;
    let wall_started = std::time::Instant::now();
    // Whether this kind of run generates enough tokens for a rate to mean
    // anything. Only the cold test does not.
    let rates_are_measurements = plan.kind != TestKind::ColdLoad;

    for step in &plan.steps {
        let mut decode = Vec::new();
        let mut prefill = Vec::new();
        let mut loads = Vec::new();
        let mut walls = Vec::new();
        let mut ids = Vec::new();
        let mut failures = Vec::new();

        for run_index in 0..step.runs {
            // Every cold run unloads first, not just the first one: run two
            // starts from whatever run one's load left resident.
            if plan.kind == TestKind::ColdLoad {
                if let Err(e) = one_request(client, port, &load_body(&step.model, step.num_ctx, true)).await {
                    failures.push(format!("run {}: unload failed: {e}", run_index + 1));
                    continue;
                }
                if !wait_until_absent(client, port, &step.model).await {
                    failures.push(format!(
                        "run {}: {} was still resident 10s after the unload, so this run \
                         would have measured a warm load. Skipped rather than reported",
                        run_index + 1,
                        step.model,
                    ));
                    continue;
                }
            }

            let body = match plan.kind {
                // One token, not none. See COLD_PROMPT for why the spec's
                // no-prompt load does not work on this runtime.
                TestKind::ColdLoad => {
                    request_body(&step.model, step.num_ctx, 1, COLD_PROMPT)
                }
                _ => request_body(&step.model, step.num_ctx, plan.output_tokens, &prompt),
            };

            match one_request(client, port, &body).await {
                Ok((resp, wall_ms)) => {
                    if resp.load_duration.is_some_and(|ns| ns > 100_000_000) {
                        loads_observed += 1;
                    }
                    // A cold run generates one token, to make the runtime
                    // report its load time. One token divided by its own
                    // duration is not a rate: the first live run of this
                    // printed "1000000.0 tok/s", which is a microsecond of
                    // eval time presented as a measurement. The receipt keeps
                    // the raw counts either way; what is suppressed is the
                    // derived rate, which is the part that reads as a claim.
                    if rates_are_measurements {
                        if let Some(t) = resp.eval_tps() {
                            decode.push(f64::from(t));
                        }
                        if let Some(t) = resp.prompt_eval_tps() {
                            prefill.push(f64::from(t));
                        }
                    }
                    if let Some(ms) = resp.load_ms() {
                        loads.push(f64::from(ms));
                    }
                    walls.push(wall_ms as f64);

                    let mut ambient = crate::receipts::ambient_from_states(
                        &step.model,
                        &refs,
                        crate::residency::now_ms(),
                    );
                    ambient.thermal_state = thermal.clone();
                    let receipt = receipt_from_run(&resp, &step.model, step.num_ctx, wall_ms, &test_id, &ambient);
                    ids.push(receipt.id.clone());
                    receipts.push(receipt);
                }
                Err(e) => failures.push(format!("run {}: {e}", run_index + 1)),
            }
        }

        results.push(ModelResult {
            model: step.model.clone(),
            num_ctx: step.num_ctx,
            decode_tps: Stats::of(&decode),
            prompt_tps: Stats::of(&prefill),
            load_ms: Stats::of(&loads),
            wall_ms: Stats::of(&walls),
            receipts: ids,
            failures,
        });
    }

    // Put back what was taken. Best effort by necessity: if the reload fails
    // the model is simply absent, which the operator can see, and failing the
    // whole run over it would discard measurements that are already good.
    let mut restored = Vec::new();
    for model in &plan.will_restore {
        let ctx = plan
            .steps
            .iter()
            .find(|s| &s.model == model)
            .map(|s| s.num_ctx)
            .unwrap_or_default();
        match one_request(client, port, &load_body(model, ctx, false)).await {
            Ok(_) => restored.push(model.clone()),
            Err(e) => eprintln!("[fingerprint] {model} could not be reloaded after the run: {e}"),
        }
    }

    (
        Outcome {
            test_id,
            kind: plan.kind,
            results,
            restore_note: (!restored.is_empty()).then(|| RESTORE_NOTE.to_string()),
            restored,
            // Only a sequence is asking about the whole run; for the other two
            // the per-model wall range above is the answer, and one total
            // would invite comparing runs of different lengths.
            total_wall_ms: (plan.kind == TestKind::WorkflowReplay)
                .then(|| wall_started.elapsed().as_millis() as u64),
            loads_observed: (plan.kind == TestKind::WorkflowReplay).then_some(loads_observed),
            started_ms,
            finished_ms: crate::residency::now_ms(),
        },
        receipts,
    )
}

/// The sentence that goes with every restore. Stated once, here, because it
/// is the one thing a fingerprint cannot put back.
pub(crate) const RESTORE_NOTE: &str =
    "reloaded after the run. The original keep-alive expiry could not be restored: the runtime \
     accepts a new keep_alive but has no way to set a previous one, so these models will expire \
     from the end of this run rather than from when they were last used.";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::residency::{ModelState, Residency};

    const T0: i64 = 1_700_000_000_000;

    fn state(model: &str, residency: Residency) -> ModelState {
        ModelState {
            model: model.to_string(),
            digest: None,
            residency,
            size_bytes: None,
            size_vram_bytes: None,
            context_length: None,
            expires_at_ms: None,
            last_activity_ms: None,
            installed_size_bytes: None,
            measured: None,
            observed_at_ms: T0,
        }
    }

    fn loaded(model: &str, ctx: Option<u64>, activity: Option<i64>) -> ModelState {
        ModelState {
            context_length: ctx,
            size_vram_bytes: Some(4_000_000_000),
            last_activity_ms: activity,
            ..state(model, Residency::Loaded)
        }
    }

    fn not_loaded(model: &str) -> ModelState {
        state(model, Residency::NotLoaded)
    }

    #[test]
    fn the_prompt_is_fixed_and_carries_no_content() {
        let p = synthetic_prompt(PROMPT_TOKENS);
        assert_eq!(p.split_whitespace().count(), PROMPT_TOKENS);
        // Identical on every host, or the numbers are not comparable.
        assert_eq!(p, synthetic_prompt(PROMPT_TOKENS));
        assert!(p.split_whitespace().all(|w| w == "measure"));
    }

    #[test]
    fn a_request_always_states_the_context_and_never_samples() {
        let body = request_body("coder:14b", 8192, 128, "measure");
        assert_eq!(body["options"]["num_ctx"], 8192);
        assert_eq!(body["options"]["temperature"], 0);
        assert_eq!(body["options"]["seed"], 0);
        assert_eq!(body["options"]["num_predict"], 128);
        assert_eq!(body["stream"], false);
        // Sending keep_alive would overwrite the operator's OLLAMA_KEEP_ALIVE
        // as a side effect of measuring.
        assert!(body.get("keep_alive").is_none());
    }

    #[test]
    fn a_warm_test_plans_at_the_context_the_model_is_running_at() {
        let s = loaded("coder:14b", Some(8192), None);
        let p = plan(&TestSpec::warm(vec!["coder:14b".into()]), &[&s], T0, false).unwrap();
        assert_eq!(p.steps.len(), 1);
        assert_eq!(p.steps[0].num_ctx, 8192, "the running context, not a default");
        assert_eq!(p.steps[0].runs, DEFAULT_RUNS);
        assert!(!p.steps[0].unload_first);
        assert!(p.will_restore.is_empty(), "a warm test moves nothing");
        assert!(p.estimated_s > 0);
        assert!(p.consent_text().contains("context 8192"));
    }

    #[test]
    fn an_unknown_running_context_refuses_rather_than_guessing() {
        let s = loaded("coder:14b", None, None);
        let err = plan(&TestSpec::warm(vec!["coder:14b".into()]), &[&s], T0, false).unwrap_err();
        assert_eq!(err, PlanRefusal::ContextUnknown("coder:14b".into()));
        // The refusal has to say why, because "it refused" reads as a bug.
        assert!(err.message().contains("4096"), "{}", err.message());
        assert!(err.message().contains("--num-ctx"));

        // Stating it explicitly is the way through.
        let spec = TestSpec { num_ctx: Some(8192), ..TestSpec::warm(vec!["coder:14b".into()]) };
        assert_eq!(plan(&spec, &[&s], T0, false).unwrap().steps[0].num_ctx, 8192);
    }

    #[test]
    fn a_pinned_context_the_model_is_not_running_at_is_a_refusal() {
        let s = loaded("coder:14b", Some(8192), None);
        let spec = TestSpec { num_ctx: Some(4096), ..TestSpec::warm(vec!["coder:14b".into()]) };
        assert_eq!(
            plan(&spec, &[&s], T0, false).unwrap_err(),
            PlanRefusal::ContextMismatch { model: "coder:14b".into(), asked: 4096, running: 8192 },
        );
    }

    #[test]
    fn a_warm_test_needs_the_model_loaded_and_a_cold_one_does_not() {
        let s = not_loaded("coder:14b");
        assert_eq!(
            plan(&TestSpec::warm(vec!["coder:14b".into()]), &[&s], T0, false).unwrap_err(),
            PlanRefusal::NotResident("coder:14b".into()),
        );

        let cold = TestSpec {
            kind: TestKind::ColdLoad,
            num_ctx: Some(8192),
            ..TestSpec::warm(vec!["coder:14b".into()])
        };
        let p = plan(&cold, &[&s], T0, false).unwrap();
        assert!(!p.steps[0].unload_first, "nothing to unload");
        assert!(p.will_restore.is_empty(), "it was not there to put back");
    }

    #[test]
    fn a_cold_test_on_a_model_in_use_refuses_unless_forced() {
        let s = loaded("coder:14b", Some(8192), Some(T0 - 12_000));
        let cold = TestSpec { kind: TestKind::ColdLoad, ..TestSpec::warm(vec!["coder:14b".into()]) };

        let err = plan(&cold, &[&s], T0, false).unwrap_err();
        assert_eq!(err, PlanRefusal::InUse { model: "coder:14b".into(), idle_for_s: 12 });
        assert!(err.message().contains("--force"));

        let forced = plan(&cold, &[&s], T0, true).unwrap();
        assert_eq!(forced.disturbs_in_use, vec!["coder:14b".to_string()]);
        assert!(forced.steps[0].unload_first);
        assert_eq!(forced.will_restore, vec!["coder:14b".to_string()]);
        let text = forced.consent_text();
        assert!(text.contains("--force"), "{text}");
        // The irreversible part is stated before the run, not after.
        assert!(text.contains("expiry cannot be restored"), "{text}");

        // A warm test does not move it, so being in use is not a refusal.
        let warm = plan(&TestSpec::warm(vec!["coder:14b".into()]), &[&s], T0, false).unwrap();
        assert!(warm.disturbs_in_use.is_empty());

        // And once it has been idle a while, the cold test may run.
        let idle = loaded("coder:14b", Some(8192), Some(T0 - 300_000));
        assert!(plan(&cold, &[&idle], T0, false).is_ok());
    }

    #[test]
    fn a_replay_of_a_busy_model_is_not_refused_and_names_it_once() {
        // The first draft refused this and said the model "will be unloaded
        // anyway". A replay unloads nothing; it sends requests to models it
        // names, exactly as a warm test does.
        let s = loaded("a:7b", Some(4096), Some(T0 - 3_000));
        let spec = TestSpec {
            kind: TestKind::WorkflowReplay,
            models: vec!["a:7b".into(), "a:7b".into()],
            num_ctx: None,
            runs: 1,
        };
        let p = plan(&spec, &[&s], T0, false).unwrap();
        assert!(p.disturbs_in_use.is_empty());
        assert!(p.will_restore.is_empty(), "a replay takes nothing away");
        assert_eq!(p.steps.len(), 2, "both steps, named model repeated");
        // And the header counts steps, not models.
        assert!(p.consent_text().contains("2 steps"), "{}", p.consent_text());

        // A cold test naming it twice disturbs and restores it once.
        let cold = TestSpec { kind: TestKind::ColdLoad, ..spec };
        let forced = plan(&cold, &[&s], T0, true).unwrap();
        assert_eq!(forced.disturbs_in_use, vec!["a:7b".to_string()]);
        assert_eq!(forced.will_restore, vec!["a:7b".to_string()]);
    }

    #[test]
    fn a_sequence_plans_every_model_in_order() {
        let a = loaded("a:7b", Some(4096), None);
        let b = loaded("b:14b", Some(8192), None);
        let spec = TestSpec {
            kind: TestKind::WorkflowReplay,
            models: vec!["a:7b".into(), "b:14b".into(), "a:7b".into()],
            num_ctx: None,
            runs: 1,
        };
        let p = plan(&spec, &[&a, &b], T0, false).unwrap();
        assert_eq!(
            p.steps.iter().map(|s| s.model.as_str()).collect::<Vec<_>>(),
            vec!["a:7b", "b:14b", "a:7b"],
            "the declared order, repeats included",
        );
        assert_eq!(p.steps[1].num_ctx, 8192, "each at its own context");

        assert_eq!(plan(&TestSpec::warm(vec![]), &[], T0, false).unwrap_err(), PlanRefusal::NoModels);
    }

    #[test]
    fn a_receipt_from_a_run_records_the_context_asked_for_and_a_wall_time() {
        let resp = GenerateResponse {
            model: Some("coder:14b".into()),
            done: Some(true),
            done_reason: Some("stop".into()),
            total_duration: Some(8_113_331_500),
            load_duration: Some(6_396_458),
            prompt_eval_count: Some(64),
            prompt_eval_cached_count: Some(0),
            prompt_eval_duration: Some(130_079_000),
            eval_count: Some(128),
            eval_duration: Some(4_868_000_000),
        };
        let ambient = Ambient { ts_ms: T0, ..Default::default() };
        let r = receipt_from_run(&resp, "coder:14b", 8192, 8_120, "T-abc", &ambient);

        assert_eq!(r.source, ReceiptSource::Fingerprint);
        assert_eq!(r.context_length, Some(8192));
        assert_eq!(r.test_id.as_deref(), Some("T-abc"));
        assert_eq!(r.wall_ms, Some(8_120), "Wicklee timed this one itself");
        assert_eq!(r.start_state, StartState::Loaded);
        assert!((r.decode_tps().unwrap() - 26.3).abs() < 0.1);

        // Two runs in one test are two receipts.
        let mut second = resp.clone();
        second.total_duration = Some(8_120_000_000);
        assert_ne!(
            receipt_from_run(&second, "coder:14b", 8192, 8_127, "T-abc", &ambient).id,
            r.id,
        );
    }

    #[test]
    fn test_ids_distinguish_two_runs_of_the_same_plan() {
        let s = loaded("coder:14b", Some(8192), None);
        let p = plan(&TestSpec::warm(vec!["coder:14b".into()]), &[&s], T0, false).unwrap();
        assert_eq!(test_id(&p, T0), test_id(&p, T0));
        assert_ne!(
            test_id(&p, T0),
            test_id(&p, T0 + 1),
            "step 6 compares a baseline against a later run of the identical plan",
        );
    }

    #[test]
    fn names_survive_a_round_trip() {
        for k in [TestKind::DecodeRate, TestKind::ColdLoad, TestKind::WorkflowReplay] {
            assert_eq!(TestKind::from_name(k.as_str()), Some(k));
        }
        assert_eq!(TestKind::from_name("vibes"), None);
        // Only the cold test unloads. A replay sends requests to models it
        // names and takes nothing away from anyone.
        assert!(!TestKind::DecodeRate.unloads_models());
        assert!(TestKind::ColdLoad.unloads_models());
        assert!(!TestKind::WorkflowReplay.unloads_models());
    }
}
