# Local Codex Guard / Watch

`local-codex-watch` is the host-side terminal UI for observing Local Codex jobs and approving privileged actions.

The implementation intentionally separates enforcement from rendering:

- `local-codex-secure.mjs` keeps the existing workspace/network security profile validation.
- `local-codex-guard-proxy.mjs` sits between the adapter and the real `codex app-server` process.
- The proxy forces Codex's native approval policy to `untrusted` with the host `user` as reviewer.
- Native `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` requests are held by the proxy and are **not** forwarded to the ChatGPT-facing adapter.
- The requested action remains blocked until the host writes an explicit decision through `local-codex-watch`.
- If the TUI exits or disconnects, a pending approval remains pending. The UI is not the enforcement boundary.

## Run

After installing or reinstalling the bridge:

```bash
local-codex-watch
```

The UI follows the existing design mocks: jobs on the left, conversation/activity in the center, and a job/capability inspector on the right. When an action is held, the center becomes the dominant approval view.

Controls:

```text
↑↓ / j k   select job
Tab        Conversation / Events / Raw log
a          approve once
A          approve for the current Codex session
r          reject
x          cancel the selected Local Codex job
q          quit
```

## Observable event boundary

The guard writes private per-session JSONL activity under the Local Codex state directory (`guard/events`). It records only externally observable data useful to the host UI, including:

- ChatGPT prompt text sent to Local Codex
- visible agent message deltas
- visible command/file-change item lifecycle and output
- turn lifecycle
- approval requests and decisions

Reasoning events and reasoning/encrypted fields are explicitly excluded from the guard event stream. Raw app-server stderr is not captured.

Guard state directories and files are created with user-only permissions (directories `0700`, files `0600`).

## Current security scope

This first Guard slice uses Codex's native `untrusted` approval policy, so commands that Codex classifies as requiring user approval are physically held before execution. Workspace writes still follow the existing bridge permission profile.

`networkAccess: true` retains the bridge's existing terminal-like developer-auth model. Guard makes network-capable commands reviewable through Codex's approval flow, but a future capability-specific phase should narrow network/credential access itself instead of treating broad process-level network access as the final model.
