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

#![cfg_attr(target_env = "musl", allow(dead_code))]

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

/// The test a finding's `verify` runs.
///
/// A warm decode-rate run on the models the finding names. Derived rather
/// than stored: the spec gives `Finding` a `test: Option<TestSpec>` field,
/// and every Phase 1 rule would set it to exactly this, so the field would
/// carry no information and every new rule would have to remember to fill it
/// in. A function cannot be forgotten.
///
/// Decode rate for every rule, including the ones about loading and
/// unloading, because the question `verify` answers is always the same one:
/// the operator changed something, and does inference actually run faster
/// now. A cold test would measure the load rather than the change.
pub(crate) fn test_for(models: &[String]) -> TestSpec {
    TestSpec {
        kind: TestKind::DecodeRate,
        models: models.to_vec(),
        num_ctx: None,
        runs: DEFAULT_RUNS,
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

        if !resident && spec.kind == TestKind::DecodeRate {
            return Err(PlanRefusal::NotResident(model.clone()));
        }

        let running = state.and_then(|s| s.context_length);
        let num_ctx = match (spec.num_ctx, running) {
            (Some(asked), Some(run)) if asked == run => asked,
            (Some(asked), Some(run)) => {
                return Err(PlanRefusal::ContextMismatch { model: model.clone(), asked, running: run });
            }
            (Some(asked), None) => asked,
            (None, Some(run)) => run,
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
        id: receipt_id(
            ReceiptSource::Fingerprint,
            &format!("{test_id}:{model}:{}", resp.total_duration.unwrap_or(wall_ms * 1_000_000)),
        ),
        ts_ms: ambient.ts_ms,
        source: ReceiptSource::Fingerprint,
        model: model.to_string(),
        digest: ambient.digest.clone(),
        context_length: Some(num_ctx),
        size_bytes: ambient.size_bytes,
        size_vram_bytes: ambient.size_vram_bytes,
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
    let rates_are_measurements = plan.kind != TestKind::ColdLoad;

    for step in &plan.steps {
        let mut decode = Vec::new();
        let mut prefill = Vec::new();
        let mut loads = Vec::new();
        let mut walls = Vec::new();
        let mut ids = Vec::new();
        let mut failures = Vec::new();

        for run_index in 0..step.runs {
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
            total_wall_ms: (plan.kind == TestKind::WorkflowReplay)
                .then(|| wall_started.elapsed().as_millis() as u64),
            loads_observed: (plan.kind == TestKind::WorkflowReplay).then_some(loads_observed),
            started_ms,
            finished_ms: crate::residency::now_ms(),
        },
        receipts,
    )
}

/// One stored run of a finding's test.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct VerifyRun {
    pub(crate) id: String,
    pub(crate) finding_id: String,
    pub(crate) ts_ms: i64,
    /// Every model's state when the run started. The whole snapshot, not the
    /// tested model's: the point of verify is to explain a difference, and the
    /// explanation is usually something else that was loaded.
    pub(crate) config: Vec<ModelState>,
    pub(crate) models: Vec<String>,
    pub(crate) receipts: Vec<String>,
    pub(crate) median: f64,
    pub(crate) low: f64,
    pub(crate) high: f64,
}

/// What two runs say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Verdict {
    Improved,
    /// The honest answer when the ranges overlap, or when a side has fewer
    /// than three receipts. Not "unchanged": the change may be real and too
    /// small for three runs to resolve, which is a different claim.
    NoMeasurableChange,
    Worse,
}

impl Verdict {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Improved => "improved",
            Self::NoMeasurableChange => "no measurable change",
            Self::Worse => "worse",
        }
    }
}

/// Two runs, side by side.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Comparison {
    pub(crate) verdict: Verdict,
    pub(crate) baseline_id: String,
    pub(crate) current_id: String,
    pub(crate) baseline_median: f64,
    pub(crate) current_median: f64,
    /// Signed, as a percentage of the baseline. Reported alongside the ranges
    /// rather than instead of them: a 30% figure between two overlapping
    /// ranges is not a 30% improvement, and the verdict says so.
    pub(crate) change_pct: f64,
    /// What differed in the configuration between the two runs. Empty means
    /// nothing Wicklee can see differed, which is itself worth printing — a
    /// difference with no visible cause is where someone should look next.
    pub(crate) config_changes: Vec<String>,
    /// Why the verdict is `NoMeasurableChange`, when it is. `None` for a
    /// verdict that was measurable.
    pub(crate) not_measurable_because: Option<String>,
}

