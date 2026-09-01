# ChatGPT Codex Bridge
## Overview
![ChatGPT.com → OpenAI Secure MCP Tunnel → Your laptop or server running Codex CLI](docs/chatgpt-codex-bridge.svg)
Run Codex on your Mac from ChatGPT through OpenAI Secure MCP Tunnel.

This is an unofficial local bridge. It keeps the MCP backend private and opens only outbound HTTPS through OpenAI's official `tunnel-client`.

## ChatGPT side
<img width="603" height="630" alt="Screenshot 2026-08-27 at 12 48 51 AM" src="https://github.com/user-attachments/assets/4c05b31e-9207-41fc-9fb2-3966ff4b60e3" />

## Local side
<img width="876" height="186" alt="Screenshot 2026-08-27 at 1 05 59 AM" src="https://github.com/user-attachments/assets/57e65d51-061e-42b3-a5b5-c352958d5074" />

(not the same request as on ChatGPT side)
## Watch it working

Want to see ChatGPT reaching your Mac? Open the structured terminal monitor:

```bash
local-codex-watch
```

It keeps the selected job visible across running and terminal states, shows persisted conversation activity, and lists compact relative `AGE` values while the Inspector keeps exact execution `ELAPSED` time. The center pane and Inspector identify the prompt source as an exact `CHATGPT` title when supplied, or as a clearly marked `CODEX (fallback)` / `PROMPT (fallback)`. Press `o` on a terminal job to resume its saved thread in Codex CLI; the monitor returns when the native TUI exits.

For the raw shared tunnel/adapter log:

```bash
tail -f "$HOME/Library/Application Support/tunnel-client/logs/local-codex.log"
```

