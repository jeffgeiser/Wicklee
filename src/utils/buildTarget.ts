/**
 * Build-target flags and the local-agent host check.
 *
 * `VITE_BUILD_TARGET` is a build-time constant (set by `.env.agent`), so these
 * are dead-code-eliminated in bundles that don't need them.
 *
 * Why `IS_LOCAL_HOST` lives here: it had been copy-pasted as a bare hostname
 * check into five modules (App, Overview, NodesList, AIInsights, TracesView).
 * Each copy meant "we are the agent binary served from localhost:7700, so talk
 * to the local agent instead of the cloud", and five copies of that meaning
 * drift. It is decided once, here.
 */
export const IS_AGENT: boolean =
  (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

/**
 * Permanently false. The demo build was removed in transition step 5 along with
 * `src/demo/`, `.env.demo` and the `build:demo` script.
 *
 * It stays exported because three modules under `src/cloud/` still read it
 * (`AddNodeModal`, `TeamManagement`, `APIKeysView`), and `src/cloud/` is frozen
 * until step 7 decides what happens to it — removing links to it is in scope,
 * editing it is not. Typed `boolean` rather than `false` so those call sites do
 * not narrow to dead branches before that decision is made. Delete this and its
 * three readers together.
 */
export const IS_DEMO: boolean = false;

/**
 * True when this bundle is talking to a local agent.
 *
 * The agent build is always local: it is only ever served by the agent
 * binary, whatever hostname the browser used to reach it (LAN address, SSH
 * tunnel, reverse proxy). Making that a build-time constant also lets Rollup
 * fold every `isLocalHost ? local : cloud` branch, which is what keeps the
 * cloud-only UI (src/cloud) and the marketing site (src/site) out of the
 * agent bundle. The hostname check remains for the cloud build under
 * `vite dev`, where localhost means "use the agent on this machine".
 */
export const IS_LOCAL_HOST: boolean =
  IS_AGENT ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1';

/** Public site. The agent build links out to it for pages it does not ship. */
export const SITE_URL = 'https://wicklee.dev';
