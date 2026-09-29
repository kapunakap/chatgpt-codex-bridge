import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { TraceStore, folderFingerprint, normalizeErrorCode } from "./observability.mjs";

async function fixture(options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "local-codex-trace-test-"));
  const store = await new TraceStore({
    logFile: resolve(root, "trace-events.jsonl"),
    stateDir: resolve(root, "traces"),
    maxBytes: options.maxBytes ?? 1024 * 1024,
    rotations: options.rotations ?? 3,
  }).init();
  return { root, store };
}

test("structured trace log is allowlisted and private", async () => {
  const { store } = await fixture();
  store.append({
    source: "proxy",
    event: "mcp.request.received",
    traceId: "trc-test",
    jobId: "job-test",
    prompt: "SECRET PROMPT",
    authorization: "Bearer secret",
    cwd: "/Users/example/private",
    content: "SECRET RESULT",
    reasoning: "hidden",
    errorCode: "storage_error",
  });
  const text = await readFile(store.logFile, "utf8");
  assert.match(text, /mcp\.request\.received/);
  assert.match(text, /storage_failed/);
  for (const secret of ["SECRET PROMPT", "Bearer secret", "/Users/example/private", "SECRET RESULT", "hidden"]) {
    assert.equal(text.includes(secret), false);
  }
  assert.equal((await stat(store.logFile)).mode & 0o077, 0);
});

test("trace rotation is bounded", async () => {
  const { store } = await fixture({ maxBytes: 1024, rotations: 2 });
  for (let i = 0; i < 80; i += 1) {
    store.append({ source: "proxy", event: "job.progress", traceId: "trc-rotate", jobId: "job-rotate", detail: "x".repeat(200) });
  }
  const rotated1 = await stat(`${store.logFile}.1`);
  assert.ok(rotated1.size > 0);
  const rotated2 = await stat(`${store.logFile}.2`);
  assert.ok(rotated2.size > 0);
  await assert.rejects(stat(`${store.logFile}.3`));
});

test("job/folder trace state and receipt survive separate reads", async () => {
  const { store } = await fixture();
  const fp = folderFingerprint("/tmp/example");
  store.saveJobTrace("job-1", { traceId: "trc-1", jobId: "job-1", tool: "codex", requestHash: "sha256:123", folderFingerprint: fp, createdAt: 1000 });
  store.saveFolderTrace(fp, { traceId: "trc-1", jobId: "job-1", createdAt: Date.now() });
  assert.equal((await store.loadFolderTrace(fp)).traceId, "trc-1");
  store.append({ time: "2026-09-09T10:00:00.000Z", source: "proxy", event: "job.accepted", traceId: "trc-1", jobId: "job-1", adapterVersion: "3.6.0" });
  store.append({ time: "2026-09-09T10:00:01.000Z", source: "runtime", event: "codex.app_server.ready", traceId: "trc-1", jobId: "job-1", stageDurationMs: 1000 });
  store.append({ time: "2026-09-09T10:00:02.000Z", source: "runtime", event: "codex.turn.completed", traceId: "trc-1", jobId: "job-1", terminalOutcome: "completed" });
  store.append({ time: "2026-09-09T10:00:02.050Z", source: "proxy", event: "job.terminal.observed", traceId: "trc-1", jobId: "job-1", terminalOutcome: "completed", pollGapMs: 50 });
  store.saveJobTrace("job-1", { ...(await store.loadJobTrace("job-1")), traceId: "trc-1", lastStatus: "completed", terminalObserved: true });
  const receipt = await store.receipt("job-1");
  assert.equal(receipt.pass, true);
  assert.equal(receipt.traceId, "trc-1");
  assert.equal(receipt.terminalOutcome, "completed");
  assert.equal(receipt.bridge.adapterVersion, "3.6.0");
  assert.deepEqual(receipt.observedStages, ["job.accepted", "codex.app_server.ready", "codex.turn.completed", "job.terminal.observed"]);
});

test("error taxonomy keeps stable existing codes and normalizes infrastructure aliases", () => {
  assert.equal(normalizeErrorCode("spawn_failed"), "app_server_start_failed");
  assert.equal(normalizeErrorCode("timeout"), "execution_timed_out");
  assert.equal(normalizeErrorCode("polling_expired"), "polling_expired");
});
