# Security Policy

## Supported versions

Until tagged releases are published, only the current `main` branch is supported. Use Codex CLI 0.138.0 or newer and prefer the latest stable release because Codex permission profiles are beta and may change.

## Threat model

This project deliberately lets a ChatGPT tool ask a local Codex worker to inspect and modify an explicitly selected existing folder. The security boundary is designed to prevent that worker from gaining broader machine or network access by default:

- the MCP adapter binds only to loopback and requires a generated bearer token;
- OpenAI Secure MCP Tunnel makes the outbound connection; no inbound public port is opened;
- each new thread pins one canonical working directory selected through the authenticated MCP tool; replies cannot change it;
- network-disabled jobs keep the hardened Codex permission profile: writes stay inside the selected directory, sibling user trees, mounted volumes, and temporary trees are denied, `.codex` stays read-only, and common credential files are denied;
- `.git` is writable inside the selected directory because Git fetch, clone, commit, and related operations require metadata writes;
- the Local Codex Guard proxy sits below the adapter and above the real Codex app-server, forces native Codex approvals to the host user, and withholds command/file-change approval requests until the host explicitly approves or rejects them;
- the TUI is not the enforcement boundary: closing or disconnecting `local-codex-watch` does not approve a held action;
- `networkAccess: true` is an explicit per-thread opt-in to broad direct command network access and terminal-like host developer access. Network-enabled jobs may read host user files and inherit ordinary developer authentication such as `gh` configuration, Keychain-backed Git credentials, `SSH_AUTH_SOCK`, and ambient developer environment variables;
- even for network-enabled jobs, `LOCAL_CODEX_*` and `TUNNEL_CLIENT_*` variables are stripped before the real Codex process starts so the bridge's own adapter/tunnel control credentials are not exposed;
- prompts, responses, raw stderr, credentials, and reasoning content are excluded from the shared adapter audit log;
- the Guard's private visible-event stream is intentionally different from the audit log: it may contain ChatGPT prompts, visible Codex messages, commands, command output, file-change metadata, and approval state so the host TUI and incremental `codex-status` polling can reconstruct activity. Guard/event directories are user-only and event files are mode `0600`;
- hidden reasoning events, reasoning fields, and encrypted reasoning payloads are explicitly excluded from the Guard stream and are filtered again before events are exposed through the adapter.

The selected folder remains the write boundary. For network-disabled jobs, the additional read and environment restrictions reduce accidental credential exposure. For network-enabled jobs, treat Local Codex like the Codex/terminal session you already trust on that machine: it can use readable host data and developer credentials while carrying out the requested network task. Guard approvals improve control over actions Codex asks to elevate, but they do not turn the existing broad `networkAccess: true` process capability into a fine-grained network/credential sandbox. Do not enable networking for repositories or prompts you do not trust.

## Reporting a vulnerability

Please do not publish exploit details in a normal GitHub issue.

If GitHub's **Report a vulnerability** option is available on the repository's Security tab, use it to open a private vulnerability report. If private vulnerability reporting is unavailable, open a minimal issue that says you have a security report and request a private contact channel; do not include exploit steps, secrets, or sensitive logs in the public issue.

Include the affected commit/version, operating system, Codex CLI version, a concise impact description, and the smallest safe reproduction you can provide.

## Accidental credential exposure

If you believe a real API key, tunnel credential, bearer token, or other secret has been exposed, revoke or rotate it first. Removing it from a later commit is not sufficient because Git history may retain earlier content.