/// How far apart two medians must be before a non-overlap means anything.
///
/// **The fourth evidence rule is necessary and was not sufficient.** It says
/// improved or worse only when the ranges do not overlap, and the first live
/// pair of runs — same host, same model, nothing changed between them —
/// reported "worse" at 1.5%: 27.7-27.9 tok/s against 26.6-27.5, adjacent
/// bands that happen not to touch. Three tight runs land in two disjoint
/// narrow bands easily, and a 1.5% verdict sends someone looking for a cause
/// that is not there.
///
/// Five percent, which is a starting value like the spec's other thresholds.
/// It is set from that one observation with room over it: the measured noise
/// floor for three runs on an idle host was 1.5%, and this leaves roughly
/// threefold headroom. If a quieter or busier host shows a different floor,
/// this is the one place to change.
const MIN_MEASURABLE_PCT: f64 = 5.0;

/// Compare two runs of the same test.
///
/// Pure, and the fourth evidence rule lives here, plus the floor the live runs
/// showed it needs: improved or worse only when both sides have at least three
/// receipts, the ranges do not overlap, and the medians differ by at least
/// [`MIN_MEASURABLE_PCT`]. Everything else is no measurable change, with the
/// reason said out loud.
pub(crate) fn compare(baseline: &VerifyRun, current: &VerifyRun) -> Comparison {
    let change_pct = if baseline.median > 0.0 {
        (current.median - baseline.median) / baseline.median * 100.0
    } else {
        0.0
    };

    let thin = [("baseline", baseline), ("current", current)]
        .into_iter()
        .find(|(_, r)| r.receipts.len() < crate::findings::MIN_RECEIPTS_PER_SIDE);

    let (verdict, why) = if let Some((side, run)) = thin {
        (
            Verdict::NoMeasurableChange,
            Some(format!(
                "the {side} run has {} receipt{}, and a range needs three",
                run.receipts.len(),
                if run.receipts.len() == 1 { "" } else { "s" },
            )),
        )
    } else {
        let b = Stats {
            median: baseline.median,
            low: baseline.low,
            high: baseline.high,
            n: baseline.receipts.len(),
        };
        let c = Stats {
            median: current.median,
            low: current.low,
            high: current.high,
            n: current.receipts.len(),
        };
        if b.overlaps(&c) {
            (
                Verdict::NoMeasurableChange,
                Some(format!(
                    "the ranges overlap: {:.1}-{:.1} against {:.1}-{:.1} tok/s",
                    b.low, b.high, c.low, c.high,
                )),
            )
        } else if change_pct.abs() < MIN_MEASURABLE_PCT {
            (
                Verdict::NoMeasurableChange,
                Some(format!(
                    "{:.1}% is under the {MIN_MEASURABLE_PCT:.0}% a run of three can resolve, even though the ranges happen not to overlap",
                    change_pct.abs(),
                )),
            )
        } else if current.median > baseline.median {
            (Verdict::Improved, None)
        } else {
            (Verdict::Worse, None)
        }
    };

    Comparison {
        verdict,
        baseline_id: baseline.id.clone(),
        current_id: current.id.clone(),
        baseline_median: baseline.median,
        current_median: current.median,
        change_pct,
        config_changes: config_diff(&baseline.config, &current.config),
        not_measurable_because: why,
    }
}

