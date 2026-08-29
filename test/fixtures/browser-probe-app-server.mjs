#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import readline from "node:readline";

let mode = "available";
try {
  mode = JSON.parse(await readFile(join(process.cwd(), "probe-case.json"), "utf8"))?.mode || mode;
} catch {}

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    return send({ id: message.id, result: { serverInfo: { name: "probe-fixture", version: "1" } } });
  }
  if (message.method === "configRequirements/read") {
    if (mode === "unsupported") return send({ id: message.id, error: { code: -32601, message: "method not found" } });
    const blocked = mode === "policy-blocked";
    return send({
      id: message.id,
      result: {
        requirements: {
          allowBrowserAndComputerUse: !blocked,
          featureRequirements: {
            browser_use: !blocked,
            browser_use_full_cdp_access: true,
            browser_use_external: true,
            in_app_browser: true,
            computer_use: true,
          },
          browserUse: { disableAutoReview: false },
          inAppBrowser: { allowExternalBrowserSettingsImport: true },
          computerUse: { defaultAppAccess: "allow" },
        },
      },
    });
  }
  if (message.method === "plugin/installed") {
    if (mode === "unsupported") return send({ id: message.id, error: { code: -32601, message: "method not found" } });
    const enabled = mode !== "plugin-disabled";
    return send({
      id: message.id,
      result: {
        marketplaces: [{
          name: "bundled",
          path: "/bundled",
          interface: null,
          plugins: [
            {
              id: "browser@openai-bundled", name: "Browser", installed: true, enabled,
              localVersion: "test", source: { type: "local", path: "/bundled/browser" },
            },
            { id: "irrelevant@example", name: "Database", installed: true, enabled: true },
          ],
        }],
        marketplaceLoadErrors: [],
      },
    });
  }
  if (message.method === "mcpServerStatus/list") {
    if (mode === "unsupported") return send({ id: message.id, error: { code: -32601, message: "method not found" } });
    return send({
      id: message.id,
      result: {
        data: mode === "transport-missing" ? [] : [{
          name: "node_repl", authStatus: "unsupported", serverInfo: { name: "fixture", version: "1" },
          tools: { js: { name: "js", inputSchema: {} }, js_reset: { name: "js_reset", inputSchema: {} } },
          resources: [], resourceTemplates: [],
        }],
        nextCursor: null,
      },
    });
  }
  if (message.method === "thread/start") {
    return send({ id: message.id, result: { thread: { id: randomUUID(), cwd: process.cwd() } } });
  }
  if (message.method === "mcpServer/tool/call") {
    if (message.params?.tool === "js_reset") {
      return send({ id: message.id, result: { content: [], isError: false } });
    }
    return send({
      id: message.id,
      result: mode === "runtime-error"
        ? { content: [{ type: "text", text: "runtime unavailable" }], isError: true }
        : { content: [{ type: "text", text: "BROWSER_RUNTIME_SETUP_OK" }], isError: false },
    });
  }
  send({ id: message.id, error: { code: -32601, message: "method not found" } });
});
