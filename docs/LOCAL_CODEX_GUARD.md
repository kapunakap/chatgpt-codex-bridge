# Local Codex Guard / Watch

`local-codex-watch` is the host-side terminal UI for observing Local Codex jobs and, when enabled, approving privileged actions.

The implementation intentionally separates enforcement from rendering:

- `local-codex-secure.mjs` keeps the existing workspace/network security profile validation.
- `local-codex-guard-proxy.mjs` sits between the adapter and the real `codex app-server` process.
- `LOCAL_CODEX_APPROVAL_MODE=off` is the default: the proxy forces `approvalPolicy: never` and automatically accepts unexpected native approval requests without creating pending files.
- `LOCAL_CODEX_APPROVAL_MODE=host` restores the previous behavior: the proxy forces `untrusted` with the host `user` as reviewer and holds native command/file requests below the ChatGPT-facing adapter.
- In `host` mode, the requested action remains blocked until the host writes an explicit decision through `local-codex-watch`; closing the TUI does not approve it.

## Run

After installing or reinstalling the bridge:

```bash
local-codex-watch
```

The generated config contains `LOCAL_CODEX_APPROVAL_MODE=off`. Change it to `host` and restart `local-codex-tunnel` to enable approval prompts. Unknown values fail before Codex starts.

The normal screen is labeled LOCAL CODEX MONITOR and follows the existing design mock: jobs on the left, conversation/activity in the center, and a job/capability inspector on the right. It uses a bounded three-pane frame, separate view and shortcut rows, and repaints from the real terminal dimensions so resizing does not wrap or corrupt the display. When an action is held, the center becomes the dominant approval view.

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

The `a`, `A`, `r`, and approval-detail controls are active only in `host` mode when an approval is pending.

The monitor labels prompt provenance honestly. An exact caller-supplied ChatGPT conversation title is shown as `CHATGPT`; otherwise the App Server thread name is shown as `CODEX (fallback)`, with the persisted prompt preview as the final `PROMPT (fallback)`. Current ChatGPT connector metadata does not expose its conversation title automatically, so the monitor never relabels a generated fallback as exact.

`o` works only after a job is terminal and has a saved thread ID. It leaves the monitor screen, authenticates a dedicated interactive-resume path with the private adapter token, and runs the native Codex TUI under the same workspace/network profile and `off|host` approval mode. On exit it restores the monitor, its selection, and the current terminal size. ChatGPT Browser context is not transferable; browser-enabled jobs require a second `o` after the warning. Activity added from the native TUI belongs to Codex history and is not appended to the already-terminal bridge job event file.

Long command output is collapsed by default so the conversation stays readable; `l` expands it. Search applies to the same sanitized visible event stream used by the three views. Follow mode is on by default; turning it off freezes the current event sequence while new events continue to be recorded.

The selected job remains selected by job ID when its status changes and the list reorders. Active and queued jobs stay first; terminal jobs follow in most-recent order. Completed, failed, cancelled, and timed-out jobs keep their persisted job event history visible. Pending approvals affect the UI only while their job or Guard session is active, and the Guard proxy clears unresolved approval files when its process exits.

The Jobs pane's `AGE` value is relative: active and queued jobs count from their start, while terminal jobs count from their finish or last update. It uses compact seconds, minutes, hours, or days. The Inspector's `ELAPSED` field remains the execution duration.

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

Workspace writes always follow the existing bridge permission profile. Approval mode changes host prompts, not filesystem or network sandbox rules.

In the default `off` mode, command/file actions run without host prompts and an explicitly selected `networkAccess: true` capability immediately enables the bridge's terminal-like host read/developer-auth model. In `host` mode, network access is held before process start and native command/file approvals are held during the job. Neither mode turns broad network and credential access into a fine-grained capability sandbox.
