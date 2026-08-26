# Security Policy

## Supported versions

Until tagged releases are published, only the current `main` branch is supported. Use Codex CLI 0.138.0 or newer and prefer the latest stable release because Codex permission profiles are beta and may change.

## Threat model

This project deliberately lets a ChatGPT tool ask a local Codex worker to inspect and modify an explicitly selected existing folder. The security boundary is designed to prevent that worker from gaining broader machine or network access by default:

- the MCP adapter binds only to loopback and requires a generated bearer token;
- OpenAI Secure MCP Tunnel makes the outbound connection; no inbound public port is opened;
- each new thread pins one canonical working directory selected through the authenticated MCP tool; replies cannot change it;
- the Codex permission profile allows writes only inside that directory, denies sibling user trees, mounted volumes, and temporary trees, keeps `.codex` read-only, denies common credential files, and disables command network access by default;
- `.git` is writable inside the selected directory because Git fetch, clone, commit, and related operations require metadata writes;
- `networkAccess: true` is an explicit per-thread opt-in to broad direct command network access without a domain allowlist; replies inherit until explicitly disabled;
- the Codex app-server receives a small environment allowlist instead of the launcher's ambient environment;
- Codex command subprocesses inherit only the core environment with secret-name filtering enabled;
- prompts, responses, raw stderr, credentials, and reasoning content are excluded from the adapter audit log.

The selected folder itself is intentionally available to Codex except for explicit deny rules. Do not put secrets there under arbitrary filenames and assume the adapter will discover them automatically. Network-enabled jobs can transmit any readable data, so use the narrowest relevant folder and enable networking only when the task requires it.

## Reporting a vulnerability

Please do not publish exploit details in a normal GitHub issue.

If GitHub's **Report a vulnerability** option is available on the repository's Security tab, use it to open a private vulnerability report. If private vulnerability reporting is unavailable, open a minimal issue that says you have a security report and request a private contact channel; do not include exploit steps, secrets, or sensitive logs in the public issue.

Include the affected commit/version, operating system, Codex CLI version, a concise impact description, and the smallest safe reproduction you can provide.

## Accidental credential exposure

If you believe a real API key, tunnel credential, bearer token, or other secret has been exposed, revoke or rotate it first. Removing it from a later commit is not sufficient because Git history may retain earlier content.
