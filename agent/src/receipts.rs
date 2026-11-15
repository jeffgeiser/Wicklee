//! Receipts — one exact measurement of one request.
//!
//! Everything else in Phase 1 is sampled. The metrics store writes a frame a
//! second and the rules read averages over a window, which is enough to say a
//! node is slow and never enough to say by how much: a 1 Hz sample of a
//! 300 ms request is a coin toss. A receipt is the runtime's own final-response
//! metadata, so the numbers in it are the request's, not an interval's.
//!
//! Three sources, in the order they are worth having:
//!
//! - [`ReceiptSource::Callback`] — the caller posts the response object it
//!   already has. Nothing is loaded, nothing is intercepted, and on a default
//!   macOS install it is the only path that works at all, because the proxy
//!   cannot bind 11434 while Ollama holds it.
//! - [`ReceiptSource::Proxy`] — taken from the final packet of a proxied
//!   request. Exact, but needs the port.
//! - [`ReceiptSource::Fingerprint`] — Wicklee's own consented test run. Exact
//!   and reproducible, and the only one that costs a model load.
//!
//! **A receipt never carries content.** The callback route rejects a payload
//! with a `prompt`, `response`, `messages` or `context` field instead of
//! dropping it, so an integration that would have sent a user's text fails
//! loudly the first time rather than quietly succeeding for months. That
//! promise is the reason this type has no field such text could land in.

use serde::Serialize;

/// Where a receipt came from. Not a quality ranking: all three are exact.
/// It matters because only `Fingerprint` ran on a prompt Wicklee chose, so
/// only `Fingerprint` receipts are comparable across hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReceiptSource {
    Callback,
    Fingerprint,
    Proxy,
}

impl ReceiptSource {
    /// The name the store writes and the JSON shows. One function for both, so
    /// a column value and an API value cannot drift apart.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Callback => "callback",
            Self::Fingerprint => "fingerprint",
            Self::Proxy => "proxy",
        }
    }

    pub(crate) fn from_name(s: &str) -> Option<Self> {
        match s {
            "callback" => Some(Self::Callback),
            "fingerprint" => Some(Self::Fingerprint),
            "proxy" => Some(Self::Proxy),
            _ => None,
        }
    }
}

/// Whether the model was already resident when the request arrived.
///
/// Two variants, not four. V9 found that page-cache state is not readable
/// without `unsafe` FFI, which Phase 1 does not take on, so a cold load's
/// variance cannot be attributed to the cache. `ColdCached` and
/// `ColdUncached` are therefore absent rather than present and never set: a
/// variant nothing can produce reads as a capability that exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StartState {
    /// Resident when the request arrived, so `load_ns` is absent or trivial.
    Loaded,
    /// Not resident. The load time is real and carries unquantified variance
    /// from the OS page cache, which the output says rather than implying the
    /// number is reproducible.
    ColdUnknown,
}

impl StartState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Loaded => "loaded",
            Self::ColdUnknown => "cold_unknown",
        }
    }

    pub(crate) fn from_name(s: &str) -> Option<Self> {
        match s {
            "loaded" => Some(Self::Loaded),
            "cold_unknown" => Some(Self::ColdUnknown),
            _ => None,
        }
    }
}

/// One request's measurements.
///
/// Every duration is nanoseconds and carries the runtime's own field name, so
/// a callback integration is a copy of the response object and not a
/// transformation — a transformation is where a unit gets converted twice.
/// `wall_ms` is the exception: it is milliseconds because Wicklee measures it
/// itself, and only its own test runs have it.
///
/// Almost everything is optional on purpose. A receipt with nothing but
/// durations still answers "how long did this take", and a runtime that stops
/// reporting a field should cost one `None`, not a rejected receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Receipt {
    pub(crate) id: String,
    pub(crate) ts_ms: i64,
    pub(crate) source: ReceiptSource,
    pub(crate) model: String,
    pub(crate) digest: Option<String>,
    pub(crate) context_length: Option<u64>,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) size_vram_bytes: Option<u64>,
    pub(crate) start_state: StartState,
    pub(crate) load_ns: Option<u64>,
    pub(crate) prompt_eval_count: Option<u64>,
    pub(crate) prompt_eval_cached_count: Option<u64>,
    pub(crate) prompt_eval_ns: Option<u64>,
    pub(crate) eval_count: Option<u64>,
    pub(crate) eval_ns: Option<u64>,
    pub(crate) total_ns: Option<u64>,
    /// Wall time Wicklee measured around its own request. `None` for a
    /// callback: the caller's wall time includes its own network hop, which is
    /// not a property of the inference.
    pub(crate) wall_ms: Option<u64>,
    pub(crate) co_resident: Vec<String>,
    pub(crate) thermal_state: Option<String>,
    pub(crate) test_id: Option<String>,
    pub(crate) finding_id: Option<String>,
}

