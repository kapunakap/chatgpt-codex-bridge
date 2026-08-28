#!/usr/bin/env node

import { randomUUID } from "node:crypto";
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

readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
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
      reply(request.id, { turn: { id: turnId, status: "inProgress" } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
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
        send({ method: "item/agentMessage/delta", params: { threadId, itemId: "agent", delta: "ENVIRONMENT_ONLY" } });
      }, 20);
      setTimeout(() => {
        send({ method: "item/completed", params: { threadId, item: {
          id: "agent", type: "agentMessage", phase: "final_answer", text: "ENVIRONMENT_ONLY",
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
