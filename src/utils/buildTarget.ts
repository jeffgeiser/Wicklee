/**
 * Build-target flags and the local-agent host check.
 *
 * `VITE_BUILD_TARGET` is a build-time constant (set by `.env.agent` /
 * `.env.demo`), so these are dead-code-eliminated in bundles that don't
 * need them.
 *
 * Why `IS_LOCAL_HOST` lives here: it had been copy-pasted as a bare
 * hostname check into five modules (App, Overview, NodesList, AIInsights,
 * TracesView). Each copy meant "we are the agent binary served from
 * localhost:7700, so talk to the local agent instead of the cloud" — but
 * the demo bundle is *also* static-served, and previewing it on
 * localhost (`npm run build:demo && serve dist-demo`) made every copy
 * answer `true`. The demo then opened `ws://localhost:PORT/ws`, fetched
 * `/api/metrics` outside the demo fetch shim, and rendered an empty
 * dashboard reading "Connecting to local agent…" — while the synthetic
 * fleet stream ran correctly underneath. On a real hostname
 * (demo.wicklee.dev, *.hf.space) the same bundle worked, so the break
 * only ever showed up in local preview — exactly where it gets verified
 * before deploying.
 *
 * The demo is never the local agent, so it is excluded here once.
 */
export const IS_AGENT: boolean =
  (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

export const IS_DEMO: boolean =
  (import.meta.env.VITE_BUILD_TARGET as string) === 'demo';

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
  (!IS_DEMO &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1'));

/** Public site. The agent build links out to it for pages it does not ship. */
export const SITE_URL = 'https://wicklee.dev';