impl Receipt {
    /// Generation rate, tokens per second.
    ///
    /// `None` rather than zero when the runtime did not report both halves, or
    /// reported a zero duration: a rate of zero is a measurement, and "not
    /// measured" is not. Every rule that reads a rate has to tell the two
    /// apart, so the type does it once here.
    pub(crate) fn decode_tps(&self) -> Option<f64> {
        rate(self.eval_count, self.eval_ns)
    }

    /// Prompt-processing rate, tokens per second. Prefill, not decode: the two
    /// differ by an order of magnitude and comparing one against the other is
    /// the easiest way to draw a wrong conclusion from a receipt.
    pub(crate) fn prompt_tps(&self) -> Option<f64> {
        rate(self.prompt_eval_count, self.prompt_eval_ns)
    }
}

/// Tokens per second from a count and a nanosecond duration.
fn rate(count: Option<u64>, ns: Option<u64>) -> Option<f64> {
    let (count, ns) = (count?, ns?);
    if ns == 0 {
        return None;
    }
    Some(count as f64 / (ns as f64 / 1e9))
}

/// A receipt's id, derived from the measurement itself.
///
/// Content-derived for the same reason a finding's id is: step 6's `verify`
/// cites receipts by id across two runs and a restart, and a counter renumbers
/// on every start.
///
/// **The arrival time is deliberately not in the hash.** It was, in the first
/// draft, and the comment next to it claimed a retried POST would store one
/// receipt rather than two. It did not: the timestamp is when the agent
/// received the body, so a retry of the same body got a new id and a second
/// row. The live check caught it where the unit test had not, because the test
/// reused one `Ambient` and the route builds a new one per request.
///
/// So the material is the payload, and nothing about when it showed up. Two
/// genuinely distinct requests would have to agree on every nanosecond
/// duration to collide, which does not happen. The honest consequence is at
/// the other end: a body with no timings at all, `{"model": "x"}`, is the same
/// material every time, so repeated posts of it collapse into one row. A
/// receipt with nothing measured in it is not a measurement worth counting
/// twice.
pub(crate) fn receipt_id(source: ReceiptSource, material: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in [source.as_str(), material] {
        // The separator keeps ("ab","c") from hashing as ("a","bc").
        for b in part.as_bytes().iter().chain(std::iter::once(&0x1f_u8)) {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("R-{:08x}", h & 0xffff_ffff)
}

/// Fields that mean the caller sent content.
///
/// Checked by name on the raw JSON before anything is deserialised, because a
/// typed struct ignores unknown fields by default and ignoring is exactly the
/// failure mode this is here to prevent. `context` is in the list even though
/// Ollama's is a token array rather than text: it is a conversation state the
/// caller should not be handing to a monitor, and a caller who meant `num_ctx`
/// should find out now.
pub(crate) const CONTENT_FIELDS: [&str; 4] = ["prompt", "response", "messages", "context"];

/// Why a callback payload was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CallbackError {
    NotAnObject,
    MissingModel,
    /// A content field was present. Carries which one, so the integration's
    /// author does not have to guess.
    ContentPresent(&'static str),
    /// A field was present with the wrong shape — a string duration, say.
    /// Carries the field name for the same reason.
    NotANumber(&'static str),
}

impl CallbackError {
    /// The sentence the route answers with. Written for whoever is wiring the
    /// integration up, which is why each one says what to do instead.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::NotAnObject => "the body must be a JSON object: the runtime's final response, with the content fields removed".into(),
            Self::MissingModel => "\"model\" is required — a receipt that does not name a model cannot be compared against anything".into(),
            Self::ContentPresent(field) => format!(
                "\"{field}\" is content. Wicklee stores metadata only, so this is refused rather than ignored: \
                 send the timing and token-count fields and drop {:?}",
                CONTENT_FIELDS,
            ),
            Self::NotANumber(field) => format!(
                "\"{field}\" must be a non-negative integer. Durations are nanoseconds, exactly as the runtime reports them"
            ),
        }
    }
}

/// Everything about a receipt that the payload does not carry.
///
/// The caller knows its own timings; only the agent knows what else was
/// resident and how hot the host was. Collected by the route from the tracker
/// rather than accepted from the body, because a self-reported co-residency
/// list is not evidence of anything.
#[derive(Debug, Clone, Default)]
pub(crate) struct Ambient {
    pub(crate) ts_ms: i64,
    pub(crate) digest: Option<String>,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) size_vram_bytes: Option<u64>,
    pub(crate) running_context_length: Option<u64>,
    pub(crate) co_resident: Vec<String>,
    pub(crate) thermal_state: Option<String>,
    /// Whether the tracker had the model resident when the receipt arrived.
    pub(crate) was_loaded: bool,
}

