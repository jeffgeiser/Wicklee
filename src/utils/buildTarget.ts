/**
 * Build-target flags.
 *
 * `VITE_BUILD_TARGET` is a build-time constant (set by `.env.agent`), so these
 * are dead-code-eliminated in bundles that don't need them. There are two
 * builds: the agent's local dashboard (`build:agent`) and the static public
 * site (`build`).
 */
export const IS_AGENT: boolean =
  (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

/**
 * True when this bundle is the local dashboard, which always talks to the agent
 * that served it. The website build has no dashboard and no backend.
 */
export const IS_LOCAL_HOST: boolean = IS_AGENT;

/** Public site. The agent build links out to it for pages it does not ship. */
export const SITE_URL = 'https://wicklee.dev';
