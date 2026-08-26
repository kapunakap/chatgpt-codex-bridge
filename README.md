# ChatGPT Local Codex Tunnel

Run Codex on your Mac from ChatGPT through OpenAI Secure MCP Tunnel:

```text
ChatGPT → custom app → Secure MCP Tunnel → local adapter → codex app-server
```

This is an unofficial local bridge. It keeps the MCP backend private and opens only outbound HTTPS through OpenAI's official `tunnel-client`.

## What it exposes

- `codex(prompt)` starts a Codex thread.
- `codex-reply(threadId, prompt)` continues a thread created by this adapter.

The tool caller cannot choose a working directory, sandbox, model, or permission level. The adapter fixes Codex to one configured repository root. Model and reasoning settings inherit your normal Codex configuration.

## Security boundary

- The adapter listens only on `127.0.0.1`.
- A generated bearer token protects the local MCP endpoint.
- Codex receives minimal system read access and write access only to the configured repository.
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
  --root /absolute/path/to/the/repository/codex-may-edit \
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
cd /path/to/configured/repository
codex resume --all --include-non-interactive
```

## Development

```bash
npm test
npm run check
```

Unit tests use only a loopback test server. They do not require OpenAI or GitHub credentials.

## License

MIT
