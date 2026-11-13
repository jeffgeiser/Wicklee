//! Per-model residency state and a transition log.
//!
//! The harvester already polls `/api/ps` every 5 seconds. This module turns
//! that stream of snapshots into per-model state and a log of what changed,
//! which is what the readiness and diagnostic rules read. It starts no poll of
//! its own: [`Tracker::observe`] is called once per harvester tick and is a
//! deterministic function of the previous state and this poll, so a scripted
//! sequence of polls produces an exactly predictable sequence of transitions.
//!
//! Two things it deliberately does not do:
//!
//! - **It never infers an unload from a failed poll.** `/api/ps` returning an
//!   error is not the same as returning an empty list, and the caller must not
//!   call `observe` on a read that failed. Treating a timeout as "everything
//!   unloaded" would write a pair of phantom transitions on every hiccup.
//! - **It never guesses who caused a change.** The caller passes the [`Actor`]
//!   it knows about from its own one-shot probe flag, and anything the tracker
//!   cannot attribute is [`Cause::Unknown`] rather than [`Cause::User`].

use std::collections::{BTreeMap, VecDeque};

use serde::Serialize;

/// How many transitions the in-memory log keeps.
///
/// This is the entire history on a musl build, where there is no DuckDB, and
/// the recent window everywhere else.
pub(crate) const HISTORY_CAP: usize = 2_000;

/// An `expires_at` move smaller than this is clock noise, not a reset.
const EXPIRY_EPSILON_MS: i64 = 1_000;

/// How far before its stated expiry a model may unload and still be read as
/// having expired rather than been evicted. Covers clock skew between the
/// runtime's timestamp and ours, nothing more.
const EXPIRY_SKEW_MS: i64 = 2_000;

/// Whether the runtime currently holds this model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Residency {
    Loaded,
    NotLoaded,
}

/// What is known about one model right now.
///
/// A state is kept after the model unloads, with `residency` flipped and the
/// fields that are no longer true cleared. `last_activity_ms` and
/// `installed_size_bytes` survive an unload, because the rules that ask "was
/// this reloaded soon after it expired?" need what was known before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ModelState {
    pub(crate) model: String,
    pub(crate) digest: Option<String>,
    pub(crate) residency: Residency,
    /// Runtime footprint while loaded: weights **plus** KV cache, so it moves
    /// with the running context (step 0, V1).
    pub(crate) size_bytes: Option<u64>,
    pub(crate) size_vram_bytes: Option<u64>,
    /// The context the model is running at, not its maximum.
    pub(crate) context_length: Option<u64>,
    pub(crate) expires_at_ms: Option<i64>,
    /// Last expiry reset attributed to a real caller. The agent's own probe is
    /// excluded, which is the whole point of attributing in the first place.
    pub(crate) last_activity_ms: Option<i64>,
    /// Installed file size from `/api/tags`. Not the resident footprint: step 0
    /// V7 measured the installed size *above* the resident size.
    pub(crate) installed_size_bytes: Option<u64>,
    pub(crate) observed_at_ms: i64,
}

impl ModelState {
    /// True when some of the footprint sits outside accelerator memory.
    fn is_split(&self) -> bool {
        match (self.size_bytes, self.size_vram_bytes) {
            (Some(total), Some(vram)) => vram < total,
            _ => false,
        }
    }
}

/// What changed. One poll can produce several of these for one model: a request
/// that omits `num_ctx` both resets the expiry and drops the context (V3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TransitionKind {
    Loaded,
    Unloaded,
    /// `expires_at` moved later, which is the runtime's own signal that
    /// something asked for this model.
    ExpiryReset,
    /// The model crossed between fully resident in accelerator memory and
    /// partly outside it. Recorded on the crossing only, not on every byte of
    /// drift, so the log answers "since when" without being flooded.
    PlacementChanged,
    ContextChanged,
}