/// Build a receipt from a posted callback body.
///
/// Takes the raw [`serde_json::Value`] rather than a typed struct so the
/// content check runs on what was actually sent. Unknown extra fields are
/// allowed through: a runtime that adds a field should not break an
/// integration, and the ones that matter are named here.
pub(crate) fn from_callback(
    body: &serde_json::Value,
    ambient: &Ambient,
) -> Result<Receipt, CallbackError> {
    let obj = body.as_object().ok_or(CallbackError::NotAnObject)?;

    for field in CONTENT_FIELDS {
        if obj.contains_key(field) {
            return Err(CallbackError::ContentPresent(field));
        }
    }

    let model = obj
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(CallbackError::MissingModel)?
        .to_string();

    let num = |field: &'static str| -> Result<Option<u64>, CallbackError> {
        match obj.get(field) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(v) => v.as_u64().map(Some).ok_or(CallbackError::NotANumber(field)),
        }
    };

    let load_ns = num("load_duration")?;
    let total_ns = num("total_duration")?;
    let eval_count = num("eval_count")?;

    // The caller's num_ctx wins over the tracker's reading: the caller knows
    // what it asked for, and a request at a context the tracker has not polled
    // yet is exactly the case worth recording. Falling back to the running
    // value keeps a receipt comparable when the field is omitted.
    let context_length = num("num_ctx")?.or(ambient.running_context_length);

    // A load duration the runtime bothered to report means it loaded
    // something. Trusting the tracker's view instead would call every receipt
    // warm whenever a poll had not landed yet.
    let cold = !ambient.was_loaded || load_ns.is_some_and(|ns| ns > COLD_LOAD_NS);
    let start_state = if cold { StartState::ColdUnknown } else { StartState::Loaded };

    Ok(Receipt {
        // serde_json sorts object keys, so the same body serialises the same
        // way whatever order the caller sent its fields in.
        id: receipt_id(ReceiptSource::Callback, &body.to_string()),
        ts_ms: ambient.ts_ms,
        source: ReceiptSource::Callback,
        model,
        digest: ambient.digest.clone(),
        context_length,
        size_bytes: ambient.size_bytes,
        size_vram_bytes: ambient.size_vram_bytes,
        start_state,
        load_ns,
        prompt_eval_count: num("prompt_eval_count")?,
        prompt_eval_cached_count: num("prompt_eval_cached_count")?,
        prompt_eval_ns: num("prompt_eval_duration")?,
        eval_count,
        eval_ns: num("eval_duration")?,
        total_ns,
        wall_ms: None,
        co_resident: ambient.co_resident.clone(),
        thermal_state: ambient.thermal_state.clone(),
        test_id: None,
        finding_id: None,
    })
}

/// The ambient half of a receipt, from the tracker's model states.
///
/// Shared by the callback route and the proxy's receipt writer so the two
/// cannot disagree about what "co-resident" means. The caller adds the thermal
/// state, which comes from the metrics frame rather than the tracker.
pub(crate) fn ambient_from_states(
    model: &str,
    states: &[&crate::residency::ModelState],
    ts_ms: i64,
) -> Ambient {
    let mut a = Ambient { ts_ms, ..Default::default() };
    for s in states {
        if s.model == model {
            a.was_loaded = true;
            a.digest = s.digest.clone();
            a.size_bytes = s.size_bytes;
            a.size_vram_bytes = s.size_vram_bytes;
            a.running_context_length = s.context_length;
        } else {
            a.co_resident.push(s.model.clone());
        }
    }
    a.co_resident.sort();
    a
}

