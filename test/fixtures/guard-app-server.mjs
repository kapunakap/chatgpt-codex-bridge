#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const trace = process.argv[process.argv.indexOf("--trace") + 1];
const exitWhileHeld = process.argv.includes("--exit-while-held");
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  appendFileSync(trace, `${JSON.stringify(message)}\n`);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "guard-test" } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    send({ method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", delta: "PRIVATE_REASONING" } });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: "Visible answer" } });
    send({ method: "item/started", params: { threadId: "thread-1", item: { id: "cmd-1", type: "commandExecution", command: ["git", "push", "origin", "main"], status: "inProgress" } } });
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", command: ["git", "push", "origin", "main"], cwd: process.cwd(), reason: "Publish branch", availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    } });
    if (exitWhileHeld) setTimeout(() => process.exit(0), 20);
    return;
  }
  if (message.id === "approval-1") {
    send({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "approval-1" } });
    send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "cmd-1", type: "commandExecution", command: ["git", "push", "origin", "main"], status: message.result?.decision === "accept" ? "completed" : "declined", aggregatedOutput: "done" } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    setTimeout(() => process.exit(0), 20);
  }
});