/// What changed between two configuration snapshots.
///
/// Three things, because they are what the spec names as explanations for a
/// regression and what `/api/ps` can actually report: the context a model is
/// running at, whether its footprint is split outside accelerator memory, and
/// what else was loaded alongside it.
///
/// Written as sentences rather than a diff structure because the only consumer
/// is a person reading two runs side by side, and a structured diff of
/// `ModelState` would mostly be fields that always differ, such as
/// `observed_at_ms`.
pub(crate) fn config_diff(before: &[ModelState], after: &[ModelState]) -> Vec<String> {
    let mut out = Vec::new();
    fn loaded_names(v: &[ModelState]) -> Vec<&str> {
        let mut n: Vec<&str> = v
            .iter()
            .filter(|s| s.context_length.is_some() || s.size_vram_bytes.is_some())
            .map(|s| s.model.as_str())
            .collect();
        n.sort_unstable();
        n
    }
    let is_split = |s: &ModelState| {
        matches!((s.size_bytes, s.size_vram_bytes), (Some(t), Some(v)) if v < t)
    };

    for a in after {
        let Some(b) = before.iter().find(|b| b.model == a.model) else {
            continue;
        };
        if let (Some(x), Some(y)) = (b.context_length, a.context_length)
            && x != y
        {
            out.push(format!("{}: context {x} to {y}", a.model));
        }
        if is_split(b) != is_split(a) {
            out.push(format!(
                "{}: {} accelerator memory",
                a.model,
                if is_split(a) { "part of it moved outside" } else { "all of it moved into" },
            ));
        }
    }

    let (b_names, a_names) = (loaded_names(before), loaded_names(after));
    let gone: Vec<&str> = b_names.iter().copied().filter(|m| !a_names.contains(m)).collect();
    let arrived: Vec<&str> = a_names.iter().copied().filter(|m| !b_names.contains(m)).collect();
    if !gone.is_empty() {
        out.push(format!("no longer loaded: {}", gone.join(", ")));
    }
    if !arrived.is_empty() {
        out.push(format!("also loaded: {}", arrived.join(", ")));
    }
    out
}