/// A receipt from a proxied request's final packet.
///
/// The proxy forwards the done packet onto the trace row and nothing more: it
/// starts before the residency tracker exists and has no view of what else is
/// loaded. So the enrichment happens here, in the writer task that has both.
///
/// `ts_ms` is the request's, taken from the trace, not the moment the row was
/// drained — a receipt timestamped when it was written would misplace every
/// proxied request by however long the queue was.
#[cfg(not(target_env = "musl"))]
pub(crate) fn from_proxy_trace(t: &crate::store::TraceRow, ambient: &Ambient) -> Receipt {
    let u = |v: Option<i64>| v.and_then(|x| u64::try_from(x).ok());
    let load_ns = u(t.load_duration_ns);
    Receipt {
        // The trace id is already unique per proxied request, so there is
        // nothing to deduplicate and no reason to hash the packet: one
        // request through the proxy is one receipt.
        id: receipt_id(ReceiptSource::Proxy, &t.id),
        ts_ms: t.ts_ms,
        source: ReceiptSource::Proxy,
        model: t.model.clone(),
        digest: ambient.digest.clone(),
        context_length: ambient.running_context_length,
        size_bytes: ambient.size_bytes,
        size_vram_bytes: ambient.size_vram_bytes,
        // The reported load duration decides, not the tracker: a receipt is
        // written seconds after the request, by which time the tracker's view
        // is of the host now rather than of the host then.
        start_state: if load_ns.is_some_and(|ns| ns > COLD_LOAD_NS) {
            StartState::ColdUnknown
        } else {
            StartState::Loaded
        },
        load_ns,
        prompt_eval_count: u(t.prompt_eval_count),
        prompt_eval_cached_count: u(t.prompt_eval_cached_count),
        prompt_eval_ns: u(t.prompt_eval_duration_ns),
        eval_count: u(t.eval_count),
        eval_ns: u(t.eval_duration_ns),
        total_ns: u(t.total_duration_ns),
        // Wicklee did not time this request; the runtime did, and the proxy
        // only watched the bytes go past. A wall time measured around the
        // relay would include the client's own read speed.
        wall_ms: None,
        co_resident: ambient.co_resident.clone(),
        thermal_state: ambient.thermal_state.clone(),
        test_id: None,
        finding_id: None,
    }
}

/// Above this, a reported load duration means a real load rather than the
/// microseconds a warm hit spends checking. A warm `/api/generate` on the
/// maintainer's M4 reports about 6 ms; a 4B cold load takes 3.4 s. 100 ms
/// sits in the empty space between the two.
const COLD_LOAD_NS: u64 = 100_000_000;

/// Median, low and high of a set of measurements.
///
/// The spec reports a range rather than a mean everywhere, for a reason worth
/// keeping in one place: three runs of an inference test are not normally
/// distributed — one of them hits a thermal step or a background compile — and
/// a mean hides that while a range shows it. The fourth evidence rule then
/// compares two ranges and calls a difference real only when they do not
/// overlap.
///
/// That comparison is not here yet, deliberately: nothing in step 5 has two
/// runs to compare, and `verify` in step 6 is what gains it. A method with no
/// caller reads as a capability that exists.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub(crate) struct Stats {
    pub(crate) median: f64,
    pub(crate) low: f64,
    pub(crate) high: f64,
    pub(crate) n: usize,
}

