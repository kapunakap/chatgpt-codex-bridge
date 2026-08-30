#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  buildMonitorFrame,
  serializeMonitorFrame,
  VIEW_NAMES,
} from "./local-codex-watch-render.mjs";

const jobsDir = process.env.LOCAL_CODEX_JOBS_DIR;
const stateFile = process.env.LOCAL_CODEX_STATE_FILE;
const tokenFile = process.env.LOCAL_CODEX_TOKEN_FILE;
const host = process.env.LOCAL_CODEX_HOST || "127.0.0.1";
const port = Number(process.env.LOCAL_CODEX_PORT || "8765");
if (!jobsDir || !stateFile || !tokenFile) {
  process.stderr.write("local-codex watch requires LOCAL_CODEX_JOBS_DIR, LOCAL_CODEX_STATE_FILE, and LOCAL_CODEX_TOKEN_FILE\n");
  process.exit(2);
}

const guardDir = join(dirname(stateFile), "guard");
const sessionsDir = join(guardDir, "sessions");
const eventsDir = join(guardDir, "events");
const approvalsDir = join(guardDir, "approvals");
const jobEventsDir = process.env.LOCAL_CODEX_JOB_EVENTS_DIR || join(dirname(stateFile), "job-events");
const renderOnce = process.argv.includes("--once");
const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
let selectedJobId = null;
let view = 0;
let dirty = true;
let quitting = false;
let ready = null;
let follow = true;
let followCutoff = null;
let outputExpanded = false;
let approvalDetails = false;
let searching = false;
let searchQuery = "";
let terminalRestored = false;
let latest = { jobs: [], sessions: [], approvals: [] };

process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?1049h\x1b[?25l");
process.on("exit", restoreTerminal);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => quit());
}
process.stdout.on("resize", () => {
  dirty = true;
});
process.stdin.on("data", data => {
  void handleKey(data);
});

setInterval(() => {
  refresh();
  dirty = true;
}, 250).unref();
setInterval(() => {
  void probeReady();
}, 1500).unref();
setInterval(() => {
  if (dirty) render();
}, 80).unref();

await probeReady();
refresh();
render();
if (renderOnce) {
  restoreTerminal();
  process.exit(0);
}