/// Why it changed. Never a guess: see [`Cause::Unknown`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Cause {
    User,
    /// The agent's own idle probe.
    Probe,
    /// The model's keep-alive ran out.
    ExpiryReached,
    /// Nothing observed explains it. An unload while the expiry was still in
    /// the future lands here, because eviction and a `keep_alive: 0` from some
    /// other caller look identical from outside.
    Unknown,
}

/// Who, of the parties the agent knows about, was driving the runtime during
/// one poll. The tracker derives [`Cause::ExpiryReached`] and
/// [`Cause::Unknown`] itself; they are not inputs.
///
/// The spec also lists a `Fingerprint` actor and cause. Step 5 builds the
/// consented test runs that produce them, and they arrive with it: a variant
/// nothing can construct is the dead code the cleanup rules forbid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Actor {
    User,
    Probe,
}

impl From<Actor> for Cause {
    fn from(a: Actor) -> Self {
        match a {
            Actor::User => Cause::User,
            Actor::Probe => Cause::Probe,
        }
    }
}

/// One recorded change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Transition {
    pub(crate) id: u64,
    pub(crate) ts_ms: i64,
    pub(crate) model: String,
    pub(crate) kind: TransitionKind,
    pub(crate) cause: Cause,
    pub(crate) before: Option<Box<ModelState>>,
    pub(crate) after: Option<Box<ModelState>>,
    /// Other models the runtime held at this moment. Eviction is memory-gated
    /// (V4), so what else was resident is part of the evidence.
    pub(crate) co_resident: Vec<String>,
}

/// One model as a single `/api/ps` poll reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PolledModel {
    pub(crate) model: String,
    pub(crate) digest: Option<String>,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) size_vram_bytes: Option<u64>,
    pub(crate) context_length: Option<u64>,
    pub(crate) expires_at_ms: Option<i64>,
}

/// One complete `/api/ps` read. Only construct this from a read that succeeded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Poll {
    pub(crate) ts_ms: i64,
    pub(crate) models: Vec<PolledModel>,
    pub(crate) actor: Actor,
}

impl Poll {
    /// Build a poll from a successful `/api/ps` response.
    ///
    /// Entries with no usable name are dropped: there is nothing to key a state
    /// on, and inventing one would merge unrelated models.
    pub(crate) fn from_ps(ps: &crate::ollama_client::PsResponse, ts_ms: i64, actor: Actor) -> Self {
        let models = ps
            .models
            .iter()
            .filter_map(|m| {
                let name = m
                    .name
                    .as_deref()
                    .or(m.model.as_deref())
                    .map(str::trim)
                    .filter(|n| !n.is_empty())?;
                Some(PolledModel {
                    model: name.to_string(),
                    digest: m.digest.clone(),
                    size_bytes: m.size,
                    size_vram_bytes: m.size_vram,
                    context_length: m.context_length,
                    expires_at_ms: m.expires_at.as_deref().and_then(rfc3339_to_ms),
                })
            })
            .collect();
        Self { ts_ms, models, actor }
    }
}

/// Per-model state and the recent transition log.
#[derive(Debug, Default)]
pub(crate) struct Tracker {
    states: BTreeMap<String, ModelState>,
    history: VecDeque<Transition>,
    next_id: u64,
}

