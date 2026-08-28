#!/usr/bin/env node

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
            { id: "browser@openai-bundled", name: "Browser", installed: true, enabled },
            { id: "irrelevant@example", name: "Database", installed: true, enabled: true },
          ],
        }],
        marketplaceLoadErrors: [],
      },
    });
  }
  send({ id: message.id, error: { code: -32601, message: "method not found" } });
});