See [Monitor from the Mac](#monitor-from-the-mac) for health checks and saved thread history.

## What it exposes

- `codex(requestId, cwd, prompt, sourceTitle?, worktree?, networkAccess?, browserAccess?, model?, reasoningEffort?)` starts a background job in any existing folder.
- `codex-reply(requestId, threadId, prompt, sourceTitle?, networkAccess?, browserAccess?, model?, reasoningEffort?)` starts a background reply on an adapter-owned thread.
- `codex-status(jobId, waitMs?)` reads progress, renews the job lease, and returns the saved result. Use `waitMs: 20000` continuously while queued or running.
- `codex-cancel(jobId)` explicitly stops queued or running work. It does not undo file changes.
- `codex-folders(path?, cursor?)` lists up to 100 child directory names per page. It defaults to your home directory and never reads file contents.

ChatGPT chooses an existing absolute `cwd` for each new thread, with **no directory allowlist or per-folder approval**. It can use `codex-folders` to locate the narrowest folder relevant to your task. Symlinks resolve to their target. Relative, missing, inaccessible, and file paths fail without starting work. Folder discovery includes directory symlinks but omits files and broken links; follow `nextCursor` with the same path to continue the alphabetical listing.

Git repositories use a private detached worktree from committed `HEAD` by default. Staged, unstaged, and untracked source-checkout changes are not copied. The returned `sourceCwd` is the selected folder and `cwd` is the actual execution/write boundary inside the managed worktree. Selected subdirectories map to the same relative path. Set `worktree: false` only when the task explicitly needs the selected checkout. Non-Git and unborn repositories fall back to direct execution and report the reason. See [Managed Worktrees](docs/MANAGED_WORKTREES.md).

Replies always reuse their thread's saved worktree or direct folder and cannot accept a different `cwd` or isolation mode. A pruned managed worktree is restored automatically before the reply starts. Start a new thread to change folders. The caller cannot change the sandbox or permission level.

`sourceTitle` is optional source metadata, not a generated summary. ChatGPT must pass it only when the host exposes the exact current conversation title; otherwise it must be omitted. Exact titles persist across replies. The monitor then falls back to Codex's own App Server thread name and finally to a prompt preview, with the fallback source labeled explicitly. Current ChatGPT connector metadata does not include the conversation title automatically.

New jobs default to **gpt-5.6-luna / max**. Optional model IDs or aliases (`luna`, `terra`, `sol`) and reasoning levels are checked against Codex's model catalog. Unsupported combinations fail without fallback. Replies inherit the thread's last settings unless overridden.

Command network access is also thread-scoped. New threads default to **disabled**. ChatGPT chooses the setting from the task: requests that inherently need outbound access—such as `git fetch`, `git clone`, installing dependencies, `curl`, API calls, or downloads—should automatically opt in even when the user does not mention network access. Fully local work stays disabled. Replies inherit the thread's last setting when omitted, and an explicit reply value persists for later replies. The adapter uses Codex's native permission profile and does not proxy individual commands.

When `networkAccess: true`, Local Codex intentionally behaves like the user's normal trusted local Codex/terminal session for reads and developer authentication: commands can use host user files and ambient developer auth such as `gh` config/Keychain credentials, `SSH_AUTH_SOCK`, `GH_TOKEN`, and `GITHUB_TOKEN`. Writes still stay inside the selected workspace. The bridge's own `LOCAL_CODEX_*` and `TUNNEL_CLIENT_*` variables remain stripped.

Host approval prompts are optional and default to **off**. `LOCAL_CODEX_APPROVAL_MODE=off` runs command/file actions without TUI approval and grants an explicitly selected `networkAccess: true` capability without another prompt. Set `LOCAL_CODEX_APPROVAL_MODE=host` in `config.env` and restart the local tunnel to restore the network preflight plus per-command/file approval workflow. Unknown values fail before Codex starts.

### Background job flow (v2)

1. Choose `cwd`, generate a unique `requestId`, and submit once. The response contains a `jobId` and canonical `cwd`, not the answer.
2. Start polling `codex-status` immediately and continue until `completed`, `failed`, `cancelled`, `timed_out`, or `interrupted`. A job may report `queued` before it starts. Only `completed` contains a successful final answer. Every valid poll renews the job lease.
3. If submission delivery is uncertain, retry with the **same requestId and arguments**. This returns the same saved job. Reusing an ID with different arguments or a different canonical folder fails.

`LOCAL_CODEX_MAX_CONCURRENCY` defaults to **10**. Separate managed worktrees can run concurrently even when they come from one repository. Direct jobs still serialize on the same canonical folder. When a job cannot start immediately, it is accepted into a bounded queue instead of returning `busy`; `LOCAL_CODEX_MAX_QUEUE` defaults to **100**. If the queue is full, retry later with the same `requestId` and arguments.

The scheduling policy is **FIFO among runnable jobs**: the oldest queued job whose folder is not currently locked starts when capacity is available. A queued job blocked by its folder does not unnecessarily block older independent work behind it. `codex-status` and `codex-cancel` work for queued jobs; cancelling a queued job makes it `cancelled` without spawning Codex. `/readyz` reports active/queued counts, job IDs, folders, configured limits, and the scheduling policy.

Jobs run independently of the tunnel's response deadline, with a 30-minute execution limit by default. Set `LOCAL_CODEX_CALL_TIMEOUT_MS` in the local config to change it. Queue wait time does not consume this execution limit. Queued and running jobs also have a renewable polling lease, controlled by `LOCAL_CODEX_POLL_LEASE_MS` and defaulting to 90 seconds. If ChatGPT stops polling longer than that, the job is cancelled with `polling_expired`; retrying the original submission with the same request ID also renews the lease.

Cancellation first requests `turn/interrupt`, then terminates the job's process group if needed. Successful completion is not saved or shown as `DONE` until the process group is confirmed absent. If cleanup cannot be verified after `SIGTERM` and `SIGKILL`, the job fails with `process_cleanup_failed`, `/readyz` becomes unavailable, and no queued work starts until the adapter is restarted. A folder lock is not released before cleanup verification finishes, so a same-folder successor cannot overlap it.

Job metadata and final results are saved atomically under `LOCAL_CODEX_JOBS_DIR` using mode `0700` directories and `0600` files. Request IDs and input fingerprints are hashed; job files do not contain prompts or reasoning. Managed worktree metadata and private snapshots live beside thread state. The newest 15 worktrees are retained by default; older inactive worktrees are snapshotted and can be restored automatically. Saved results and snapshot bundles are retained until explicitly removed. On adapter restart, unfinished active and queued jobs become `interrupted` and are never replayed.

## Security boundary

- The adapter listens only on `127.0.0.1`.
- A generated bearer token protects the local MCP endpoint.
- The returned execution `cwd` is the file write boundary. `sourceCwd` identifies the selected checkout.
- With networking disabled, jobs receive system read access and write access only to the chosen canonical folder. On macOS, the effective wrapper profile keeps the workspace write boundary and fixed `.gitconfig`/`.zshenv` denies without enumerating user-tree siblings; broader user-home reads are intentional, while mounted volumes and temporary trees remain denied unless they are inside the chosen folder.
- With networking enabled, reads and developer-auth environment are intentionally terminal-like so normal `gh`, Git credential, Keychain, SSH-agent, and developer environment workflows work. This is a broader trust mode; use it only for tasks and repositories you trust.
- The macOS hardened profile deliberately avoids Codex 0.147's `:minimal` preset, which grants unconditional system-temp writes. Tools that need writable scratch space must use the chosen folder.
- Each normal job receives a unique mode-`0700` scratch directory inside an already-authorized writable root. Git jobs place it in their validated per-worktree metadata so it stays out of `git status`; non-Git jobs place it inside the selected workspace. The wrapper sets `TMPDIR`, `TMP`, `TEMP`, and zsh's `TMPPREFIX` for both App Server and command subprocesses, then removes the directory when the job exits. Read-only browser probes do not create scratch state.
- Network-disabled jobs ignore system and user Git configuration (`GIT_CONFIG_NOSYSTEM=1`, global/system config at `/dev/null`) so local Git commands do not traverse blocked host configuration. On macOS the wrapper also resolves and prepends the real developer Git executable, bypassing the `/usr/bin/git` xcrun shim inside the sandbox, and uses a constant-size user-path policy with fixed `.gitconfig`/`.zshenv` carveouts. Repository-local config still applies. Network-enabled jobs retain the existing terminal-like global Git behavior.
- `.codex` stays read-only. `.git` is writable inside the selected folder because fetch, clone, commit, and related Git operations require metadata writes.
- A linked worktree also receives write access to its validated shared Git metadata directory. Original checkout files remain outside the write boundary, but Git refs and objects are shared by Git's worktree design.
- Common credential files inside every selected folder are denied to sandboxed commands: `.env`, `.env.*`, `*.env`, `.npmrc`, and `.pypirc`, including nested copies.
- The authenticated folder lookup tool can list directory names elsewhere; it does not grant a network-disabled running job access to those folders.
- Commands run without network access by default. `networkAccess: true` enables broad direct command network access without a domain allowlist and also enables normal host developer authentication. A network-enabled job can send readable host/workspace data to external services and can act with credentials available to your normal developer session. With the default `LOCAL_CODEX_APPROVAL_MODE=off`, that capability is not separately host-approved.
- Network-disabled jobs use a small environment allowlist with secret-name filtering. Network-enabled jobs inherit the normal host developer environment, except `LOCAL_CODEX_*` and `TUNNEL_CLIENT_*` variables are removed so the bridge's own control/runtime credentials are not exposed.
- Thread replies are accepted only for thread IDs created by this adapter.
- Worktree creation uses deterministic adapter-owned paths, detached `HEAD`, disabled checkout hooks, and no shell command strings. Pruning never targets unregistered worktrees and never deletes before a private bundle and overlay are verified.
- Native TUI handoff is allowed only for terminal jobs with a saved adapter-owned thread. The secure wrapper authenticates the monitor with the private adapter token, reapplies the job's workspace/network boundary, strips bridge variables, and uses `never` or native `untrusted` CLI approvals according to `LOCAL_CODEX_APPROVAL_MODE`.
- ChatGPT's job-scoped Browser context is not transferred to a standalone CLI resume. Browser-enabled jobs require a second `o` confirmation in the monitor.
- No inbound public port is required.

The adapter uses `codex app-server`, which OpenAI recommends in place of the deprecated `codex mcp-server` command.

These controls reduce accidental credential exposure for network-disabled jobs. A network-enabled job is deliberately closer to running Codex from your own terminal. See [SECURITY.md](SECURITY.md) for the threat model and vulnerability-reporting guidance.

## Requirements

- macOS
- Git
- Node.js 22 or newer
- Codex CLI 0.138.0 or newer, logged in; latest stable is recommended because permission profiles are beta
- Official OpenAI `tunnel-client`
- An OpenAI tunnel ID associated with your Platform organization and ChatGPT workspace
- A runtime API key with **Tunnels Read + Use**, stored in a local file
- ChatGPT developer mode

Official setup references:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Codex app server](https://learn.chatgpt.com/docs/app-server)
- [Codex permissions](https://learn.chatgpt.com/docs/permissions)

## Provision the OpenAI tunnel

Do this once before installing the local bridge:

1. In the target OpenAI Platform organization, make sure you have **Tunnels Read + Manage** to create or edit a tunnel. Running `tunnel-client` and selecting the tunnel while creating the ChatGPT app require **Tunnels Read + Use**. ChatGPT developer mode is a separate workspace permission.
2. Open [OpenAI Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels), create a tunnel, and copy its `tunnel_...` ID.
3. Associate the tunnel with both:
   - the Platform organization that owns or manages it; and
   - the ChatGPT workspace where you will create the **Local Codex** app.
4. Create or use a runtime API key for a principal with **Tunnels Read + Use**. Store the key in a local file outside the repository and restrict the file to your user, for example:

   ```bash
   chmod 600 /absolute/path/to/runtime-api-key
   ```

5. Keep the tunnel ID and runtime-key file path handy for the installer below.

The end-to-end sequence is:

```text
Create tunnel → associate ChatGPT workspace → create runtime key → install → start → connect in ChatGPT
```

If the tunnel does not appear when you create the ChatGPT app, first check the ChatGPT workspace association and that the app creator has **Tunnels Read + Use**. `tunnel-client` only needs outbound HTTPS to OpenAI; this project does not require a public inbound port.

## Install

Clone the repository, then run:

```bash
./scripts/install.sh \
  --tunnel-id tunnel_... \
  --runtime-api-key-file /absolute/path/to/runtime-api-key
```

The installer:

- installs the launcher at `~/.local/bin/local-codex-tunnel`;
- installs the adapter and hardened Codex wrapper under `~/.local/libexec`;
- generates a mode-`0600` local bearer token;
- writes private local configuration under `~/Library/Application Support/local-codex-tunnel`;
- writes `~/.config/tunnel-client/local-codex.yaml` without copying or printing the API key.

Preview paths and validation without changing anything:

```bash
./scripts/install.sh \
  --tunnel-id tunnel_... \
  --runtime-api-key-file /absolute/path/to/runtime-api-key \
  --dry-run
```

## Start

```bash
~/.local/bin/local-codex-tunnel
```

Keep that terminal open while using Local Codex in ChatGPT.

## Connect in ChatGPT

1. Open **Plugins** and choose **Create app**.
2. Name it **Local Codex**.
3. Select **Tunnel** under Connection.
4. Select your tunnel and choose **No Auth**.
5. Accept the custom MCP warning and connect the app.

Test it with:

```text
Use Local Codex's codex-folders tool to find the relevant project folder. Call codex with its absolute cwd, requestId: smoke-001, and prompt: Reply with exactly TEST_OK. Then poll codex-status for the returned jobId using waitMs: 20000 until it completes. Do not submit the prompt again with a new requestId.
```

Normal network-dependent prompts do not need permission boilerplate. For example:

```text
Use Local Codex in /path/to/project to fetch PR #123 and run its tests.

Use Local Codex in /private/tmp/local-codex-intent-e2e to curl https://github.com and report the first HTTP status line. Do not modify files.
```

Purely local prompts keep command networking disabled:

```text
Use Local Codex in /path/to/project to run the tests from the current checkout without fetching or installing anything.
```

Official Browser tasks use `browserAccess: true` independently of command networking:

```text
Use Local Codex in /path/to/project with browserAccess: true and networkAccess: false.
Open http://127.0.0.1:3000 in the official Codex Browser, inspect the rendered page,
and report the heading text. Do not launch Playwright or Chromium from the shell.
```

`browserAccess` selects the bundled Browser/Chrome runtime through a dedicated `local_codex_browser` MCP broker in the adapter. The sandboxed model turn receives only validated `official_browser_*` operations through a mode-`0600`, capability-token-protected Unix socket inside the already-authorized workspace; the socket is removed when the job exits. Direct `node_repl` and Playwright MCP are disabled for that turn. This does not make `npx playwright test`, Puppeteer, Chromium, or Chrome for Testing executable inside the macOS command sandbox, and it never enables `danger-full-access`, command networking, or another filesystem root. ChatGPT keeps ownership of website, interaction, and CDP confirmations.

Browser jobs must be submitted from a live ChatGPT turn because the broker uses that turn's safe session identifiers to attach to the same official Browser session. Direct unaffiliated loopback calls fail with `browser_host_context_unavailable` before a job is accepted.

After upgrading from v1, refresh Local Codex's tool definitions in ChatGPT (or reconnect the app if needed). v2 requires `requestId` and changes submission responses from final answers to job handles. A cached v1 call without `requestId` is rejected without starting work.

v3 additionally requires `cwd` for `codex` and adds `codex-folders`. Refresh tools after upgrading from v2; cached submissions without `cwd` are rejected with a clear error. Existing jobs and threads are migrated to their original folder using the old `LOCAL_CODEX_ROOT`. Their results and request fingerprints are preserved. The migration source is saved once in thread state, so later configuration changes cannot retarget old threads. `LOCAL_CODEX_ROOT` (and the installer's optional `--root`) is only a legacy migration input, not a default or limit for new jobs. Keep it set until legacy records have been migrated; fresh installations do not need it.

v3.1 adds optional `networkAccess` to `codex` and `codex-reply`. Existing callers remain network-disabled, legacy threads migrate with network disabled, and saved request fingerprints remain valid when the field was omitted. Refresh Local Codex's tools and start a fresh conversation before using the new option.

v3.1.1 clarifies the MCP contract so ChatGPT chooses `networkAccess` from the user's task intent. Runtime defaults and sandbox behavior are unchanged. Refresh Local Codex's tools and use a fresh conversation so ChatGPT receives the new descriptions.

v3.2 adds concurrent jobs across different canonical folders, same-folder serialization, bounded queueing, and configurable concurrency/queue limits. Existing saved request fingerprints and completed results remain compatible. Restart recovery does not replay queued or active work; unfinished jobs become `interrupted`.

v3.3 routes `browserAccess: true` through the official bundled Codex Browser runtime on every platform. Before starting a model turn, Local Codex verifies managed policy, the enabled Browser plugin, the trusted `node_repl` transport, and Browser runtime setup. Browser-enabled replies inherit the capability unless explicitly disabled. Refresh Local Codex's tools and start a fresh conversation after upgrading.

v3.4 makes detached per-thread worktrees the default for Git repositories, raises default concurrency to 10, adds worktree snapshots/restoration, and adds prompt-source/native-TUI monitor integration. Existing threads migrate as direct workspaces. Refresh Local Codex's tools and start a fresh ChatGPT conversation before using `worktree`.

v3.5 adds a renewable polling lease for queued and running jobs, cancels abandoned work with `polling_expired`, and withholds successful completion until the Codex process group is confirmed absent. Refresh Local Codex's tools and start a fresh ChatGPT conversation so the host receives the lease-aware tool descriptions and result fields.

v3.5.1 repairs local Git inside network-disabled macOS jobs. Normal jobs receive private per-job scratch space without reopening shared `/tmp`; hardened commands bypass blocked system/global Git config and the `/usr/bin/git` xcrun shim; the effective profile permits workspace-ancestor traversal while denying unrelated siblings; network-enabled jobs keep terminal-like Git config access. The MCP schema is unchanged.

v3.5.2 makes the network-disabled macOS profile constant-size, intentionally broadens user-home reads to avoid recursive sibling enumeration, and sets zsh's `TMPPREFIX` to the authorized per-job scratch directory. The workspace write boundary, fixed credential denies, control-state deny, and temporary-tree denial remain in place.

The current `main` behavior additionally makes host approvals optional through `LOCAL_CODEX_APPROVAL_MODE=off|host`, defaulting to `off`. Network-enabled jobs remain terminal-like for host reads and developer authentication; network-disabled jobs remain hardened and the tunnel's own runtime/control variables stay filtered. It also adds optional exact `sourceTitle` metadata, Codex-name/prompt fallbacks in the monitor, and guarded `o` handoff to `codex resume` for terminal jobs. Refresh Local Codex's tools and use a fresh ChatGPT conversation before expecting `sourceTitle` in the tool schema.

### If ChatGPT reports missing `requestId` or `cwd`

Missing required submission fields return `schema_outdated`, the adapter version, and its `schemaFingerprint`. No job is started. In ChatGPT, open **Local Codex → Manage → Refresh**, then use a **fresh conversation**. Existing conversations can retain older tool definitions even when the connection's settings show the new schema. Do not work around this by dropping required fields, inventing a working directory, or retrying with new IDs.

The adapter's `/readyz` response includes the same fingerprint. Safe `schema_served`, `browser_backend_selected`, `browser_backend_ready`, and `call_rejected` log events identify which schema/capability was used without logging caller IDs, prompts, browser arguments, or output. The static plugin description/version in ChatGPT is separate from the live tool schema; inspect its **Actions → Input schema** to verify `requestId`, `cwd`, `networkAccess`, and `browserAccess`.

Treat a successful no-file-changes job submitted and polled from ChatGPT as the end-to-end check. A healthy local endpoint alone does not prove that ChatGPT has the updated tools.

For an existing installation, stop new work and wait for active jobs to finish. Back up the adapter, wrapper, launcher, config, token, tunnel profile, jobs, and thread history. Upgrade the adapter, wrapper, and launcher together; keep the existing private state and tunnel credentials. Ensure `LOCAL_CODEX_BIN` points to the installed wrapper and `LOCAL_CODEX_REAL_BIN` points to `codex`, then restart and refresh ChatGPT's tools.

## Monitor from the Mac

Run the interactive monitor:

```bash
local-codex-watch
```

Source precedence is `CHATGPT` exact title, `CODEX (fallback)` thread name, then `PROMPT (fallback)` preview. Press `o` on a completed, failed, cancelled, timed-out, or interrupted job to open its saved thread in the native Codex CLI TUI. Active and queued jobs cannot be opened concurrently. The secure handoff keeps the saved workspace/network setting and approval mode, but native CLI continuation is not appended to the already-terminal bridge job event log. Jobs that used ChatGPT Browser show a warning because that host turn context cannot be transferred.

Follow raw tunnel traffic:

```bash
tail -f "$HOME/Library/Application Support/tunnel-client/logs/local-codex.log"
```

Check health and readiness:

```bash
base=$(<"$HOME/Library/Application Support/tunnel-client/health/local-codex.url")
curl -s "$base/healthz"; echo
curl -s "$base/readyz"; echo
```

List Codex threads created by ChatGPT:

```bash
jq -r '.threadIds[]' "$HOME/Library/Application Support/local-codex-tunnel/threads.json"
```

Open Codex history, including app-server sessions:

```bash
cd /path/to/chosen/project
codex resume --all --include-non-interactive
```

## Development

```bash
npm test
npm run check
# Optional macOS boundary checks using the installed Codex CLI (no model calls):
LOCAL_CODEX_NATIVE_TEST=1 npm test
```

Tests use fake Codex processes, temporary state, and loopback HTTP. They cover per-job folders, concurrency, same-folder serialization, bounded queueing, queue cancellation/recovery, directory pagination, symlinks, legacy migration, replies after restart, retries, cancellation, timeout, model and network settings, credential denies, wrapper environment filtering, trusted network developer-auth inheritance, permissions, and private logging. They do not require OpenAI or GitHub credentials.

## License

MIT
