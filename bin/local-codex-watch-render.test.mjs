import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import {
  buildMonitorFrame,
  MIN_MONITOR_HEIGHT,
  MIN_MONITOR_WIDTH,
  serializeMonitorFrame,
  visibleWidth,
} from "./local-codex-watch-render.mjs";

const now = Date.UTC(2026, 7, 29, 10, 24, 38);

function fixture(overrides = {}) {
  const jobs = [
    {
      jobId: "af4b29ff-1111-1111-1111-111111111111",
      status: "running",
      cwd: "/Users/onin/dev/gta-labin",
      threadId: "01a04550-1111-1111-1111-111111111111",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      networkAccess: false,
      startedAt: now - 161000,
      updatedAt: now,
    },
    {
      jobId: "22222222-2222-2222-2222-222222222222",
      status: "queued",
      cwd: "/Users/onin/dev/meetlane-webapp",
      threadId: "thread-2",
      model: null,
      reasoningEffort: null,
      networkAccess: false,
      startedAt: now - 45000,
      updatedAt: now,
    },
    {
      jobId: "33333333-3333-3333-3333-333333333333",
      status: "completed",
      cwd: "/Users/onin/dev/upwork-api-jobs",
      threadId: "thread-3",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      networkAccess: true,
      startedAt: now - 252000,
      finishedAt: now,
      updatedAt: now,
    },
    {
      jobId: "44444444-4444-4444-4444-444444444444",
      status: "failed",
      cwd: "/Users/onin/dev/instill-proxy",
      threadId: "thread-4",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      networkAccess: false,
      startedAt: now - 93000,
      finishedAt: now,
      updatedAt: now,
    },
    {
      jobId: "55555555-5555-5555-5555-555555555555",
      status: "cancelled",
      cwd: "/Users/onin/dev/chatgpt-codex-bridge",
      threadId: "thread-5",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      networkAccess: false,
      startedAt: now - 33000,
      finishedAt: now,
      updatedAt: now,
    },
  ];
  const events = [
    {
      seq: 1,
      time: new Date(now - 10000).toISOString(),
      type: "chatgpt.prompt",
      data: {
        text: "Inspect issue #14 and make the monitor match the desired screenshot.",
      },
    },
    {
      seq: 2,
      time: new Date(now - 9000).toISOString(),
      type: "assistant.delta",
      data: { text: "I found the terminal width error." },
    },
    {
      seq: 3,
      time: new Date(now - 8000).toISOString(),
      type: "item.started",
      data: {
        item: {
          id: "command-1",
          type: "commandExecution",
          command: ["npm", "test"],
        },
      },
    },
    {
      seq: 4,
      time: new Date(now - 7000).toISOString(),
      type: "item.completed",
      data: {
        item: {
          id: "command-1",
          type: "commandExecution",
          command: ["npm", "test"],
          aggregatedOutput: "line one\nline two\nline three\nline four\nline five\nline six",
        },
      },
    },
  ];
  return {
    width: 118,
    height: 47,
    now,
    jobs,
    selectedIndex: 0,
    job: jobs[0],
    session: {
      sessionId: "session-1",
      cwd: jobs[0].cwd,
      threadId: jobs[0].threadId,
      status: "running",
    },
    approvals: [],
    events,
    view: 0,
    follow: true,
    outputExpanded: false,
    approvalDetails: false,
    searching: false,
    searchQuery: "",
    ready: {
      activeCalls: 1,
      queuedCalls: 1,
      maxConcurrency: 4,
    },
    heldCount: 0,
    threadCount: 5,
    homeDir: "/Users/onin",
    ...overrides,
  };
}

function assertGeometry(lines, width, height) {
  assert.equal(lines.length, height);
  for (const [index, line] of lines.entries()) {
    assert.equal(
      visibleWidth(line),
      width,
      "row " + String(index + 1) + " must occupy exactly " + String(width) + " columns"
    );
  }
}

