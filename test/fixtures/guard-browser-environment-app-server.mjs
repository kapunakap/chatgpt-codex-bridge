#!/usr/bin/env node

import readline from "node:readline";

const modeIndex = process.argv.indexOf("--case");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "browser";
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);

readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method !== "turn/start") return;

  send({ id: message.id, result: { turn: { id: "turn-browser", status: "inProgress" } } });
  send({ method: "turn/started", params: { threadId: "thread-browser", turn: { id: "turn-browser" } } });

  const aggregatedOutput = mode === "browser"
    ? [
        "FATAL:base/apple/mach_port_rendezvous_mac.cc:159 Check failed: kr == KERN_SUCCESS.",
        "bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.1234: Permission denied (1100)",
        "exception while trying to kill process: Error: kill EPERM",
      ].join("\n")
    : "open /private/example: Permission denied (13)";

  send({
    method: "item/completed",
    params: {
      threadId: "thread-browser",
      item: {
        id: "cmd-browser",
        type: "commandExecution",
        command: ["npx", "playwright", "test"],
        status: "failed",
        exitCode: 1,
        aggregatedOutput,
      },
    },
  });
  send({ method: "turn/completed", params: { threadId: "thread-browser", turn: { id: "turn-browser", status: "completed" } } });
  setTimeout(() => process.exit(0), 20);
});
