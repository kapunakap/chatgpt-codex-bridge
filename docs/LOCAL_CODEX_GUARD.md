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
f          toggle live follow / freeze current event cursor
/          search the selected job's visible event stream
l          expand/collapse long command output
d          toggle sanitized approval details/raw context
a          approve once
A          approve for the current Codex session/job
r          reject
x          cancel the selected Local Codex job
q          quit
```

Long command output is collapsed by default so the conversation stays readable; `l` expands it. Search applies to the same sanitized visible event stream used by the three views. Follow mode is on by default; turning it off freezes the current event sequence while new events continue to be recorded.

The approval view shows the exact action and reason plus the effective security context that can be inferred safely at the host boundary: network state/delta, possible remote write, host credential availability, workspace writes, external target, and any additional permissions supplied by Codex. `d` reveals the full sanitized native approval request for inspection.

## Observable event boundary

The guard writes private per-session JSONL activity under the Local Codex state directory (`guard/events`). It records only externally observable data useful to the host UI, including:

- ChatGPT prompt text sent to Local Codex
- visible agent message deltas
- visible command/file-change item lifecycle and output
- turn lifecycle
- approval requests and decisions

Reasoning events and reasoning/encrypted fields are explicitly excluded from the guard event stream. Raw app-server stderr is not captured.

Guard state directories and files are created with user-only permissions (directories `0700`, files `0600`).

The proxy also mirrors that **same sanitized event object** into a reserved local app-server notification. The adapter associates it with the current job, filters it again, and persists a job-indexed mirror under `job-events/`. It does not independently parse raw Codex logs.

## Incremental events from ChatGPT

`codex-status` can now be used for either ordinary completion polling or incremental visible activity.

For incremental mode:

1. Call `codex-status` with `afterEventSeq: 0` and normally `waitMs: 20000`.
2. The call returns when a new visible event arrives, the job becomes terminal, or the wait expires.
3. Read `events` and save `nextEventSeq`.
4. Pass that value back as `afterEventSeq` on the next call.

`eventLimit` defaults to 50 and is bounded to 100. `eventsDone: true` means the job is terminal and the returned cursor has consumed every saved visible event.

This keeps the normal Local Codex background-job contract: ChatGPT starts work once, then polls the same job ID. It no longer has to wait for the final answer to understand visible progress.

## Current security scope

This first Guard slice uses Codex's native `untrusted` approval policy, so commands that Codex classifies as requiring user approval are physically held before execution. Workspace writes still follow the existing bridge permission profile.

`networkAccess: true` retains the bridge's existing terminal-like developer-auth model. Guard makes network-capable commands reviewable through Codex's approval flow, but a future capability-specific phase should narrow network/credential access itself instead of treating broad process-level network access as the final model.
