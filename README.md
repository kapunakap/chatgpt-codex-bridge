# ChatGPT Local Codex Tunnel

Run Codex on your Mac from ChatGPT through OpenAI Secure MCP Tunnel:

```text
ChatGPT → custom app → Secure MCP Tunnel → local adapter → codex app-server
```

This is an unofficial local bridge. It keeps the MCP backend private and opens only outbound HTTPS through OpenAI's official `tunnel-client`.

## What it exposes

- `codex(requestId, cwd, prompt, model?, reasoningEffort?)` starts a background job in any existing folder.
- `codex-reply(requestId, threadId, prompt, model?, reasoningEffort?)` starts a background reply on an adapter-owned thread.
- `codex-status(jobId, waitMs?)` reads progress and the saved result. Use `waitMs: 20000` while running.
- `codex-cancel(jobId)` explicitly stops work. It does not undo file changes.
- `codex-folders(path?, cursor?)` lists up to 100 child directory names per page. It defaults to your home directory and never reads file contents.

ChatGPT chooses an existing absolute `cwd` for each new thread, with **no directory allowlist or per-folder approval**. It can use `codex-folders` to locate the narrowest folder relevant to your task. Symlinks resolve to their target; the canonical `cwd` is returned with the job and is its write boundary. Relative, missing, inaccessible, and file paths fail without starting work. Folder discovery includes directory symlinks but omits files and broken links; follow `nextCursor` with the same path to continue the alphabetical listing.

Replies always use their thread's saved folder and cannot accept a different `cwd`. Start a new thread to change folders. If a saved folder disappears or resolves elsewhere, replies fail without widening access. The caller cannot change the sandbox or permission level.

New jobs default to **gpt-5.6-luna / max**. Optional model IDs or aliases (`luna`, `terra`, `sol`) and reasoning levels are checked against Codex's model catalog. Unsupported combinations fail without fallback. Replies inherit the thread's last settings unless overridden.

### Background job flow (v2)

1. Choose `cwd`, generate a unique `requestId`, and submit once. The response contains a `jobId` and canonical `cwd`, not the answer.
2. Poll `codex-status` until `completed`, `failed`, `cancelled`, `timed_out`, or `interrupted`. Only `completed` contains a successful final answer.
3. If submission delivery is uncertain, retry with the **same requestId and arguments**. This returns the same saved job. Reusing an ID with different arguments or a different canonical folder fails.

There is one active job and **no waiting queue**. A `busy` response contains `activeJobId`; it does not accept or queue the new request. Status checks never start work. Closing a status request or its connection does not cancel an accepted job; use `codex-cancel` explicitly.

Jobs run independently of the tunnel's response deadline, with a 30-minute execution limit by default. Set `LOCAL_CODEX_CALL_TIMEOUT_MS` in the local config to change it. Cancellation first requests `turn/interrupt`, then terminates the job's process group if needed. A new job is not admitted until the old process has exited.

Job metadata and final results are saved atomically under `LOCAL_CODEX_JOBS_DIR` (default: `jobs` next to `threads.json`), using mode `0700` directories and `0600` files. Request IDs and input fingerprints are hashed; job files do not contain prompts or reasoning. Codex's own session history is separate and may contain the original input. Saved results are retained until explicitly removed. On adapter restart, unfinished jobs become `interrupted` and are never replayed; inspect their threads before starting replacement work.

## Security boundary

- The adapter listens only on `127.0.0.1`.
- A generated bearer token protects the local MCP endpoint.
- Each Codex job receives system read access and write access only to its chosen canonical folder. On macOS, other user folders, mounted volumes, and temporary trees are denied unless they are inside the chosen folder.
- The macOS profile deliberately avoids Codex 0.147's `:minimal` preset, which grants unconditional system-temp writes. Tools that need writable scratch space must use the chosen folder.
- The authenticated folder lookup tool can list directory names elsewhere; it does not grant the running job access to those folders.
- Commands run without network access.
- Thread replies are accepted only for thread IDs created by this adapter.
- No inbound public port is required.

The adapter uses `codex app-server`, which OpenAI recommends in place of the deprecated `codex mcp-server` command.

## Requirements

- macOS
- Node.js 22 or newer
- Codex CLI, logged in
- Official OpenAI `tunnel-client`
- An OpenAI tunnel ID associated with your Platform organization and ChatGPT workspace
- A runtime API key with **Tunnels Read + Use**, stored in a local file
- ChatGPT developer mode

Official setup references:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Codex app server](https://learn.chatgpt.com/docs/app-server)
- [Codex permissions](https://learn.chatgpt.com/docs/permissions)

## Install

Clone the repository, then run:

```bash
./scripts/install.sh \
  --tunnel-id tunnel_... \
  --runtime-api-key-file /absolute/path/to/runtime-api-key
```

The installer:

- installs the launcher at `~/.local/bin/local-codex-tunnel`;
- installs the adapter under `~/.local/libexec`;
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

After upgrading from v1, refresh Local Codex's tool definitions in ChatGPT (or reconnect the app if needed). v2 requires `requestId` and changes submission responses from final answers to job handles. A cached v1 call without `requestId` is rejected without starting work.

v3 additionally requires `cwd` for `codex` and adds `codex-folders`. Refresh tools after upgrading from v2; cached submissions without `cwd` are rejected with a clear error. Existing jobs and threads are migrated to their original folder using the old `LOCAL_CODEX_ROOT`. Their results and request fingerprints are preserved. The migration source is saved once in thread state, so later configuration changes cannot retarget old threads. `LOCAL_CODEX_ROOT` (and the installer's optional `--root`) is only a legacy migration input, not a default or limit for new jobs. Keep it set until legacy records have been migrated; fresh installations do not need it.

### If ChatGPT reports missing `requestId` or `cwd`

Missing required submission fields return `schema_outdated`, the adapter version, and its `schemaFingerprint`. No job is started. In ChatGPT, open **Local Codex → Manage → Refresh**, then use a **fresh conversation**. Existing conversations can retain older tool definitions even when the connection's settings show the new schema. Do not work around this by dropping required fields, inventing a working directory, or retrying with new IDs.

The adapter's `/readyz` response includes the same fingerprint. Safe `schema_served` and `call_rejected` log events identify which schema was served and why a request was rejected, without logging caller IDs, prompts, or argument values. The static plugin description/version in ChatGPT is separate from the live tool schema; inspect its **Actions → Input schema** to verify `requestId` and `cwd`.

Treat a successful no-file-changes job submitted and polled from ChatGPT as the end-to-end check. A healthy local endpoint alone does not prove that ChatGPT has the updated tools.

For an existing installation, back up and replace only the adapter and launcher; keep the existing config, token, tunnel profile, and thread history. Stop the old bridge and its children before restarting. Do not rerun the full installer to upgrade an installation with customized configuration.

## Monitor from the Mac

Follow tunnel traffic:

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

Tests use a fake Codex process, temporary state, and loopback HTTP. They cover per-job folders, directory pagination, symlinks, legacy migration, replies after restart, retries, busy handling, cancellation, timeout, model settings, permissions, and private logging. They do not require OpenAI or GitHub credentials.

## License

MIT
