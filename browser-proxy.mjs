#!/usr/bin/env node

import { createConnection } from "node:net";
import process from "node:process";
import readline from "node:readline";

const values = process.argv.slice(2);
const socketIndex = values.indexOf("--socket");
const tokenIndex = values.indexOf("--token");
const socketPath = socketIndex >= 0 ? values[socketIndex + 1] : null;
const token = tokenIndex >= 0 ? values[tokenIndex + 1] : null;
if (!socketPath || !token) throw new Error("Official Browser proxy configuration is missing");

const socket = createConnection(socketPath);
let connected = false;
const queued = [];
socket.setEncoding("utf8");
socket.on("connect", () => {
  connected = true;
  socket.write(`${JSON.stringify({ token })}\n`);
  for (const line of queued.splice(0)) socket.write(`${line}\n`);
});
socket.on("data", chunk => process.stdout.write(chunk));
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  if (connected) socket.write(`${line}\n`);
  else queued.push(line);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => socket.destroy());
}
