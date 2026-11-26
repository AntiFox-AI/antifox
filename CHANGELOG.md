# Changelog

A summary of project releases. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [Semantic Versioning](https://semver.org/).

## v2.1.0

- **Project knowledge:** New tasks can upload authorization letters, test scopes, scoring rules, obtained credentials, and other documents. These documents are automatically included in the task context and can optionally be indexed for semantic search in the task knowledge base (supports Markdown, text, PDF, and Office files).
- **Security hardening:** Strengthened authentication, rate limiting, and credential handling; administrators must change their password on first login.
- **Multi-architecture images:** Release artifacts support `linux/amd64` and `linux/arm64`.
- Several LLM gateway compatibility and stability improvements.

## v2.0.3

- **Custom LLM session headers:** Each LLM configuration can define one HTTP header whose value is automatically set to the current session ID, supporting gateways such as OpenCode that use session IDs for prompt caching or sticky routing.
- **Global egress proxy:** All agent target traffic can leave through a single HTTP, HTTPS, or SOCKS5 egress proxy. Includes an availability test that reports the externally visible IP address.
- **Per-task egress selection:** New tasks can choose between the global proxy and a direct connection.
- **Confirmation triggers enrichment:** Human-confirmed findings are automatically converted into structured data and immediately prepared for delivery.
- **Report management:** Newly created reports include only confirmed findings by default, with status and CVSS details; report bodies reuse enriched finding data.
- **Automatic evidence annotations:** Evidence screenshot captions are generated from reproduction-step text and remain editable.
- **Finding detail improvements:** Status dropdowns, section headings, and one-click copying.
- **Traffic filtering fix:** Task filtering now combines with the task activity window, preventing traffic from multiple tests against the same target from being mixed together.
- The system settings page now uses a responsive two-column layout.

## v2.0.2

- **One-click updates:** Check for and install GitHub releases from the system settings page, with SHA-256 verification, atomic replacement, and automatic rollback on failure. Existing data is preserved.
- Release artifacts now include the `start.sh` daemon script and a systemd template.

## v2.0.1

- Reproduction steps now automatically link to captured real traffic packets.

## v2.0.0

- Evidence-driven delivery: reproduction steps are recorded in place, findings are presented as step-by-step kill chains, and every step is linked to real traffic; supports human-grade trilingual reports.
