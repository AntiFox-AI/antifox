# Changelog

[中文](CHANGELOG.md) | English

A summary of version updates for this project. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [SemVer](https://semver.org/).

## v2.0.3

- **Custom LLM session header**: each LLM profile can set one HTTP header whose value is automatically the current session ID — for gateways like opencode that do prompt caching / sticky routing per session.
- **Global egress proxy**: all agents' target traffic can go out through a single egress proxy (http/https/socks5) to hide the source IP or route through a jump host; includes a "Test availability" check (echoes the egress IP through the proxy).
- **Per-task egress choice**: when creating a task, choose whether it uses the global proxy or connects directly.
- **Enrich on confirm**: once a vulnerability is manually confirmed, it is automatically enriched into structured data — ready to deliver as soon as it's confirmed.
- **Report management**: new reports list only confirmed vulnerabilities by default (showing status / CVSS); the body reuses the already-enriched data.
- **Auto-filled evidence captions**: evidence screenshot captions are generated from the reproduction step text, and remain editable.
- **Vulnerability detail polish**: status dropdown, section headings, one-click copy.
- **Traffic task-filter fix**: filtering by task now also applies the task's activity time window, so repeated tests against the same target no longer mix up traffic.
- The system settings page now uses a responsive two-column layout.

## v2.0.2

- **One-click update**: check for and install new GitHub releases from the system settings page (SHA256 verification / atomic swap / automatic rollback on failure); your data is not affected.
- Release packages now include the `start.sh` supervisor script and a systemd template.

## v2.0.1

- Reproduction steps are automatically linked to the real traffic packets when saved.

## v2.0.0

- Evidence-driven delivery: the reproduction process is saved in place, the findings page shows exploit chains step by step, and each step is linked to real traffic packets; human-grade reports in three languages.
