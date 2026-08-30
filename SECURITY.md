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
- the entire Local Codex control-state directory is an unconditional filesystem deny for the real Codex process in both hardened and network-enabled modes. This protects the adapter token, configuration/thread/job state, Guard pending approvals and decision files, and private event state even if the selected workspace is an ancestor such as the user's home directory;
- the Local Codex Guard proxy sits below the adapter and above the real Codex app-server. Approval prompts default to disabled through `LOCAL_CODEX_APPROVAL_MODE=off`; `host` mode forces native approvals to the host user and withholds command/file-change requests until explicitly approved or rejected;
- in `host` mode, the TUI is not the enforcement boundary: closing or disconnecting `local-codex-watch` does not approve a held action;
- `networkAccess: true` is an explicit per-thread opt-in to broad direct command network access and terminal-like host developer access. Network-enabled jobs may read ordinary host user files and inherit developer authentication such as `gh` configuration, Keychain-backed Git credentials, `SSH_AUTH_SOCK`, and ambient developer environment variables, but the Local Codex control-state carve-out remains denied. With the default approval mode, this capability is granted without another host prompt;
- even for network-enabled jobs, `LOCAL_CODEX_*` and `TUNNEL_CLIENT_*` variables are stripped before the real Codex process starts, in addition to the filesystem-level control-state deny;
- native CLI resume from the monitor is limited to terminal adapter-owned threads and requires proof of access to the private adapter token. The secure wrapper reconstructs the selected job's workspace/network profile, keeps the control-state deny and environment filtering, disables the job-scoped ChatGPT Browser transport, and chooses native CLI approval policy from `LOCAL_CODEX_APPROVAL_MODE`;
- prompts, responses, raw stderr, credentials, and reasoning content are excluded from the shared adapter audit log;
- the Guard's private visible-event stream is intentionally different from the audit log: it may contain ChatGPT prompts, visible Codex messages, commands, command output, file-change metadata, and approval state so the host TUI and incremental `codex-status` polling can reconstruct activity. Guard/event directories are user-only and event files are mode `0600`;
- hidden reasoning events, reasoning fields, and encrypted reasoning payloads are explicitly excluded from the Guard stream and are filtered again before events are exposed through the adapter.

The selected folder remains the application write boundary, except that the Local Codex control-state directory is always carved out and denied even if it sits below that folder. For network-disabled jobs, the additional read and environment restrictions reduce accidental credential exposure. For network-enabled jobs, treat Local Codex like the Codex/terminal session you already trust on that machine for ordinary host data and developer credentials; bridge authority state remains inaccessible. The default `off` approval mode removes the additional human gate. Set `LOCAL_CODEX_APPROVAL_MODE=host` and restart the tunnel if the machine should require network and native command/file approvals. Guard approvals do not turn broad `networkAccess: true` into a fine-grained network/credential sandbox. Do not enable networking for repositories or prompts you do not trust.

## Reporting a vulnerability

Please do not publish exploit details in a normal GitHub issue.

If GitHub's **Report a vulnerability** option is available on the repository's Security tab, use it to open a private vulnerability report. If private vulnerability reporting is unavailable, open a minimal issue that says you have a security report and request a private contact channel; do not include exploit steps, secrets, or sensitive logs in the public issue.

Include the affected commit/version, operating system, Codex CLI version, a concise impact description, and the smallest safe reproduction you can provide.

## Accidental credential exposure

If you believe a real API key, tunnel credential, bearer token, or other secret has been exposed, revoke or rotate it first. Removing it from a later commit is not sufficient because Git history may retain earlier content.
