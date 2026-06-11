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
use std::ops::ControlFlow;
use std::time::Duration;

/// Restart-on-failure backoff bounds.
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX:   Duration = Duration::from_secs(30);
/// A run that lasted at least this long is considered "healthy"; the next
/// failure resets backoff to the start (isolated hiccup, not a crash loop).
const HEALTHY_RUN:   Duration = Duration::from_secs(60);

/// Spawn `make()` under a supervisor that restarts it on panic or unexpected
/// return. Use for **pure infinite loops** that should never end on their own;
/// any return is treated as a fault and restarted. For tasks that can decide to
/// stop permanently (e.g. node removed from fleet), use [`supervise_until`].
///
/// Never returns until the runtime shuts down, so it's `tokio::spawn`ed
/// internally — call and forget.
pub(crate) fn supervise<F, Fut>(name: &'static str, make: F)
where
    F:   Fn() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    // Adapt a `-> ()` factory to the ControlFlow core: a clean return is a
    // fault here, so always ask to continue (restart).
    supervise_until(name, move || {
        let fut = make();
        async move {
            fut.await;
            ControlFlow::Continue(())
        }
    });
}

/// Like [`supervise`], but the task returns [`ControlFlow`]: `Break(())` means
/// "this was a deliberate, permanent stop — do NOT restart" (e.g. `cloud_push`
/// breaking on a 410-Gone when the node is removed from the fleet), while
/// `Continue(())` is treated as an unexpected exit and restarted with backoff.
/// A panic is always restarted.
pub(crate) fn supervise_until<F, Fut>(name: &'static str, make: F)
where
    F:   Fn() -> Fut + Send + 'static,
    Fut: Future<Output = ControlFlow<()>> + Send + 'static,
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
                Ok(ControlFlow::Break(())) => {
                    // Deliberate permanent stop — done supervising.
                    eprintln!("[supervisor] task '{name}' stopped intentionally; not restarting");
                    break;
                }
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
                Ok(ControlFlow::Continue(())) => {
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
        // Backoff after the first failure is 1s; wait well past it (CI slack).
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert!(
            runs.load(Ordering::SeqCst) >= 2,
            "supervisor should have restarted the task after the panic",
        );
    }

    #[tokio::test]
    async fn does_not_restart_on_intentional_break() {
        let runs = Arc::new(AtomicU32::new(0));
        let r = runs.clone();
        supervise_until("test-break", move || {
            let r = r.clone();
            async move {
                r.fetch_add(1, Ordering::SeqCst);
                ControlFlow::Break(()) // deliberate permanent stop
            }
        });
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert_eq!(
            runs.load(Ordering::SeqCst), 1,
            "an intentional Break must not be restarted",
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
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert!(
            runs.load(Ordering::SeqCst) >= 2,
            "supervisor should restart a task that returns cleanly",
        );
    }
}