/// A verify run's id.
pub(crate) fn verify_run_id(finding_id: &str, ts_ms: i64) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in [finding_id.as_bytes(), &ts_ms.to_le_bytes()[..]] {
        for b in part.iter().chain(std::iter::once(&0x1f_u8)) {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("V-{:08x}", h & 0xffff_ffff)
}

/// Turn a finished run into a stored verify run.
///
/// The median and range are the generation rate, which is what every rule with
/// a test attached measures. A run whose receipts carry no rate — a cold test —
/// has nothing to compare, and gets zeros with no receipts rather than a
/// fabricated number. `compare` then reports no measurable change and says so.
pub(crate) fn verify_run_from(
    finding_id: &str,
    outcome: &Outcome,
    receipts: &[Receipt],
    config: Vec<ModelState>,
) -> VerifyRun {
    let rates: Vec<f64> = receipts.iter().filter_map(Receipt::decode_tps).collect();
    let stats = Stats::of(&rates);
    VerifyRun {
        id: verify_run_id(finding_id, outcome.started_ms),
        finding_id: finding_id.to_string(),
        ts_ms: outcome.started_ms,
        config,
        models: outcome.results.iter().map(|r| r.model.clone()).collect(),
        receipts: receipts
            .iter()
            .filter(|r| r.decode_tps().is_some())
            .map(|r| r.id.clone())
            .collect(),
        median: stats.map_or(0.0, |s| s.median),
        low: stats.map_or(0.0, |s| s.low),
        high: stats.map_or(0.0, |s| s.high),
    }
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
    use crate::receipts::{ReceiptSource, StartState};
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

    fn run(id_suffix: i64, receipts: usize, median: f64, low: f64, high: f64) -> VerifyRun {
        VerifyRun {
            id: format!("V-{id_suffix:08x}"),
            finding_id: "F-abc123".into(),
            ts_ms: T0 + id_suffix,
            config: Vec::new(),
            models: vec!["coder:14b".into()],
            receipts: (0..receipts).map(|i| format!("R-{i}")).collect(),
            median,
            low,
            high,
        }
    }

    #[test]
    fn two_runs_whose_ranges_do_not_overlap_are_improved_or_worse() {
        let baseline = run(1, 3, 20.0, 19.8, 20.2);
        let faster = run(2, 3, 27.5, 27.4, 27.6);
        let c = compare(&baseline, &faster);
        assert_eq!(c.verdict, Verdict::Improved);
        assert!(c.not_measurable_because.is_none());
        assert!((c.change_pct - 37.5).abs() < 0.1, "{}", c.change_pct);

        let slower = run(3, 3, 14.0, 13.9, 14.1);
        assert_eq!(compare(&baseline, &slower).verdict, Verdict::Worse);
    }

    #[test]
    fn a_tiny_difference_is_no_measurable_change_even_without_an_overlap() {
        let baseline = run(1, 3, 27.9, 27.7, 27.9);
        let current = run(2, 3, 27.4, 26.6, 27.5);
        let c = compare(&baseline, &current);
        assert_eq!(c.verdict, Verdict::NoMeasurableChange);
        let why = c.not_measurable_because.expect("a reason");
        assert!(why.contains("1.8%"), "{why}");
        assert!(why.contains("not to overlap"), "{why}");

        let clear = run(3, 3, 24.0, 23.8, 24.2);
        assert_eq!(compare(&baseline, &clear).verdict, Verdict::Worse);
    }

    #[test]
    fn overlapping_ranges_are_no_measurable_change_and_say_why() {
        let baseline = run(1, 3, 20.0, 18.0, 22.0);
        let current = run(2, 3, 22.4, 21.0, 24.0);
        let c = compare(&baseline, &current);
        assert_eq!(c.verdict, Verdict::NoMeasurableChange);
        assert!((c.change_pct - 12.0).abs() < 0.1, "the delta is still reported");
        let why = c.not_measurable_because.expect("a reason");
        assert!(why.contains("overlap"), "{why}");
        assert!(why.contains("18.0-22.0"), "{why}");
    }

    #[test]
    fn fewer_than_three_receipts_a_side_is_never_a_verdict() {
        let thin = run(1, 2, 20.0, 19.9, 20.1);
        let full = run(2, 3, 40.0, 39.0, 41.0);
        let c = compare(&thin, &full);
        assert_eq!(c.verdict, Verdict::NoMeasurableChange, "even at double the rate");
        assert!(c.not_measurable_because.unwrap().contains("baseline run has 2 receipts"));

        let c = compare(&full, &thin);
        assert!(c.not_measurable_because.unwrap().contains("current run has 2 receipts"));

        assert_eq!(
            crate::findings::Statement::verified_change("faster", &thin, &full),
            Err(crate::findings::EvidenceError::TooFewReceipts { side: "baseline", had: 2 }),
        );
        assert!(crate::findings::Statement::verified_change("faster", &full, &run(3, 3, 1.0, 1.0, 1.0)).is_ok());
    }

    #[test]
    fn a_config_diff_names_the_three_things_ps_can_report() {
        let before = vec![
            loaded("coder:14b", Some(8192), None),
            loaded("helper:3b", Some(4096), None),
        ];
        let mut after_model = loaded("coder:14b", Some(4096), None);
        after_model.size_bytes = Some(8_000_000_000);
        after_model.size_vram_bytes = Some(4_000_000_000);
        let after = vec![after_model, loaded("other:7b", Some(2048), None)];

        let d = config_diff(&before, &after);
        assert!(d.iter().any(|s| s == "coder:14b: context 8192 to 4096"), "{d:?}");
        assert!(
            d.iter().any(|s| s.contains("part of it moved outside")),
            "{d:?}",
        );
        assert!(d.iter().any(|s| s == "no longer loaded: helper:3b"), "{d:?}");
        assert!(d.iter().any(|s| s == "also loaded: other:7b"), "{d:?}");

        assert!(config_diff(&before, &before).is_empty());
    }

    #[test]
    fn a_verify_run_takes_its_rate_from_the_receipts_that_have_one() {
        let outcome = Outcome {
            test_id: "T-1".into(),
            kind: TestKind::DecodeRate,
            results: vec![ModelResult {
                model: "coder:14b".into(),
                num_ctx: 8192,
                decode_tps: None,
                prompt_tps: None,
                load_ms: None,
                wall_ms: None,
                receipts: Vec::new(),
                failures: Vec::new(),
            }],
            restored: Vec::new(),
            restore_note: None,
            total_wall_ms: None,
            loads_observed: None,
            started_ms: T0,
            finished_ms: T0 + 15_000,
        };
        let rate = |eval_ns: u64| crate::receipts::Receipt {
            id: format!("R-{eval_ns}"),
            ts_ms: T0,
            source: ReceiptSource::Fingerprint,
            model: "coder:14b".into(),
            digest: None,
            context_length: Some(8192),
            size_bytes: None,
            size_vram_bytes: None,
            start_state: StartState::Loaded,
            load_ns: None,
            prompt_eval_count: None,
            prompt_eval_cached_count: None,
            prompt_eval_ns: None,
            eval_count: Some(100),
            eval_ns: Some(eval_ns),
            total_ns: None,
            wall_ms: None,
            co_resident: Vec::new(),
            thermal_state: None,
            test_id: Some("T-1".into()),
            finding_id: None,
        };
        let mut rateless = rate(0);
        rateless.id = "R-none".into();
        rateless.eval_ns = None;
        let receipts = vec![rate(4_000_000_000), rate(5_000_000_000), rate(10_000_000_000), rateless.clone()];

        let v = verify_run_from("F-abc123", &outcome, &receipts, Vec::new());
        assert_eq!(v.finding_id, "F-abc123");
        assert_eq!(v.ts_ms, T0, "the run's start, not its end");
        assert_eq!(v.receipts.len(), 3, "the rateless one is not cited");
        assert!((v.median - 20.0).abs() < 1e-9);
        assert!((v.low - 10.0).abs() < 1e-9);
        assert!((v.high - 25.0).abs() < 1e-9);

        let empty = verify_run_from("F-abc123", &outcome, &[rateless], Vec::new());
        assert!(empty.receipts.is_empty());
        assert_eq!(empty.median, 0.0);
        assert_eq!(compare(&empty, &v).verdict, Verdict::NoMeasurableChange);
    }

    #[test]
    fn the_test_a_finding_verifies_is_warm_and_unpinned() {
        let spec = test_for(&["coder:14b".to_string(), "helper:3b".to_string()]);
        assert_eq!(spec.kind, TestKind::DecodeRate, "a cold test would measure the load");
        assert_eq!(spec.runs, DEFAULT_RUNS);
        assert_eq!(spec.num_ctx, None, "measured as the host has it");
        assert_eq!(spec.models.len(), 2);
    }

    #[test]
    fn a_verify_run_id_is_stable_per_finding_and_start() {
        assert_eq!(verify_run_id("F-abc123", T0), verify_run_id("F-abc123", T0));
        assert_ne!(verify_run_id("F-abc123", T0), verify_run_id("F-abc123", T0 + 1));
        assert_ne!(verify_run_id("F-abc123", T0), verify_run_id("F-def456", T0));
    }

    #[test]
    fn the_prompt_is_fixed_and_carries_no_content() {
        let p = synthetic_prompt(PROMPT_TOKENS);
        assert_eq!(p.split_whitespace().count(), PROMPT_TOKENS);
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
        assert!(err.message().contains("4096"), "{}", err.message());
        assert!(err.message().contains("--num-ctx"));

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
        assert!(text.contains("expiry cannot be restored"), "{text}");

        let warm = plan(&TestSpec::warm(vec!["coder:14b".into()]), &[&s], T0, false).unwrap();
        assert!(warm.disturbs_in_use.is_empty());

        let idle = loaded("coder:14b", Some(8192), Some(T0 - 300_000));
        assert!(plan(&cold, &[&idle], T0, false).is_ok());
    }

    #[test]
    fn a_replay_of_a_busy_model_is_not_refused_and_names_it_once() {
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
        assert!(p.consent_text().contains("2 steps"), "{}", p.consent_text());

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
        assert!(!TestKind::DecodeRate.unloads_models());
        assert!(TestKind::ColdLoad.unloads_models());
        assert!(!TestKind::WorkflowReplay.unloads_models());
    }
}