impl Tracker {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Fold one poll into the state and return the transitions it produced.
    ///
    /// The returned transitions are also appended to the in-memory log, so a
    /// caller that persists them elsewhere does not have to hand them back.
    pub(crate) fn observe(&mut self, poll: &Poll) -> Vec<Transition> {
        let ts = poll.ts_ms;
        let actor_cause = Cause::from(poll.actor);
        let names: Vec<&str> = poll.models.iter().map(|m| m.model.as_str()).collect();
        let mut drafts: Vec<(String, TransitionKind, Cause, Option<ModelState>, Option<ModelState>)> =
            Vec::new();

        // ── Gone: loaded last time, absent now ──────────────────────────────
        let gone: Vec<String> = self
            .states
            .values()
            .filter(|s| s.residency == Residency::Loaded)
            .filter(|s| !names.contains(&s.model.as_str()))
            .map(|s| s.model.clone())
            .collect();
        for model in gone {
            let before = self.states.get(&model).cloned();
            let cause = match before.as_ref().and_then(|s| s.expires_at_ms) {
                // Gone at or after its stated expiry: the keep-alive ran out.
                Some(expiry) if expiry <= ts + EXPIRY_SKEW_MS => Cause::ExpiryReached,
                // Gone early, or with no expiry to compare against. Eviction and
                // a keep_alive of 0 from another caller are indistinguishable
                // from here, so neither is claimed.
                _ => Cause::Unknown,
            };
            let after = self.unload(&model, ts);
            drafts.push((model, TransitionKind::Unloaded, cause, before, after));
        }

        // ── Present: new, or changed since last time ────────────────────────
        for polled in &poll.models {
            let before = self.states.get(&polled.model).cloned();
            let was_loaded = before
                .as_ref()
                .is_some_and(|s| s.residency == Residency::Loaded);

            // A digest change under the same name is a different model. Record
            // it as an unload and a load rather than mutating state silently.
            let replaced = was_loaded
                && match (before.as_ref().and_then(|s| s.digest.as_deref()), polled.digest.as_deref())
                {
                    (Some(old), Some(new)) => old != new,
                    _ => false,
                };
            if replaced {
                let after = self.unload(&polled.model, ts);
                drafts.push((
                    polled.model.clone(),
                    TransitionKind::Unloaded,
                    Cause::Unknown,
                    before.clone(),
                    after,
                ));
            }

            if !was_loaded || replaced {
                // A replaced model is a different model, so none of the old
                // state carries over to it.
                let carried = if replaced { None } else { before.as_ref() };
                let state = self.load(polled, ts, actor_cause, carried);
                drafts.push((
                    polled.model.clone(),
                    TransitionKind::Loaded,
                    actor_cause,
                    before.filter(|_| !replaced),
                    Some(state),
                ));
                continue;
            }

            let before = before.expect("was_loaded implies a previous state");
            let context_changed = polled.context_length.is_some()
                && polled.context_length != before.context_length;
            let expiry_reset = match (before.expires_at_ms, polled.expires_at_ms) {
                (Some(old), Some(new)) => new > old + EXPIRY_EPSILON_MS,
                (None, Some(_)) => true,
                _ => false,
            };

            let mut after = self.update(polled, ts, &before);
            if expiry_reset && matches!(poll.actor, Actor::User) {
                after.last_activity_ms = Some(ts);
                self.states.insert(polled.model.clone(), after.clone());
            }
            let placement_changed = after.is_split() != before.is_split();

            // Fixed order, so a scripted sequence is reproducible.
            for kind in [
                (context_changed, TransitionKind::ContextChanged),
                (expiry_reset, TransitionKind::ExpiryReset),
                (placement_changed, TransitionKind::PlacementChanged),
            ]
            .into_iter()
            .filter_map(|(fired, k)| fired.then_some(k))
            {
                let cause = if kind == TransitionKind::PlacementChanged {
                    // Placement is the runtime's allocation decision, not an act
                    // of whoever happened to be calling.
                    Cause::Unknown
                } else {
                    actor_cause
                };
                drafts.push((
                    polled.model.clone(),
                    kind,
                    cause,
                    Some(before.clone()),
                    Some(after.clone()),
                ));
            }
        }

        // ── Assign ids and record ───────────────────────────────────────────
        let mut out = Vec::with_capacity(drafts.len());
        for (model, kind, cause, before, after) in drafts {
            let co_resident = names
                .iter()
                .copied()
                .filter(|n| *n != model.as_str())
                .map(str::to_string)
                .collect();
            self.next_id += 1;
            out.push(Transition {
                id: self.next_id,
                ts_ms: ts,
                model,
                kind,
                cause,
                before: before.map(Box::new),
                after: after.map(Box::new),
                co_resident,
            });
        }
        for t in &out {
            if self.history.len() == HISTORY_CAP {
                self.history.pop_front();
            }
            self.history.push_back(t.clone());
        }
        out
    }

