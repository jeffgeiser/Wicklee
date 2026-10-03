# src/cloud — fleet control-plane UI

Screens and hooks that only work against the Wicklee control plane: Clerk
sign-in and organizations, Paddle checkout, and the paid fleet features (audit
log, SLOs, SSO, webhooks, model governance, chargeback, idle waste, capacity
planning, fleet history charts).

Nothing in this folder ships in the agent build (`npm run build:agent`).
Code outside it may import from here only behind `IS_AGENT` from
`utils/buildTarget`, written so the bundler can drop the import:

- lazy components: `IS_AGENT ? Absent : React.lazy(() => import('./cloud/X'))`
- hooks: a module-scope alias, as in `components/AIInsights.tsx`

A bare `React.lazy(() => import(...))` is kept by Rollup even when unused.
After changing an import, run the agent build and check that no `src/cloud`
module appears in its output.
