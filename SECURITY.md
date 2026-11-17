# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest nightly | Yes |
| Previous nightly | Best-effort |

We recommend always running the latest version via:

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
```

## Reporting a Vulnerability

If you discover a security vulnerability in Wicklee, please report it responsibly.

**Email:** security@wicklee.dev

Please include:
- A description of the vulnerability
- Steps to reproduce
- Impact assessment (if known)
- Any suggested fixes

**Do not** open a public GitHub issue for security vulnerabilities.

## Response Timeline

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 5 business days
- **Fix or mitigation:** Depends on severity; critical issues are prioritized for the next nightly release

## Scope

This policy covers:
- The Wicklee agent binary (`wicklee`)
- The install scripts (`install.sh`, `install.ps1`)
- The public site at `wicklee.dev`

Out of scope:
- Third-party dependencies (report upstream)
- Self-hosted modifications

There is no hosted fleet backend. `wicklee.dev` serves the site, the install
scripts and the discovery files as static files; it runs no API and holds no
telemetry. A report about a fleet control plane you are running yourself falls
under self-hosted modifications.

## Disclosure

We follow coordinated disclosure. We will work with you on a timeline for public disclosure after a fix is available. Credit is given to reporters unless they prefer to remain anonymous.
