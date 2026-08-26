#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const [
  outputPath,
  tunnelId,
  runtimeApiKeyFile,
  tokenFile,
  healthUrlFile,
  logFile,
  port,
] = process.argv.slice(2);

if (!outputPath || !tunnelId || !runtimeApiKeyFile || !tokenFile || !healthUrlFile || !logFile || !port) {
  throw new Error("render-profile.mjs requires output, tunnel ID, key file, token file, health URL file, log file, and port");
}

const profile = {
  config_version: 1,
  control_plane: {
    base_url: "https://api.openai.com",
    tunnel_id: tunnelId,
    api_key: `file:${runtimeApiKeyFile}`,
  },
  health: {
    listen_addr: "127.0.0.1:0",
    url_file: healthUrlFile,
  },
  admin_ui: {
    open_browser: false,
  },
  log: {
    level: "info",
    format: "json",
    file: logFile,
  },
  mcp: {
    server_urls: [
      {
        channel: "main",
        url: `http://127.0.0.1:${port}/mcp`,
      },
    ],
    extra_headers: {
      Authorization: `file:${tokenFile}`,
    },
    discovery_extra_headers: {
      Authorization: `file:${tokenFile}`,
    },
  },
};

await writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
