# Local Codex end-to-end observability

Local Codex v3.6 adds a private observability layer around the existing adapter without changing its scheduler, sandbox, worktree, approval, browser, or credential boundaries.

## Instrumented path

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client
  -> local-codex-trace-proxy (public loopback endpoint, default 127.0.0.1:8765)
  -> local-codex-adapter (private loopback endpoint, default 127.0.0.1:8766)
  -> local-codex-instrumented
  -> local-codex-secure
  -> Codex app-server
```

The trace proxy owns the job trace ID. The instrumented Codex wrapper observes only JSON-RPC method names, IDs, status values, process exit metadata, and timing. It forwards stdio byte-for-byte and never records request params, prompts, model output, file contents, reasoning, or stderr.

For managed worktrees the adapter returns the planned execution folder in the accepted job snapshot. The proxy stores only a SHA-256 folder fingerprint and a private short-lived fingerprint -> trace mapping. The Codex wrapper resolves that mapping and emits app-server/thread/turn lifecycle events under the same trace ID.

## Private files

By default:

```text
~/Library/Application Support/local-codex-tunnel/
  trace-events.jsonl
  trace-events.jsonl.1
  trace-events.jsonl.2
  trace-events.jsonl.3
  traces/
    jobs/<jobId>.json
    folders/<folder-fingerprint>.json
```

Directories are mode `0700`; trace files/state are mode `0600`. The event log rotates at 5 MiB and retains three rotations by default.

The structured log uses a strict metadata allowlist. It does not accept or persist arbitrary caller objects. Public/sanitized receipts contain no absolute private paths, prompts, reasoning, file contents, bearer tokens, tunnel credentials, ambient developer credentials, account IDs, or raw tunnel configuration.

## Stable stages

A healthy job can produce these correlated stages:

```text
mcp.request.received
mcp.request.validated
job.accepted
job.queued                  # when applicable
job.started
codex.process.started
codex.app_server.initialize.requested
codex.app_server.ready
codex.thread.requested
codex.thread.started
codex.turn.requested
codex.turn.submitted
codex.turn.started
codex.turn.completed
job.cleanup.started
job.cleanup.completed
job.result.persisted
status.poll.received
job.terminal.observed
mcp.response.sent
```

Failure-specific events include `mcp.transport.failed`, `codex.app_server.failed`, `codex.thread.failed`, `codex.turn.submit_failed`, `codex.turn.failed`, and `job.polling_expired`.

A completed runtime with no later `job.terminal.observed` is intentionally distinguishable: Codex finished locally, but ChatGPT never observed the terminal result through `codex-status`.

## Error taxonomy

Receipts normalize infrastructure aliases to stable codes while retaining already-stable adapter codes. Important examples:

```text
transport_unreachable
mcp_validation_failed
queue_full
polling_expired
codex_unavailable
app_server_start_failed
thread_start_failed
turn_start_failed
turn_failed
execution_timed_out
process_cleanup_failed
storage_failed
result_persist_failed
browser_host_context_unavailable
cancelled
interrupted
```

Raw app-server stderr is not copied into the structured trace.

## Readiness

`/healthz` stays cheap and reports the trace proxy process plus whether the local adapter responds.

`/readyz` preserves adapter readiness fields and adds dependency state for:

- trace proxy
- adapter
- trace storage
- Codex CLI
- scheduler saturation
- runtime cleanup fence
- polling lease
- Browser backend
- tunnel-client health endpoint when observable

`integrationStatus=end_to_end_ready` means the local execution stack and the tunnel-client health endpoint are both healthy. `local_ready_tunnel_unverified` is intentionally weaker and must not be treated as proof that ChatGPT traversed the tunnel.

## Doctor

Run:

```bash
local-codex-doctor
```

It checks configuration readability, private token permissions, proxy health, adapter readiness, trace storage, scheduler capacity, runtime cleanup health, polling lease, tunnel-client health, Codex CLI availability, private state read/write, and an authenticated MCP initialize/tools-list round trip.

A failed required check returns non-zero. The doctor explicitly cannot prove that a real ChatGPT turn reached the tunnel.

## Harmless local canary

Run:

```bash
local-codex-canary
```

The canary creates a temporary private workspace, submits exactly:

```text
Reply with exactly LOCAL_CODEX_CANARY_OK
```

with `worktree=false`, `networkAccess=false`, and `browserAccess=false`, polls until terminal, requires the exact expected answer, fetches the sanitized trace receipt, then removes the temporary workspace. It exercises proxy -> adapter -> queue/start -> Codex app-server -> turn -> cleanup -> persisted result -> status polling.

A local canary proves the complete local execution path. It still does not prove the ChatGPT host or OpenAI tunnel path.

## Real ChatGPT-host canary

After installing/restarting v3.6, refresh the **Local Codex** app tools in ChatGPT and start a fresh conversation. Execute this from the actual ChatGPT app:

```text
Use Local Codex's codex-folders tool to locate a harmless existing folder. Submit one Codex job with a unique requestId and prompt `Reply with exactly CHATGPT_CODEX_CANARY_OK`, with networkAccess=false and browserAccess=false. Poll codex-status with waitMs=20000 until terminal. Do not resubmit with a different requestId. Then call codex-trace-receipt with the returned jobId and show me the sanitized receipt.
```

Mandatory pass conditions:

1. `codex` returns a job ID and `traceId`.
2. Repeated `codex-status` calls preserve that same `traceId`.
3. Terminal status is `completed` and content is exactly `CHATGPT_CODEX_CANARY_OK`.
4. `codex-trace-receipt` reports `pass: true`.
5. The receipt includes the host-facing MCP stages, app-server/thread/turn stages, cleanup, result persistence, polling, and `job.terminal.observed`.
6. The receipt includes observability version, adapter version/schema fingerprint, and the installed source commit when available.
7. No private path, prompt, response content, token, credential, account identifier, or tunnel config appears in the receipt.

This is the acceptance that proves the real ChatGPT -> Secure MCP Tunnel -> local bridge -> Codex -> ChatGPT path.

## Render a receipt locally

For any known job ID:

```bash
local-codex-receipt <jobId>
```

This works from the private trace log even when the trace proxy is not running.

## Security boundary

Observability is passive with respect to the existing execution authority. It does not widen filesystem permissions, network access, Browser access, worktree scope, host approvals, or credential access. The proxy listens only on loopback and preserves the same bearer-token requirement for MCP and authenticated diagnostics. The adapter remains on a separate loopback-only port that is not configured in tunnel-client.
