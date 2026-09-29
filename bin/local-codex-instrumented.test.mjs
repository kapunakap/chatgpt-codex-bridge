import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { TraceStore, folderFingerprint } from "../observability.mjs";

const wrapper = resolve(import.meta.dirname, "local-codex-instrumented.mjs");

test("instrumented Codex wrapper records app-server/thread/turn/cleanup stages without prompt", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "instrumented-codex-test-"));
  const fake = resolve(root, "fake-secure.mjs");
  await writeFile(fake, `#!/usr/bin/env node\nlet buffer='';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => {\n buffer += chunk;\n for (;;) {\n  const i=buffer.indexOf('\\n'); if(i<0) break;\n  const line=buffer.slice(0,i).trim(); buffer=buffer.slice(i+1); if(!line) continue;\n  const m=JSON.parse(line);\n  if(m.method==='initialize') process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n');\n  else if(m.method==='thread/start') process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'thread-1'}}})+'\\n');\n  else if(m.method==='turn/start') {\n   process.stdout.write(JSON.stringify({id:m.id,result:{turn:{id:'turn-1'}}})+'\\n');\n   process.stdout.write(JSON.stringify({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}})+'\\n');\n   process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}})+'\\n');\n   setTimeout(()=>process.exit(0),20);\n  }\n }\n});\n`, { mode: 0o755 });
  await chmod(fake, 0o755);
  const logFile = resolve(root, "trace-events.jsonl");
  const stateDir = resolve(root, "traces");
  const store = await new TraceStore({ logFile, stateDir }).init();
  const fp = folderFingerprint(root);
  store.saveFolderTrace(fp, { traceId: "trc-runtime-test", jobId: "job-runtime-test", createdAt: Date.now() });

  const child = spawn(process.execPath, [wrapper, "app-server", "--listen", "stdio://"], {
    cwd: root,
    env: {
      ...process.env,
      LOCAL_CODEX_SECURE_BIN: fake,
      LOCAL_CODEX_TRACE_LOG_FILE: logFile,
      LOCAL_CODEX_TRACE_STATE_DIR: stateDir,
      LOCAL_CODEX_STATE_FILE: resolve(root, "threads.json"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const prompt = "SUPER_SECRET_PROMPT";
  child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root } })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: prompt }] } })}\n`);
  const exit = await new Promise(resolvePromise => child.on("exit", (code, signal) => resolvePromise({ code, signal })));
  assert.equal(exit.code, 0);
  assert.match(stdout, /turn\/completed/);
  const log = await readFile(logFile, "utf8");
  assert.equal(log.includes(prompt), false);
  assert.equal(log.includes(root), false);
  for (const event of [
    "codex.process.started",
    "codex.app_server.initialize.requested",
    "codex.app_server.ready",
    "codex.thread.requested",
    "codex.thread.started",
    "codex.turn.requested",
    "codex.turn.submitted",
    "codex.turn.started",
    "codex.turn.completed",
    "job.cleanup.started",
    "job.cleanup.completed",
  ]) assert.match(log, new RegExp(event.replaceAll(".", "\\.")));
  assert.match(log, /trc-runtime-test/);
  assert.match(log, /job-runtime-test/);
});
