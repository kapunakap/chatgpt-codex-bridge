# Network capability preflight

`networkAccess: true` is a privileged Local Codex capability because the existing trusted-network mode does two things for the real Codex process:

1. enables outbound command networking;
2. makes ordinary host developer authentication available, such as GitHub CLI / Git credentials and `SSH_AUTH_SOCK`.

Local Codex Guard therefore gates this capability **before the real Codex app-server process is created**.

## Flow

```text
ChatGPT requests networkAccess: true
        ↓
secure wrapper validates workspace profile
        ↓
HOST HOLD
network OFF → ON
host credentials FILTERED → AVAILABLE
        ↓
[a/A] approve        [r/x] reject or kill
        ↓                    ↓
spawn guarded Codex      no privileged Codex process
```

The secure wrapper writes a private pending approval under the Local Codex control-state directory. `local-codex-watch` renders it even though there is not yet a Codex thread/session. Approval and rejection decisions are host-side files written by the TUI.

The real Codex process is not spawned until the host returns `accept` or `acceptForSession`. `decline` exits without granting the capability. Cancelling the Local Codex job terminates the waiting wrapper and removes the pending request.

## Host-authority state

The entire Local Codex control-state directory is explicitly denied in the effective Codex filesystem profile in both network-disabled and network-enabled modes. The deny remains present even when the selected workspace is an ancestor such as the user's home directory.

This protects:

- adapter bearer token and configuration state;
- thread/job state;
- Guard pending approvals and decision files;
- job/Guard event state.

The capability gate runs in trusted host-side wrapper code *before* the real Codex sandboxed process exists, so Codex cannot read or write its own approval decision.

## Audit / visible events

The wrapper writes capability request/resolution metadata to the shared security audit log without prompts, outputs, or credentials.

It also emits sanitized `approval.requested` and `approval.resolved` visible events to the adapter. The Guard proxy starts its event sequence after those preflight events, preserving one ordered incremental `codex-status` stream.

## Scope

Approval is per Local Codex job/process. `acceptForSession` does not create a global machine grant. A later Local Codex job that again requests `networkAccess: true` must pass the host preflight again.

Native command/file-change approval gates still run after the capability preflight. Approving network access does not automatically approve later dangerous commands.