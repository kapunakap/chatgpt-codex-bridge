#!/usr/bin/env node
// Offline app-server fixture. Its state survives process/adapter restarts.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

const stateFile = process.env.MOCK_CODEX_STATE_FILE;
const traceFile = process.env.MOCK_CODEX_TRACE_FILE;
const mode = process.env.MOCK_CODEX_MODE;
const db = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
let thread;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ id, result });
const models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(model => ({
  id: model, model,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map(reasoningEffort => ({ reasoningEffort })),
}));

readline.createInterface({ input: process.stdin }).on("line", line => {
  const req = JSON.parse(line);
  appendFileSync(traceFile, `${JSON.stringify(req)}\n`);
  const params = req.params || {};
  switch (req.method) {
    case "initialize": reply(req.id, { userAgent: "offline mock" }); break;
    case "initialized": break;
    case "model/list":
      if (mode === "catalog-error") {
        send({ id: req.id, error: { code: -1, message: "UPSTREAM_SECRET_ERROR" } });
      } else {
        const page = params.cursor ? models.slice(1) : models.slice(0, 1);
        reply(req.id, { data: page, nextCursor: params.cursor ? null : "second-page" });
      }
      break;
    case "thread/start":
    case "thread/resume": {
      const id = params.threadId || randomUUID();
      // Match Codex: re-resume of an already-loaded thread ignores overrides.
      if (thread?.id !== id) {
        thread = db[id] || { id, model: "gpt-5.6-sol", reasoningEffort: "high" };
        if (params.model) thread.model = params.model;
        if (params.config?.model_reasoning_effort) thread.reasoningEffort = params.config.model_reasoning_effort;
      }
      const response = { thread: { id }, model: thread.model, reasoningEffort: thread.reasoningEffort };
      if (mode === "mismatch") response.reasoningEffort = "low";
      if (mode === "post-turn-mismatch" && db[id]) response.reasoningEffort = "low";
      if (mode === "missing-confirmation") delete response.reasoningEffort;
      reply(req.id, response);
      break;
    }
    case "turn/start": {
      thread.model = params.model;
      thread.reasoningEffort = params.effort;
      db[thread.id] = thread;
      writeFileSync(stateFile, JSON.stringify(db));
      const id = randomUUID();
      reply(req.id, { turn: { id, status: "inProgress" } });
      send({ method: "turn/started", params: { threadId: thread.id, turn: { id } } });
      if (mode !== "no-settings-event") send({ method: "thread/settings/updated", params: {
        threadId: thread.id, threadSettings: { model: thread.model, effort: mode === "post-turn-mismatch" ? "low" : thread.reasoningEffort },
      } });
      process.stderr.write("RAW_STDERR_SECRET\n");
      if (mode === "timeout") {
        setInterval(() => {}, 1000);
        break;
      }
      if (mode === "exit") process.exit(2);
      send({ method: "item/reasoning/summaryTextDelta", params: { delta: "REASONING_SECRET" } });
      send({ method: "item/agentMessage/delta", params: { threadId: thread.id, delta: "MOCK_OUTPUT_SECRET" } });
      const complete = () => send({ method: "turn/completed", params: {
        threadId: thread.id, turn: { id, status: mode === "turn-error" ? "failed" : "completed",
          error: mode === "turn-error" ? { message: "UPSTREAM_TURN_SECRET" } : null },
      } });
      if (mode === "early-completion") complete();
      else setTimeout(complete, 10);
      break;
    }
    default: send({ id: req.id, error: { code: -32601, message: "unknown method" } });
  }
});
