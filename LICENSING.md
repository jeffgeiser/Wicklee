# Licensing

Wicklee is published under two licences, split by directory.

## Open source — Apache License 2.0

Everything in this repository **except the directories listed in the next
section**. That includes:

- `agent/` — the agent binary that runs on each node
- `src/` (other than `src/cloud/` and `src/site/`) — the local dashboard served
  at `localhost:7700`, including how WES and the other metrics are calculated
- `shared/`, `scripts/`, `deploy/grafana/` and the build configuration needed
  to build the agent

Licence text: [`LICENSE`](LICENSE).

## Source-available — FSL-1.1-Apache-2.0

The fleet control plane and the public website:

- `cloud/` — the control-plane backend
- `src/cloud/` — control-plane screens (organizations, SSO, audit log, SLOs,
  chargeback, fleet history and the rest of the paid fleet features)
- `src/site/` — the wicklee.dev website
- `deploy/helm/`, `deploy/self-hosted/` — control-plane deployment

You may read, run, modify and self-host this code for any purpose other than
offering it to others as a competing GPU fleet monitoring service. Each release
converts to Apache 2.0 four years after it is published.

Licence text: [`cloud/LICENSE`](cloud/LICENSE).

## Trademark

"Wicklee" and the Wicklee logo are trademarks of the project's owner. Neither
licence grants the right to use them. A fork or derived product must use a
different name and must not present itself as Wicklee.

## Questions

For anything these terms don't cover — a commercial licence for the control
plane, or use of the name — contact jeff@wicklee.dev.
