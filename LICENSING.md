# Licensing

Wicklee is published under two licences, split by directory.

## Open source — Apache License 2.0

Everything in this repository **except `src/site/`**. That includes:

- `agent/` — the agent binary that runs on each node
- `src/` (other than `src/site/`) — the local dashboard served at
  `localhost:7700`, including how WES and the other metrics are calculated
- `shared/`, `scripts/` and the build configuration needed to build the agent

Licence text: [`LICENSE`](LICENSE).

## Source-available — FSL-1.1-Apache-2.0

The public website only:

- `src/site/` — the wicklee.dev website

You may read, run and modify this code for any purpose other than offering it
to others as a competing product or service. Each release converts to Apache
2.0 four years after it is published.

Licence text: [`src/site/LICENSE`](src/site/LICENSE).

There is no hosted service and no control plane. The control-plane backend,
its screens and its deployment files were removed from the repository; they
remain in git history and keep the licence they were published under.

## Trademark

"Wicklee" and the Wicklee logo are trademarks of the project's owner. Neither
licence grants the right to use them. A fork or derived product must use a
different name and must not present itself as Wicklee.

## Questions

For anything these terms don't cover — a commercial licence for the website
code, or use of the name — contact jeff@wicklee.dev.