test("renderer matches the three-pane monitor at the reported 118x47 size", () => {
  const lines = buildMonitorFrame(fixture());
  assertGeometry(lines, 118, 47);
  const plain = lines.map(stripVTControlCharacters).join("\n");

  assert.match(plain, /LOCAL CODEX MONITOR/);
  assert.match(plain, /tunnel connected/);
  assert.match(plain, /active 1\/4/);
  assert.match(plain, /queued 1/);
  assert.match(plain, /threads 5/);
  assert.match(plain, /┌─+┬─+┬─+┐/);
  assert.match(plain, /JOBS\s+AGE/);
  assert.match(plain, /● RUN\s+gta-labin\s+2m/);
  assert.match(plain, /○ QUE\s+meetlane-webapp\s+45s/);
  assert.match(plain, /✓ DONE\s+upwork-api-jobs\s+0s/);
  assert.match(plain, /✕ FAIL\s+instill-proxy\s+0s/);
  assert.match(plain, /■ STOP\s+chatgpt-codex-brid…\s+0s/);
  assert.match(plain, /ChatGPT ↔ Local Codex · Conversation/);
  assert.match(plain, /command output 6 lines/);
  assert.match(plain, /JOB INSPECTOR/);
  assert.match(plain, /~\/dev\/gta-labin/);
  assert.match(plain, /folder lock│ gta-labin/);
  assert.match(plain, /Conversation\s+Events\s+Raw log/);
  assert.match(plain, /↑↓\/jk select/);
  assert.match(lines.join(""), /\x1b\[44;97;1m/);
});

test("renderer stays bounded at minimum and wide terminal sizes", () => {
  for (const [width, height] of [[80, 24], [160, 55], [118, 47]]) {
    const lines = buildMonitorFrame(fixture({ width, height }));
    assertGeometry(lines, width, height);
  }
});

test("Jobs shows relative age while Inspector keeps elapsed duration", () => {
  const jobs = [
    {
      ...fixture().jobs[0],
      startedAt: now - 12000,
      updatedAt: now,
    },
    {
      ...fixture().jobs[1],
      startedAt: now - 4 * 60 * 1000,
      updatedAt: now,
    },
    {
      ...fixture().jobs[2],
      startedAt: now - 5 * 60 * 60 * 1000,
      finishedAt: now - 2 * 60 * 60 * 1000,
      updatedAt: now - 2 * 60 * 60 * 1000,
    },
    {
      ...fixture().jobs[3],
      startedAt: now - 4 * 24 * 60 * 60 * 1000,
      finishedAt: now - 3 * 24 * 60 * 60 * 1000,
      updatedAt: now - 3 * 24 * 60 * 60 * 1000,
    },
  ];
  const lines = buildMonitorFrame(fixture({
    jobs,
    job: jobs[0],
    selectedIndex: 0,
  }));
  const plain = lines.map(stripVTControlCharacters).join("\n");
  assert.match(plain, /JOBS\s+AGE/);
  assert.match(plain, /● RUN\s+gta-labin\s+12s/);
  assert.match(plain, /○ QUE\s+meetlane-webapp\s+4m/);
  assert.match(plain, /✓ DONE\s+upwork-api-jobs\s+2h/);
  assert.match(plain, /✕ FAIL\s+instill-proxy\s+3d/);
  assert.match(plain, /ELAPSED\s+│ 00:12/);
  assert.doesNotMatch(plain, /✓ DONE\s+upwork-api-jobs\s+03:00/);
});

test("renderer produces a bounded resize message below the minimum size", () => {
  const width = MIN_MONITOR_WIDTH - 10;
  const height = MIN_MONITOR_HEIGHT - 4;
  const lines = buildMonitorFrame(fixture({ width, height }));
  assertGeometry(lines, width, height);
  const plain = lines.join("\n");
  assert.match(plain, /Terminal is too small/);
  assert.match(plain, /Resize to at least 80x24/);
});

test("serialized frames clear and address rows without newline wrapping", () => {
  const lines = buildMonitorFrame(fixture());
  const output = serializeMonitorFrame(lines);
  assert.ok(output.startsWith("\x1b[H\x1b[2J\x1b[1;1H"));
  assert.match(output, /\x1b\[47;1H/);
  assert.doesNotMatch(output, /\n/);
});

test("resizing rebuilds a fresh aligned frame", () => {
  const wide = buildMonitorFrame(fixture({ width: 160, height: 55 }));
  const normal = buildMonitorFrame(fixture({ width: 118, height: 47 }));
  const minimum = buildMonitorFrame(fixture({ width: 80, height: 24 }));
  assertGeometry(wide, 160, 55);
  assertGeometry(normal, 118, 47);
  assertGeometry(minimum, 80, 24);
  assert.notEqual(wide[1], normal[1]);
  assert.notEqual(normal[1], minimum[1]);
});