impl Stats {
    /// `None` on an empty set: a range over nothing is not zero.
    pub(crate) fn of(values: &[f64]) -> Option<Self> {
        if values.is_empty() {
            return None;
        }
        let mut v: Vec<f64> = values.iter().copied().filter(|x| x.is_finite()).collect();
        if v.is_empty() {
            return None;
        }
        v.sort_by(|a, b| a.partial_cmp(b).expect("filtered to finite"));
        let mid = v.len() / 2;
        let median = if v.len().is_multiple_of(2) {
            (v[mid - 1] + v[mid]) / 2.0
        } else {
            v[mid]
        };
        Some(Self {
            median,
            low: v[0],
            high: v[v.len() - 1],
            n: v.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ambient() -> Ambient {
        Ambient {
            ts_ms: 1_700_000_000_000,
            digest: Some("sha256:abc".into()),
            size_bytes: Some(5_280_104_447),
            size_vram_bytes: Some(5_280_104_447),
            running_context_length: Some(8192),
            co_resident: vec!["other:7b".into()],
            thermal_state: Some("Normal".into()),
            was_loaded: true,
        }
    }

    /// The spec's example body, field for field.
    fn spec_example() -> serde_json::Value {
        json!({
            "model": "coder:14b",
            "total_duration": 8_113_331_500_u64,
            "load_duration": 6_396_458_u64,
            "prompt_eval_count": 26,
            "prompt_eval_duration": 130_079_000_u64,
            "eval_count": 298,
            "eval_duration": 4_868_000_000_u64,
            "num_ctx": 32768
        })
    }

    #[test]
    fn the_spec_example_round_trips_into_rates() {
        let r = from_callback(&spec_example(), &ambient()).unwrap();
        assert_eq!(r.model, "coder:14b");
        assert_eq!(r.source, ReceiptSource::Callback);
        assert_eq!(r.context_length, Some(32768), "the caller's num_ctx wins");
        assert_eq!(r.start_state, StartState::Loaded, "6 ms is a warm hit");
        assert_eq!(r.co_resident, vec!["other:7b".to_string()]);
        assert_eq!(r.wall_ms, None, "a caller's wall time is not the inference's");

        // 298 tokens in 4.868 s.
        let tps = r.decode_tps().unwrap();
        assert!((tps - 61.2).abs() < 0.1, "decode {tps}");
        // 26 tokens in 130.079 ms.
        let prompt = r.prompt_tps().unwrap();
        assert!((prompt - 199.9).abs() < 0.2, "prompt {prompt}");
    }

    #[test]
    fn content_is_refused_by_name_rather_than_ignored() {
        for field in CONTENT_FIELDS {
            let mut body = spec_example();
            body.as_object_mut().unwrap().insert(field.to_string(), json!("anything"));
            assert_eq!(
                from_callback(&body, &ambient()),
                Err(CallbackError::ContentPresent(field)),
                "{field} must be refused",
            );
            // The refusal names the field and lists the whole set, so one
            // failed call is enough to fix the integration.
            let msg = CallbackError::ContentPresent(field).message();
            assert!(msg.contains(field), "{msg}");
        }
    }

    #[test]
    fn only_the_model_is_required() {
        let r = from_callback(&json!({"model": "tiny:1b"}), &ambient()).unwrap();
        assert_eq!(r.model, "tiny:1b");
        assert_eq!(r.total_ns, None);
        assert_eq!(r.decode_tps(), None, "no counts means no rate, not zero");
        assert_eq!(r.context_length, Some(8192), "falls back to the running context");

        assert_eq!(from_callback(&json!({}), &ambient()), Err(CallbackError::MissingModel));
        assert_eq!(from_callback(&json!({"model": "  "}), &ambient()), Err(CallbackError::MissingModel));
        assert_eq!(from_callback(&json!([1, 2]), &ambient()), Err(CallbackError::NotAnObject));
    }

    #[test]
    fn a_duration_sent_as_a_string_is_refused() {
        let mut body = spec_example();
        body.as_object_mut().unwrap().insert("eval_duration".into(), json!("4868000000"));
        assert_eq!(
            from_callback(&body, &ambient()),
            Err(CallbackError::NotANumber("eval_duration")),
        );
    }

    #[test]
    fn a_real_load_duration_makes_the_receipt_cold() {
        let mut body = spec_example();
        body.as_object_mut().unwrap().insert("load_duration".into(), json!(3_364_000_000_u64));
        let r = from_callback(&body, &ambient()).unwrap();
        assert_eq!(r.start_state, StartState::ColdUnknown, "3.4 s is a load");

        // And a model the tracker had not seen is cold whatever it reports.
        let mut a = ambient();
        a.was_loaded = false;
        assert_eq!(
            from_callback(&spec_example(), &a).unwrap().start_state,
            StartState::ColdUnknown,
        );
    }

    #[test]
    fn a_retried_post_is_the_same_receipt_however_much_later_it_arrives() {
        let a = from_callback(&spec_example(), &ambient()).unwrap();

        // The case the first draft got wrong: the route builds a fresh
        // Ambient per request, so a retry arrives with a later timestamp. It
        // is still the same measurement and must still be one row.
        let mut later = ambient();
        later.ts_ms += 45_000;
        let b = from_callback(&spec_example(), &later).unwrap();
        assert_eq!(a.id, b.id, "a retry is the same receipt, not a new one");

        // One token of difference is a different request.
        let mut other = spec_example();
        other.as_object_mut().unwrap().insert("eval_count".into(), json!(299));
        assert_ne!(from_callback(&other, &ambient()).unwrap().id, a.id);

        // Field order is the caller's business, not an identity.
        let reordered: serde_json::Value = serde_json::from_str(
            r#"{"eval_count":298,"model":"coder:14b","num_ctx":32768,
                "total_duration":8113331500,"load_duration":6396458,
                "prompt_eval_count":26,"prompt_eval_duration":130079000,
                "eval_duration":4868000000}"#,
        )
        .unwrap();
        assert_eq!(from_callback(&reordered, &ambient()).unwrap().id, a.id);
    }

    #[test]
    fn names_survive_a_round_trip() {
        for s in [ReceiptSource::Callback, ReceiptSource::Fingerprint, ReceiptSource::Proxy] {
            assert_eq!(ReceiptSource::from_name(s.as_str()), Some(s));
        }
        for s in [StartState::Loaded, StartState::ColdUnknown] {
            assert_eq!(StartState::from_name(s.as_str()), Some(s));
        }
        assert_eq!(ReceiptSource::from_name("telepathy"), None);
        assert_eq!(StartState::from_name("cold_cached"), None, "no such thing in Phase 1");
    }

    #[cfg(not(target_env = "musl"))]
    #[test]
    fn a_proxy_trace_becomes_a_receipt_with_the_runtimes_own_nanoseconds() {
        let t = crate::store::TraceRow {
            id: "11111111-2222-3333-4444-555555555555".into(),
            ts_ms: 1_700_000_000_000,
            node_id: "WK-TEST".into(),
            model: "coder:14b".into(),
            // The rounded millisecond fields the dashboard uses. The receipt
            // must not be built from these.
            latency_ms: 8_113,
            ttft_ms: 130,
            tpot_ms: 16.33,
            status: 200,
            eval_count: Some(298),
            eval_duration_ns: Some(4_868_000_000),
            load_duration_ns: Some(6_396_458),
            prompt_eval_count: Some(26),
            prompt_eval_cached_count: Some(12),
            prompt_eval_duration_ns: Some(130_079_000),
            total_duration_ns: Some(8_113_331_500),
        };
        let mut a = ambient();
        a.ts_ms = t.ts_ms;
        let r = from_proxy_trace(&t, &a);

        assert_eq!(r.source, ReceiptSource::Proxy);
        assert_eq!(r.ts_ms, t.ts_ms, "the request's time, not the queue's");
        assert_eq!(r.total_ns, Some(8_113_331_500), "nanoseconds, not 8113 ms");
        assert_eq!(r.prompt_eval_ns, Some(130_079_000));
        assert_eq!(r.prompt_eval_cached_count, Some(12));
        assert_eq!(r.start_state, StartState::Loaded, "6.4 ms is a warm hit");
        assert_eq!(r.wall_ms, None, "the proxy only watched the bytes go past");
        assert_eq!(r.co_resident, vec!["other:7b".to_string()]);
        assert!((r.decode_tps().unwrap() - 61.2).abs() < 0.1);

        // One request through the proxy is one receipt, keyed on its trace id.
        assert_eq!(r.id, from_proxy_trace(&t, &a).id);
        let mut other = t.clone();
        other.id = "99999999-2222-3333-4444-555555555555".into();
        assert_ne!(from_proxy_trace(&other, &a).id, r.id);

        // A real load makes it cold even though the tracker says it was there.
        let mut cold = t.clone();
        cold.load_duration_ns = Some(3_364_000_000);
        assert_eq!(from_proxy_trace(&cold, &a).start_state, StartState::ColdUnknown);
    }

    #[test]
    fn stats_report_a_median_and_a_range() {
        let s = Stats::of(&[61.2, 59.8, 60.5]).unwrap();
        assert_eq!(s.n, 3);
        assert!((s.median - 60.5).abs() < 1e-9);
        assert!((s.low - 59.8).abs() < 1e-9);
        assert!((s.high - 61.2).abs() < 1e-9);

        // Even count takes the mean of the middle two.
        let even = Stats::of(&[1.0, 2.0, 3.0, 4.0]).unwrap();
        assert!((even.median - 2.5).abs() < 1e-9);

        assert_eq!(Stats::of(&[]), None);
        assert_eq!(Stats::of(&[f64::NAN]), None, "a range over nothing measurable");
    }
}