    /// Record the installed file sizes from an `/api/tags` read.
    ///
    /// `/api/tags` is read on demand, not polled, so this arrives out of band
    /// and only fills a field; it produces no transitions.
    pub(crate) fn observe_installed_sizes(&mut self, sizes: &[(String, u64)], ts_ms: i64) {
        for (model, bytes) in sizes {
            match self.states.get_mut(model) {
                Some(state) => state.installed_size_bytes = Some(*bytes),
                None => {
                    self.states.insert(
                        model.clone(),
                        ModelState {
                            model: model.clone(),
                            digest: None,
                            residency: Residency::NotLoaded,
                            size_bytes: None,
                            size_vram_bytes: None,
                            context_length: None,
                            expires_at_ms: None,
                            last_activity_ms: None,
                            installed_size_bytes: Some(*bytes),
                            observed_at_ms: ts_ms,
                        },
                    );
                }
            }
        }
    }

    /// Every model the tracker has seen, loaded or not.
    pub(crate) fn states(&self) -> impl Iterator<Item = &ModelState> {
        self.states.values()
    }

    /// The recent transition log, oldest first.
    pub(crate) fn history(&self) -> impl Iterator<Item = &Transition> {
        self.history.iter()
    }

    /// How many transitions have been recorded since start, including any the
    /// in-memory log has already dropped.
    pub(crate) fn recorded(&self) -> u64 {
        self.next_id
    }

    /// A small picture of what the tracker holds, for `/api/health`.
    ///
    /// The `/v1` endpoints that consume the log properly arrive in step 3. This
    /// exists now for the same reason the capability record got a consumer in
    /// step 1: a log nothing reads cannot be verified.
    pub(crate) fn summary(&self) -> serde_json::Value {
        let loaded = self
            .states()
            .filter(|s| s.residency == Residency::Loaded)
            .count();
        serde_json::json!({
            "models_tracked":        self.states().count(),
            "models_loaded":         loaded,
            "transitions_recorded":  self.recorded(),
            "transitions_kept":      self.history().count(),
            "history_cap":           HISTORY_CAP,
            "latest":                self.history.back(),
        })
    }

    fn load(
        &mut self,
        polled: &PolledModel,
        ts: i64,
        cause: Cause,
        previous: Option<&ModelState>,
    ) -> ModelState {
        let state = ModelState {
            model: polled.model.clone(),
            digest: polled.digest.clone(),
            residency: Residency::Loaded,
            size_bytes: polled.size_bytes,
            size_vram_bytes: polled.size_vram_bytes,
            context_length: polled.context_length,
            expires_at_ms: polled.expires_at_ms,
            // A load a real caller asked for is activity. A load the probe or a
            // test run caused is not, which is why the two are told apart.
            last_activity_ms: if cause == Cause::User {
                Some(ts)
            } else {
                previous.and_then(|p| p.last_activity_ms)
            },
            installed_size_bytes: previous.and_then(|p| p.installed_size_bytes),
            observed_at_ms: ts,
        };
        self.states.insert(polled.model.clone(), state.clone());
        state
    }

    fn update(&mut self, polled: &PolledModel, ts: i64, before: &ModelState) -> ModelState {
        let state = ModelState {
            model: polled.model.clone(),
            digest: polled.digest.clone().or_else(|| before.digest.clone()),
            residency: Residency::Loaded,
            size_bytes: polled.size_bytes,
            size_vram_bytes: polled.size_vram_bytes,
            context_length: polled.context_length,
            expires_at_ms: polled.expires_at_ms,
            last_activity_ms: before.last_activity_ms,
            installed_size_bytes: before.installed_size_bytes,
            observed_at_ms: ts,
        };
        self.states.insert(polled.model.clone(), state.clone());
        state
    }

    /// Flip a state to not-loaded, clearing what is no longer true and keeping
    /// what still is.
    fn unload(&mut self, model: &str, ts: i64) -> Option<ModelState> {
        let state = self.states.get_mut(model)?;
        state.residency = Residency::NotLoaded;
        state.size_bytes = None;
        state.size_vram_bytes = None;
        state.context_length = None;
        state.expires_at_ms = None;
        state.observed_at_ms = ts;
        Some(state.clone())
    }
}

