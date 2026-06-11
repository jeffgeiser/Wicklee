//! Task supervision — keep critical background loops alive.
//!
//! Several agent subsystems run as fire-and-forget `tokio::spawn` loops
//! (metrics broadcast, the runtime harvesters, cloud push). If one panics —
//! say a malformed sensor read or a parsing edge case — tokio swallows the
//! panic and that task simply ends, leaving the agent "running" while a whole
//! subsystem goes silent: stale or missing metrics, no error surfaced.
//!
//! [`supervise`] wraps such a loop so a panic (or unexpected clean return) is
//! logged loudly and the task is restarted, with exponential backoff to avoid
//! a hot crash-loop. The supervised future is produced by a factory closure so
//! it can be reconstructed on each restart; callers clone any captured state
//! (Arcs, channels, config) in the factory prelude — the compiler enforces
//! that every capture is satisfied, so a restart is behaviorally identical to
//! the first run.

use std::future::Future;
use std::time::Duration;

/// Restart-on-failure backoff bounds.
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX:   Duration = Duration::from_secs(30);
/// A run that lasted at least this long is considered "healthy"; the next
/// failure resets backoff to the start (isolated hiccup, not a crash loop).
const HEALTHY_RUN:   Duration = Duration::from_secs(60);

/// Spawn `make()` under a supervisor that restarts it on panic or unexpected
/// return. Never returns until the runtime shuts down (the supervising task is
/// itself cancelled), so it's `tokio::spawn`ed internally — call and forget.
pub(crate) fn supervise<F, Fut>(name: &'static str, make: F)
where
    F:   Fn() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        let mut backoff = BACKOFF_START;
        loop {
            let started = std::time::Instant::now();
            // Run the task as its own child so a panic surfaces as a JoinError
            // here instead of unwinding the supervisor.
            let outcome = tokio::spawn(make()).await;
            let ran_for = started.elapsed();

            match outcome {
                Err(e) if e.is_cancelled() => {
                    // Runtime is shutting down — stop supervising.
                    break;
                }
                Err(_) => {
                    eprintln!(
                        "[supervisor] task '{name}' PANICKED after {:?}; restarting in {:?}",
                        ran_for, backoff,
                    );
                }
                Ok(()) => {
                    // Infinite loops shouldn't return; if one does, treat it as
                    // a fault and restart so the subsystem doesn't go dark.
                    eprintln!(
                        "[supervisor] task '{name}' exited after {:?}; restarting in {:?}",
                        ran_for, backoff,
                    );
                }
            }

            tokio::time::sleep(backoff).await;
            backoff = if ran_for >= HEALTHY_RUN {
                BACKOFF_START // was healthy; isolated failure
            } else {
                (backoff * 2).min(BACKOFF_MAX) // fast failure; escalate
            };
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn restarts_after_a_panic() {
        let runs = Arc::new(AtomicU32::new(0));
        let r = runs.clone();
        supervise("test-panic", move || {
            let r = r.clone();
            async move {
                let n = r.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    panic!("first run panics");
                }
                // Second run: sleep long enough to be observed as alive.
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
        // Backoff after the first failure is 1s; wait past it.
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert!(
            runs.load(Ordering::SeqCst) >= 2,
            "supervisor should have restarted the task after the panic",
        );
    }

    #[tokio::test]
    async fn restarts_after_clean_return() {
        let runs = Arc::new(AtomicU32::new(0));
        let r = runs.clone();
        supervise("test-return", move || {
            let r = r.clone();
            async move {
                r.fetch_add(1, Ordering::SeqCst);
                // Returns immediately — supervisor must restart it.
            }
        });
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert!(
            runs.load(Ordering::SeqCst) >= 2,
            "supervisor should restart a task that returns cleanly",
        );
    }
}
