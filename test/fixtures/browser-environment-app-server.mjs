#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ id, result });
const model = {
  id: "gpt-5.6-luna",
  model: "gpt-5.6-luna",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map(reasoningEffort => ({ reasoningEffort })),
};
let threadId;
const mode = process.env.BROWSER_FIXTURE_MODE || "available";
const traceFile = process.env.BROWSER_FIXTURE_TRACE;
const brokerArgument = process.argv.find(value => value.includes("mcp_servers.local_codex_browser.command="));
const brokerEnabled = Boolean(brokerArgument);
if (traceFile) {
  appendFileSync(traceFile, `${JSON.stringify({
    method: "fixture/environment",
    params: { argv: process.argv.slice(2), brokerEnabled },
  })}\n`);
}

readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (traceFile) appendFileSync(traceFile, `${JSON.stringify(request)}\n`);
  const params = request.params || {};
  switch (request.method) {
    case "initialize":
      reply(request.id, { userAgent: "browser-environment-fixture" });
      break;
    case "initialized":
      break;
    case "model/list":
      reply(request.id, { data: [model], nextCursor: null });
      break;
    case "configRequirements/read": {
      const blocked = mode === "policy-blocked";
      reply(request.id, {
        requirements: {
          allowBrowserAndComputerUse: !blocked,
          featureRequirements: { browser_use: !blocked },
        },
      });
      break;
    }
    case "plugin/installed": {
      const enabled = mode !== "plugin-disabled";
      reply(request.id, {
        marketplaces: [{
          name: "bundled",
          plugins: [{
            id: "browser@openai-bundled", name: "Browser", installed: true, enabled,
            localVersion: "fixture", source: { type: "local", path: "/bundled/browser" },
          }],
        }],
        marketplaceLoadErrors: [],
      });
      break;
    }
    case "mcpServerStatus/list":
      reply(request.id, {
        data: mode === "transport-missing" ? [] : [{
          name: "node_repl", authStatus: "unsupported", serverInfo: { name: "fixture", version: "1" },
          tools: { js: { name: "js", inputSchema: {} }, js_reset: { name: "js_reset", inputSchema: {} } },
          resources: [], resourceTemplates: [],
        }],
        nextCursor: null,
      });
      break;
    case "mcpServer/tool/call":
      if (params.tool === "js_reset") reply(request.id, { content: [], isError: false });
      else if (mode === "runtime-error") reply(request.id, { content: [{ type: "text", text: "runtime unavailable" }], isError: true });
      else reply(request.id, { content: [{ type: "text", text: "BROWSER_RUNTIME_SETUP_OK" }], isError: false });
      break;
    case "thread/start":
    case "thread/resume": {
      threadId = params.threadId || threadId || randomUUID();
      reply(request.id, {
        thread: { id: threadId, cwd: params.cwd },
        model: params.model || "gpt-5.6-luna",
        reasoningEffort: params.config?.model_reasoning_effort || "max",
      });
      break;
    }
    case "turn/start": {
      const turnId = randomUUID();
      const officialBrowser = brokerEnabled;
      reply(request.id, { turn: { id: turnId, status: "inProgress" } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
      if (officialBrowser) {
        void completeOfficialBrowserFixture(turnId);
        break;
      }
      setTimeout(() => {
        send({ method: "localCodex/visibleEvent", params: { event: {
          seq: 1,
          time: new Date().toISOString(),
          type: "browser.environment_blocked",
          data: {
            errorCode: "browser_sandbox_blocked",
            message: "Chromium/Playwright was blocked by the macOS Codex sandbox before reliable browser assertions could run.",
          },
        } } });
        send({ method: "item/agentMessage/delta", params: {
          threadId, itemId: "agent", delta: "ENVIRONMENT_ONLY",
        } });
      }, 20);
      setTimeout(() => {
        send({ method: "item/completed", params: { threadId, item: {
          id: "agent", type: "agentMessage", phase: "final_answer",
          text: "ENVIRONMENT_ONLY",
        } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      }, 50);
      break;
    }
    case "turn/interrupt":
      reply(request.id, {});
      break;
    default:
      send({ id: request.id, error: { code: -32601, message: "unknown method" } });
  }
});

async function completeOfficialBrowserFixture(turnId) {
  const text = "OFFICIAL_BROWSER_OK";
  send({ method: "item/agentMessage/delta", params: { threadId, itemId: "agent", delta: text } });
  send({ method: "item/completed", params: { threadId, item: {
    id: "agent", type: "agentMessage", phase: "final_answer", text,
  } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
}