/// The tracker as the rest of the agent holds it.
pub(crate) type SharedTracker = std::sync::Arc<std::sync::Mutex<Tracker>>;

/// Epoch milliseconds, as the log records them.
pub(crate) fn now_ms() -> i64 {
    i64::try_from(crate::config::now_ms()).unwrap_or(i64::MAX)
}

/// Parse an RFC 3339 timestamp to epoch milliseconds.
///
/// Ollama reports `expires_at` as a local-offset RFC 3339 string, and the agent
/// carries no date crate — one field does not justify a dependency. This
/// accepts the shapes Ollama emits, `2026-11-13T09:26:44.305831-05:00` and its
/// `Z` form, and returns `None` on anything it does not fully understand rather
/// than a partially parsed guess.
pub(crate) fn rfc3339_to_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    if b[4] != b'-' || b[7] != b'-' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { s.get(from..to)?.parse::<i64>().ok() };
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let mut rest = &s[19..];
    let mut millis: i64 = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.len() - frac.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 {
            return None;
        }
        let mut scaled = String::with_capacity(3);
        scaled.push_str(&frac[..digits.min(3)]);
        while scaled.len() < 3 {
            scaled.push('0');
        }
        millis = scaled.parse::<i64>().ok()?;
        rest = &frac[digits..];
    }

    let offset_s = match rest.as_bytes().first() {
        Some(b'Z' | b'z') if rest.len() == 1 => 0,
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'-' { -1 } else { 1 };
            let body = &rest[1..];
            let (oh, om) = match body.len() {
                5 if body.as_bytes()[2] == b':' => (&body[..2], &body[3..]),
                4 => (&body[..2], &body[2..]),
                _ => return None,
            };
            let oh = oh.parse::<i64>().ok()?;
            let om = om.parse::<i64>().ok()?;
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 3600 + om * 60)
        }
        // A naive timestamp has no zone to resolve, and guessing one would put
        // the value hours away from the truth.
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_s;
    secs.checked_mul(1_000)?.checked_add(millis)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn pm(model: &str, size: u64, vram: u64, ctx: u64, expires_at_ms: i64) -> PolledModel {
        PolledModel {
            model: model.to_string(),
            digest: Some(format!("sha256:{model}")),
            size_bytes: Some(size),
            size_vram_bytes: Some(vram),
            context_length: Some(ctx),
            expires_at_ms: Some(expires_at_ms),
        }
    }

    fn poll(ts: i64, actor: Actor, models: Vec<PolledModel>) -> Poll {
        Poll { ts_ms: ts, models, actor }
    }

    fn kinds(ts: &[Transition]) -> Vec<TransitionKind> {
        ts.iter().map(|t| t.kind).collect()
    }

    #[test]
    fn a_first_sighting_is_one_load_and_nothing_else() {
        let mut t = Tracker::new();
        let out = t.observe(&poll(T0, Actor::User, vec![pm("a", 100, 100, 4096, T0 + 300_000)]));
        assert_eq!(kinds(&out), vec![TransitionKind::Loaded]);
        assert_eq!(out[0].cause, Cause::User);
        assert_eq!(out[0].id, 1);
        assert!(out[0].before.is_none());
        assert_eq!(out[0].after.as_ref().unwrap().last_activity_ms, Some(T0));
    }

    #[test]
    fn an_unchanged_poll_produces_nothing() {
        let mut t = Tracker::new();
        let m = pm("a", 100, 100, 4096, T0 + 300_000);
        t.observe(&poll(T0, Actor::User, vec![m.clone()]));
        // Five more identical polls. A tracker that logged every tick would
        // bury the real transitions under 17,000 rows a day.
        for i in 1..=5 {
            let out = t.observe(&poll(T0 + i * 5_000, Actor::User, vec![m.clone()]));
            assert!(out.is_empty(), "poll {i} produced {out:?}");
        }
        assert_eq!(t.recorded(), 1);
    }

    #[test]
    fn a_request_omitting_num_ctx_shows_as_a_context_drop_and_an_expiry_reset() {
        // Step 0 V3: a request without num_ctx reloads the model at the runtime
        // default. Both halves of that signature have to appear, in this order,
        // because the context_reset rule reads them together.
        let mut t = Tracker::new();
        t.observe(&poll(T0, Actor::User, vec![pm("a", 800, 800, 8192, T0 + 300_000)]));
        let out = t.observe(&poll(
            T0 + 5_000,
            Actor::User,
            vec![pm("a", 400, 400, 4096, T0 + 305_000)],
        ));
        assert_eq!(
            kinds(&out),
            vec![TransitionKind::ContextChanged, TransitionKind::ExpiryReset]
        );
        let ctx = &out[0];
        assert_eq!(ctx.before.as_ref().unwrap().context_length, Some(8192));
        assert_eq!(ctx.after.as_ref().unwrap().context_length, Some(4096));
        assert_eq!(ctx.cause, Cause::User);
    }

    #[test]
    fn a_probe_reset_is_recorded_but_is_not_user_activity() {
        let mut t = Tracker::new();
        t.observe(&poll(T0, Actor::Probe, vec![pm("a", 100, 100, 4096, T0 + 300_000)]));
        let loaded_activity = t.states().next().unwrap().last_activity_ms;
        assert_eq!(loaded_activity, None, "a probe load is not user activity");

        let out = t.observe(&poll(
            T0 + 5_000,
            Actor::Probe,
            vec![pm("a", 100, 100, 4096, T0 + 305_000)],
        ));
        assert_eq!(kinds(&out), vec![TransitionKind::ExpiryReset]);
        assert_eq!(out[0].cause, Cause::Probe);
        assert_eq!(
            t.states().next().unwrap().last_activity_ms,
            None,
            "the probe's own expiry reset must not look like a caller"
        );

        // The same reset from a real caller does move it.
        let out = t.observe(&poll(
            T0 + 10_000,
            Actor::User,
            vec![pm("a", 100, 100, 4096, T0 + 310_000)],
        ));
        assert_eq!(kinds(&out), vec![TransitionKind::ExpiryReset]);
        assert_eq!(
            t.states().next().unwrap().last_activity_ms,
            Some(T0 + 10_000)
        );
    }

    #[test]
    fn expiry_noise_below_the_epsilon_is_not_a_reset() {
        let mut t = Tracker::new();
        t.observe(&poll(T0, Actor::User, vec![pm("a", 100, 100, 4096, T0 + 300_000)]));
        let out = t.observe(&poll(
            T0 + 5_000,
            Actor::User,
            vec![pm("a", 100, 100, 4096, T0 + 300_500)],
        ));
        assert!(out.is_empty(), "half a second of drift is not a reset");
    }

    #[test]
    fn an_unload_at_expiry_is_told_apart_from_one_before_it() {
        // Expired: the stated expiry had passed when the model went.
        let mut t = Tracker::new();
        t.observe(&poll(T0, Actor::User, vec![pm("a", 100, 100, 4096, T0 + 5_000)]));
        let out = t.observe(&poll(T0 + 10_000, Actor::User, vec![]));
        assert_eq!(kinds(&out), vec![TransitionKind::Unloaded]);
        assert_eq!(out[0].cause, Cause::ExpiryReached);

        // Gone early: this is what eviction looks like, but a keep_alive of 0
        // from another caller looks identical, so neither is claimed.
        let mut t = Tracker::new();
        t.observe(&poll(T0, Actor::User, vec![pm("b", 100, 100, 4096, T0 + 600_000)]));
        let out = t.observe(&poll(T0 + 5_000, Actor::User, vec![]));
        assert_eq!(out[0].cause, Cause::Unknown);
    }

    #[test]
    fn placement_fires_on_the_crossing_and_not_on_drift() {
        let mut t = Tracker::new();
        t.observe(&poll(T0, Actor::User, vec![pm("a", 1_000, 1_000, 4096, T0 + 300_000)]));

        // Crossing into a split.
        let out = t.observe(&poll(
            T0 + 5_000,
            Actor::User,
            vec![pm("a", 1_000, 600, 4096, T0 + 300_000)],
        ));
        assert_eq!(kinds(&out), vec![TransitionKind::PlacementChanged]);
        assert_eq!(
            out[0].cause,
            Cause::Unknown,
            "where the runtime puts bytes is not the caller's act"
        );

        // Still split, different ratio: no new transition.
        let out = t.observe(&poll(
            T0 + 10_000,
            Actor::User,
            vec![pm("a", 1_000, 300, 4096, T0 + 300_000)],
        ));
        assert!(out.is_empty(), "drift inside a split is not a crossing");

        // Back to fully resident.
        let out = t.observe(&poll(
            T0 + 15_000,
            Actor::User,
            vec![pm("a", 1_000, 1_000, 4096, T0 + 300_000)],
        ));
        assert_eq!(kinds(&out), vec![TransitionKind::PlacementChanged]);
    }

    #[test]
    fn state_survives_an_unload_so_a_reload_can_be_compared_to_it() {
        let mut t = Tracker::new();
        t.observe(&poll(T0, Actor::User, vec![pm("a", 100, 100, 4096, T0 + 5_000)]));
        t.observe_installed_sizes(&[("a".to_string(), 3_389_983_735)], T0);
        t.observe(&poll(T0 + 10_000, Actor::User, vec![]));

        let s = t.states().next().unwrap();
        assert_eq!(s.residency, Residency::NotLoaded);
        // No longer true, so no longer reported.
        assert_eq!(s.size_bytes, None);
        assert_eq!(s.context_length, None);
        assert_eq!(s.expires_at_ms, None);
        // Still true.
        assert_eq!(s.last_activity_ms, Some(T0));
        assert_eq!(s.installed_size_bytes, Some(3_389_983_735));
        assert_eq!(s.digest.as_deref(), Some("sha256:a"));

        // The reload is a Loaded transition that carries the old state as its
        // before, which is what expiry_reload needs to measure the gap.
        let out = t.observe(&poll(
            T0 + 20_000,
            Actor::User,
            vec![pm("a", 100, 100, 4096, T0 + 320_000)],
        ));
        assert_eq!(kinds(&out), vec![TransitionKind::Loaded]);
        let before = out[0].before.as_ref().unwrap();
        assert_eq!(before.residency, Residency::NotLoaded);
        assert_eq!(
            out[0].after.as_ref().unwrap().installed_size_bytes,
            Some(3_389_983_735),
            "the installed size is a property of the file, not of this load"
        );
    }

    #[test]
    fn a_digest_change_under_the_same_name_is_an_unload_and_a_load() {
        let mut t = Tracker::new();
        t.observe(&poll(T0, Actor::User, vec![pm("a", 100, 100, 4096, T0 + 300_000)]));
        let mut replaced = pm("a", 200, 200, 4096, T0 + 305_000);
        replaced.digest = Some("sha256:different".into());
        let out = t.observe(&poll(T0 + 5_000, Actor::User, vec![replaced]));
        assert_eq!(
            kinds(&out),
            vec![TransitionKind::Unloaded, TransitionKind::Loaded]
        );
        assert_eq!(
            t.states().next().unwrap().digest.as_deref(),
            Some("sha256:different")
        );
    }

    #[test]
    fn co_resident_names_the_others_and_never_the_subject() {
        let mut t = Tracker::new();
        t.observe(&poll(
            T0,
            Actor::User,
            vec![
                pm("a", 100, 100, 4096, T0 + 300_000),
                pm("b", 100, 100, 4096, T0 + 300_000),
            ],
        ));
        let out = t.observe(&poll(
            T0 + 5_000,
            Actor::User,
            vec![
                pm("a", 100, 100, 4096, T0 + 300_000),
                pm("b", 100, 100, 4096, T0 + 300_000),
                pm("c", 100, 100, 4096, T0 + 305_000),
            ],
        ));
        assert_eq!(kinds(&out), vec![TransitionKind::Loaded]);
        assert_eq!(out[0].model, "c");
        assert_eq!(out[0].co_resident, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn the_in_memory_log_is_capped_but_the_count_is_not() {
        let mut t = Tracker::new();
        let mut ts = T0;
        // Alternate load and unload until the cap is well past.
        while t.recorded() <= HISTORY_CAP as u64 + 10 {
            ts += 5_000;
            t.observe(&poll(ts, Actor::User, vec![pm("a", 100, 100, 4096, ts - 1_000)]));
            ts += 5_000;
            t.observe(&poll(ts, Actor::User, vec![]));
        }
        assert_eq!(t.history().count(), HISTORY_CAP);
        assert!(t.recorded() > HISTORY_CAP as u64);
        // The oldest kept entry is not the first one recorded.
        assert!(t.history().next().unwrap().id > 1);
    }

    #[test]
    fn a_poll_is_built_from_the_real_api_ps_shape() {
        let ps: crate::ollama_client::PsResponse = serde_json::from_str(
            r#"{"models":[{
                "name":"qwen3.5:4b","model":"qwen3.5:4b",
                "size":3151000000,"size_vram":3151000000,
                "digest":"sha256:abc","expires_at":"2026-11-13T09:26:44.305831-05:00",
                "context_length":4096,"details":{"family":"qwen35"}
            },{
                "size":1,"expires_at":"2026-11-13T09:26:44Z"
            }]}"#,
        )
        .unwrap();
        let p = Poll::from_ps(&ps, T0, Actor::User);
        assert_eq!(p.models.len(), 1, "an entry with no name has nothing to key on");
        let m = &p.models[0];
        assert_eq!(m.model, "qwen3.5:4b");
        assert_eq!(m.size_bytes, Some(3_151_000_000));
        assert_eq!(m.context_length, Some(4096));
        assert_eq!(m.expires_at_ms, rfc3339_to_ms("2026-11-13T09:26:44.305831-05:00"));
    }

    #[test]
    fn rfc3339_parses_what_ollama_sends_and_rejects_the_rest() {
        // The verbatim shape from the maintainer's host. 09:26:44.305 at -05:00
        // is 14:26:44.305 UTC, and the sub-millisecond digits are dropped, not
        // rounded.
        assert_eq!(
            rfc3339_to_ms("2026-11-13T09:26:44.305831-05:00"),
            Some(1794580004305)
        );
        // The Z form, and the same instant written two ways.
        assert_eq!(rfc3339_to_ms("2026-11-13T09:26:44Z"), Some(1794562004000));
        assert_eq!(
            rfc3339_to_ms("2026-11-13T14:26:44+05:00"),
            rfc3339_to_ms("2026-11-13T09:26:44Z")
        );
        assert_eq!(rfc3339_to_ms("1970-01-01T00:00:00Z"), Some(0));
        // Leap years, both kinds of century.
        assert_eq!(rfc3339_to_ms("2000-02-29T00:00:00Z"), Some(951_782_400_000));
        assert_eq!(rfc3339_to_ms("1900-03-01T00:00:00Z"), Some(-2_203_891_200_000));

        // Nothing partially understood is returned as a number.
        for bad in [
            "",
            "2026-11-13",
            "2026-11-13T09:26:44",          // no zone to resolve
            "2026-11-13 09:26:44",          // no zone to resolve
            "2026/11/13T09:26:44Z",
            "2026-11-13T09:26:44.Z",        // a dot with no digits
            "2026-13-01T00:00:00Z",         // month 13
            "2026-11-13T24:00:00Z",         // hour 24
            "2026-11-13T09:26:44+5:00",     // offset not two digits
            "2026-11-13T09:26:44ZZ",
        ] {
            assert_eq!(rfc3339_to_ms(bad), None, "{bad:?} must not parse");
        }
    }
}