function refresh() {
  const jobs = readJsonDir(
    jobsDir,
    file => file.endsWith(".json") &&
      !file.endsWith(".pending.json") &&
      !file.endsWith(".decision.json")
  )
    .filter(job => typeof job.jobId === "string")
    .sort((a, b) => rankJob(a) - rankJob(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const sessions = readJsonDir(sessionsDir, file => file.endsWith(".json"));
  const jobById = new Map(jobs.map(job => [job.jobId, job]));
  const sessionById = new Map(sessions.map(session => [session.sessionId, session]));
  const approvals = readJsonDir(approvalsDir, file => file.endsWith(".pending.json"))
    .filter(approval => {
      if (approval.jobId) {
        const job = jobById.get(approval.jobId);
        return Boolean(job && !terminalStatuses.has(job.status));
      }
      if (approval.sessionId) {
        const session = sessionById.get(approval.sessionId);
        return Boolean(session && session.status !== "ended");
      }
      return false;
    });
  latest = { jobs, sessions, approvals };
  if (!selectedJobId || !jobById.has(selectedJobId)) {
    selectedJobId = jobs[0]?.jobId || null;
  }
}

async function probeReady() {
  try {
    const response = await fetch("http://" + host + ":" + String(port) + "/readyz", {
      signal: AbortSignal.timeout(800),
    });
    ready = response.ok ? await response.json() : null;
  } catch {
    ready = null;
  }
  dirty = true;
}

function readJsonDir(directory, keep) {
  if (!existsSync(directory)) return [];
  const output = [];
  for (const file of readdirSync(directory)) {
    if (!keep(file)) continue;
    try {
      output.push(JSON.parse(readFileSync(join(directory, file), "utf8")));
    } catch {
      // A file may be between its temporary and final names.
    }
  }
  return output;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-400)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function rankJob(job) {
  if (["starting", "running", "cancelling"].includes(job.status)) return 0;
  if (job.status === "queued") return 1;
  return 2;
}

function sessionFor(job) {
  if (!job) return null;
  const candidates = latest.sessions.filter(session => session.cwd === job.cwd);
  const exact = job.threadId
    ? candidates.filter(session => session.threadId === job.threadId)
    : [];
  if (exact.length) return nearestSession(exact, job);
  const active = candidates
    .filter(session => session.status !== "ended")
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (["starting", "running", "cancelling"].includes(job.status) && active.length) {
    return active[0];
  }
  return nearestSession(candidates, job);
}

function nearestSession(candidates, job) {
  return [...candidates].sort((a, b) => {
    return Math.abs((a.startedAt || 0) - (job.startedAt || 0)) -
      Math.abs((b.startedAt || 0) - (job.startedAt || 0));
  })[0] || null;
}

function approvalsFor(job) {
  if (!job) return [];
  const session = sessionFor(job);
  return latest.approvals
    .filter(item => item.jobId === job.jobId || (session && item.sessionId === session.sessionId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function currentEvents() {
  const job = selectedJob();
  return eventsFor(job, sessionFor(job));
}

function eventsFor(job, session) {
  if (!job) return [];
  const persisted = readJsonl(join(jobEventsDir, job.jobId + ".jsonl"));
  if (persisted.length) return persisted;
  return session ? readJsonl(join(eventsDir, session.sessionId + ".jsonl")) : [];
}

function selectedIndex() {
  return Math.max(0, latest.jobs.findIndex(job => job.jobId === selectedJobId));
}

function selectedJob() {
  return latest.jobs.find(job => job.jobId === selectedJobId) || null;
}

function scopedEvents(events) {
  let scoped = events;
  if (!follow) {
    if (followCutoff === null) followCutoff = events.at(-1)?.seq ?? 0;
    scoped = scoped.filter(event => (event.seq ?? 0) <= followCutoff);
  }
  if (searchQuery) {
    const needle = searchQuery.toLowerCase();
    scoped = scoped.filter(event => {
      try {
        return JSON.stringify(event).toLowerCase().includes(needle);
      } catch {
        return false;
      }
    });
  }
  return scoped;
}

function render() {
  dirty = false;
  const width = process.stdout.columns || 120;
  const height = process.stdout.rows || 36;
  const selected = selectedIndex();
  const job = selectedJob();
  const session = sessionFor(job);
  const approvals = approvalsFor(job);
  const events = scopedEvents(eventsFor(job, session));
  const jobs = latest.jobs.map(candidate => {
    return { ...candidate, held: approvalsFor(candidate).length > 0 };
  });
  const threadCount = new Set([
    ...latest.jobs.map(candidate => candidate.threadId),
    ...latest.sessions.map(candidate => candidate.threadId),
  ].filter(Boolean)).size;
  const lines = buildMonitorFrame({
    width,
    height,
    now: Date.now(),
    jobs,
    selectedIndex: selected,
    job,
    session,
    approvals,
    events,
    view,
    follow,
    outputExpanded,
    approvalDetails,
    searching,
    searchQuery,
    ready,
    heldCount: latest.approvals.length,
    threadCount,
    homeDir: process.env.HOME || "",
  });
  process.stdout.write(serializeMonitorFrame(lines));
}

async function handleKey(data) {
  if (quitting) return;
  if (searching) {
    if (data === "\r" || data === "\n") {
      searching = false;
      dirty = true;
      return;
    }
    if (data === "\x1b") {
      searching = false;
      dirty = true;
      return;
    }
    if (data === "\x7f" || data === "\b") {
      searchQuery = searchQuery.slice(0, -1);
      dirty = true;
      return;
    }
    const printable = data.replace(/[\x00-\x1f\x7f]/g, "");
    if (printable) searchQuery = (searchQuery + printable).slice(0, 200);
    dirty = true;
    return;
  }
  if (data === "q" || data === "\u0003") return quit();
  if (data === "\t") {
    view = (view + 1) % VIEW_NAMES.length;
    dirty = true;
    return;
  }
  if (data === "f") {
    follow = !follow;
    followCutoff = follow ? null : (currentEvents().at(-1)?.seq ?? 0);
    dirty = true;
    return;
  }
  if (data === "/") {
    searching = true;
    searchQuery = "";
    dirty = true;
    return;
  }
  if (data === "l") {
    outputExpanded = !outputExpanded;
    dirty = true;
    return;
  }
  if (data === "d") {
    approvalDetails = !approvalDetails;
    dirty = true;
    return;
  }
  if (data === "j" || data === "\x1b[B") {
    const selected = selectedIndex();
    const next = Math.max(0, Math.min(Math.max(0, latest.jobs.length - 1), selected + 1));
    selectedJobId = latest.jobs[next]?.jobId || null;
    followCutoff = null;
    approvalDetails = false;
    dirty = true;
    return;
  }
  if (data === "k" || data === "\x1b[A") {
    const selected = selectedIndex();
    const next = Math.max(0, selected - 1);
    selectedJobId = latest.jobs[next]?.jobId || null;
    followCutoff = null;
    approvalDetails = false;
    dirty = true;
    return;
  }
  const job = selectedJob();
  const approval = approvalsFor(job)[0];
  if (data === "a" && approval) return decide(approval, "accept");
  if (data === "A" && approval) return decide(approval, "acceptForSession");
  if (data === "r" && approval) return decide(approval, "decline");
  if (data === "x" && job) return cancelJob(job.jobId);
}

function decide(approval, decision) {
  const target = join(approvalsDir, approval.approvalId + ".decision.json");
  const temporary = target + "." + String(process.pid) + ".tmp";
  writeFileSync(temporary, JSON.stringify({ decision, decidedAt: Date.now() }) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, target);
  dirty = true;
}

async function cancelJob(jobId) {
  try {
    const authorization = readFileSync(tokenFile, "utf8").trim();
    await fetch("http://" + host + ":" + String(port) + "/mcp", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "watch-" + String(Date.now()),
        method: "tools/call",
        params: {
          name: "codex-cancel",
          arguments: { jobId },
        },
      }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Visible state stays unchanged if cancellation fails.
  }
  dirty = true;
}

function quit() {
  if (quitting) return;
  quitting = true;
  restoreTerminal();
  process.exit(0);
}

function restoreTerminal() {
  if (terminalRestored) return;
  terminalRestored = true;
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {}
  try {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  } catch {}
}
