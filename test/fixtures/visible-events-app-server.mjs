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
      reply(request.id, { userAgent: "visible-events-fixture" });
      break;
    case "initialized":
      break;
    case "model/list":
      reply(request.id, { data: [model], nextCursor: null });
      break;
    case "thread/start":
      threadId = randomUUID();
      reply(request.id, {
        thread: { id: threadId, cwd: params.cwd },
        model: params.model,
        reasoningEffort: params.config?.model_reasoning_effort,
      });
      break;
    case "turn/start": {
      const turnId = randomUUID();
      reply(request.id, { turn: { id: turnId, status: "inProgress" } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
      setTimeout(() => {
        send({ method: "localCodex/visibleEvent", params: { event: {
          seq: 1,
          time: new Date().toISOString(),
          type: "assistant.delta",
          data: { text: "VISIBLE_PROGRESS", reasoningSecret: "REASONING_SECRET", nested: { encryptedPayload: "ENCRYPTED_SECRET" } },
        } } });
        send({ method: "item/agentMessage/delta", params: { threadId, itemId: "agent", delta: "FINAL_VISIBLE" } });
      }, 30);
      setTimeout(() => {
        send({ method: "localCodex/visibleEvent", params: { event: {
          seq: 2,
          time: new Date().toISOString(),
          type: "item.completed",
          data: { item: { type: "commandExecution", command: "npm test", aggregatedOutput: "2 tests passed", reasoning: "REASONING_SECRET" } },
        } } });
      }, 60);
      setTimeout(() => {
        send({ method: "item/completed", params: { threadId, item: {
          id: "agent", type: "agentMessage", phase: "final_answer", text: "FINAL_VISIBLE",
        } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      }, 90);
      break;
    }
    case "turn/interrupt":
      reply(request.id, {});
      break;
    default:
      send({ id: request.id, error: { code: -32601, message: "unknown method" } });
  }
});
