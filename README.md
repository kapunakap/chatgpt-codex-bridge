# ChatGPT Local Codex Tunnel

![ChatGPT.com → OpenAI Secure MCP Tunnel → Your laptop or server running Codex CLI](docs/chatgpt-local-codex-tunnel.svg)

Run Codex on your Mac from ChatGPT through OpenAI Secure MCP Tunnel.

This is an unofficial local bridge. It keeps the MCP backend private and opens only outbound HTTPS through OpenAI's official `tunnel-client`.

## Watch it working

Want to see ChatGPT reaching your Mac? In another terminal, follow the shared tunnel/adapter log:

```bash
tail -f "$HOME/Library/Application Support/tunnel-client/logs/local-codex.log"
```

Requests and adapter events appear here as ChatGPT uses Local Codex. See [Monitor from the Mac](#monitor-from-the-mac) for filtering, event details, and health checks.

## What it exposes

- `codex(prompt, model?, reasoningEffort?)` starts a Codex thread.
- `codex-reply(threadId, prompt, model?, reasoningEffort?)` continues a thread created by this adapter.

New threads default to **`gpt-5.6-luna` with `max` reasoning**, regardless of the model in your global Codex configuration. Accepts full model IDs and the aliases `luna`, `terra`, and `sol`. Both selections are checked against the installed app-server's model catalog; unavailable models and unsupported reasoning levels fail with supported choices, never silently fall back.

Follow-ups keep the thread's last model and reasoning level for fields you omit. Overrides persist for later replies, including after an adapter restart. Existing threads keep their existing settings; the adapter does not replace those with Luna/max. If a legacy thread has no reported reasoning level, pass `reasoningEffort` explicitly.

The tool caller still cannot choose a working directory, sandbox, or permission level. The adapter fixes Codex to one configured repository root. These model settings control the **local Codex worker**, not the outer ChatGPT chat model. Other Codex settings remain unchanged.

## Security boundary

- The adapter listens only on `127.0.0.1`.
- A generated bearer token protects the local MCP endpoint.
- Codex is fixed to one configured repository root and runs with `approvalPolicy: "never"`.
- The local permission profile extends Codex's built-in `:workspace` profile, preserving its read-only protections for workspace `.git/` and `.codex/` directories.
- Common credential files inside the workspace are denied to sandboxed commands: `.env`, `.env.*`, `*.env`, `.npmrc`, and `.pypirc`, including nested copies.
- Commands run without network access.
- The Codex app-server receives a small environment allowlist instead of the launcher's complete environment. Ambient API keys, database URLs, adapter/tunnel variables, and similar shell credentials are not forwarded.
- Commands launched by Codex inherit only the core environment. Codex's automatic `KEY`/`SECRET`/`TOKEN` filtering is explicitly enabled, with additional password/auth/credential/cookie/session exclusions.
- Thread replies are accepted only for thread IDs created by this adapter.
- No inbound public port is required.

The adapter uses `codex app-server`, which OpenAI recommends in place of the deprecated `codex mcp-server` command.

These controls reduce accidental credential exposure; they do not make arbitrary repository contents non-sensitive. If your repository contains secrets under other filenames, remove them from the configured root or add equivalent deny rules before granting an agent access.

See [SECURITY.md](SECURITY.md) for the threat model and vulnerability-reporting guidance.

## Requirements

- macOS
- Node.js 22 or newer
- Codex CLI **0.138.0 or newer**, logged in; latest stable is recommended because permission profiles are beta and may change
- Official OpenAI `tunnel-client`
- An OpenAI tunnel ID associated with your Platform organization and ChatGPT workspace
- A runtime API key with **Tunnels Read + Use**, stored in a local file
- ChatGPT developer mode

Official setup references:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Codex app server](https://learn.chatgpt.com/docs/app-server)
- [Codex permissions](https://learn.chatgpt.com/docs/permissions)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

## Install

Clone the repository, then run:

```bash
./scripts/install.sh \
  --root /absolute/path/to/the/repository/codex-may-edit \
  --tunnel-id tunnel_... \
  --runtime-api-key-file /absolute/path/to/runtime-api-key
```

The installer:

- installs the launcher at `~/.local/bin/local-codex-tunnel`;
- installs the adapter and hardened Codex wrapper under `~/.local/libexec/local-codex-tunnel`;
- generates a mode-`0600` local bearer token;
- writes private local configuration under `~/Library/Application Support/local-codex-tunnel`;
- writes `~/.config/tunnel-client/local-codex.yaml` without copying or printing the API key.

Preview paths and validation without changing anything:

```bash
./scripts/install.sh \
  --root /absolute/path/to/repository \
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
Use Local Codex to call the codex tool with prompt: Reply with exactly: TEST_OK
```

To choose a model from ChatGPT:

```text
Use Local Codex with model terra and reasoningEffort high to review the repository. Do not edit files.
```

The resulting MCP arguments look like:

```json
{"prompt":"Review the repository. Do not edit files.","model":"terra","reasoningEffort":"high"}
```

Continue with `codex-reply` and the returned `threadId`. Omit both settings to keep Terra/high, or pass `model: "luna", reasoningEffort: "max"` to switch back.

## Monitor from the Mac

Follow tunnel traffic:

```bash
tail -f "$HOME/Library/Application Support/tunnel-client/logs/local-codex.log"
```

The adapter appends JSON records to the same file using `component: "local-codex-adapter"`. Events include `call_started`, `settings_requested`, `settings_confirmed`, `turn_started`, `call_completed`, `call_failed`, and `call_timed_out`, with a locally generated `requestId`, thread/turn IDs when available, and elapsed milliseconds.

```json
{"component":"local-codex-adapter","event":"settings_confirmed","model":"gpt-5.6-luna","reasoningEffort":"max","settingsStatus":"confirmed"}
```

`settings_requested` is only a selection; `settings_confirmed` means app-server reported the same values. Calls fail if app-server reports different or missing settings. Early failures have null settings/IDs. `LOCAL_CODEX_LOG_FILE` selects the adapter log path; the installer points it at the tunnel log above. The adapter never logs prompts, responses, credentials, raw stderr, or reasoning content. Normal Codex session history is separate and can contain task content.

Filter adapter events only (requires `jq`):

```bash
tail -f "$HOME/Library/Application Support/tunnel-client/logs/local-codex.log" |
  jq --unbuffered -c 'select(.component == "local-codex-adapter")'
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
cd /path/to/configured/repository
codex resume --all --include-non-interactive
```

## Development

```bash
npm test
npm run check
```

Unit tests use only loopback/local fixtures. They do not require OpenAI or GitHub credentials. CI also exercises the hardened Codex wrapper with fake ambient credentials and fails if those variables reach the child process.

## Upgrading an existing installation

Stop accepting new work and wait for the active call to finish before stopping the launcher with Ctrl-C. Back up your installed adapter, launcher, and local configuration. Re-run the installer with the **same** repository root, tunnel ID, and runtime-key file; it preserves the existing adapter token and thread history and installs the hardened Codex wrapper. Start the launcher again.

In ChatGPT, open the existing **Local Codex** plugin settings and select **Refresh** to load the new tool schema. Do not create another app or tunnel. Test an omitted-settings call, an explicit override, and a reply without overrides; compare the confirmed settings in the log. If an upgrade fails, restore the backed-up installation and restart it.

## License

MIT
