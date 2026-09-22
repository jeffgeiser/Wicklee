/**
 * User Timing marks for the load-diagnostics overlay (public/perf.js, shown
 * when a URL carries `?perf=1`). Marks are a few bytes each and sit in the
 * browser's own performance timeline, so they cost nothing for visitors who
 * never open the overlay. Names are prefixed `wk:` so the overlay can pick
 * them out from anything third-party scripts record.
 */
export function perfMark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    // Older engines without User Timing — nothing to record.
  }
}
