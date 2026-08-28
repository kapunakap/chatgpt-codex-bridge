#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import process from "node:process";

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
let selected = 0;
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
let latest = { jobs: [], sessions: [], approvals: [], events: new Map() };
const viewNames = ["Conversation", "Events", "Raw log"];
const renderOnce = process.argv.includes("--once");

process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?1049h\x1b[?25l");
process.on("exit", restoreTerminal);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => quit());
process.stdout.on("resize", () => { dirty = true; });
process.stdin.on("data", data => { void handleKey(data); });

setInterval(() => { refresh(); dirty = true; }, 250).unref();
setInterval(() => { void probeReady(); }, 1500).unref();
setInterval(() => { if (dirty) render(); }, 80).unref();
await probeReady();
refresh();
render();
if (renderOnce) { restoreTerminal(); process.exit(0); }

function refresh() {
  const jobs = readJsonDir(jobsDir, file => file.endsWith(".json") && !file.endsWith(".pending.json") && !file.endsWith(".decision.json"))
    .filter(job => typeof job.jobId === "string")
    .sort((a, b) => rankJob(a) - rankJob(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const sessions = readJsonDir(sessionsDir, file => file.endsWith(".json"));
  const approvals = readJsonDir(approvalsDir, file => file.endsWith(".pending.json"));
  const events = new Map();
  for (const session of sessions) {
    const file = join(eventsDir, `${session.sessionId}.jsonl`);
    events.set(session.sessionId, readJsonl(file));
  }
  latest = { jobs, sessions, approvals, events };
  if (selected >= jobs.length) selected = Math.max(0, jobs.length - 1);
}

async function probeReady() {
  try {
    const response = await fetch(`http://${host}:${port}/readyz`, { signal: AbortSignal.timeout(800) });
    ready = response.ok ? await response.json() : null;
  } catch { ready = null; }
  dirty = true;
}

function readJsonDir(dir, keep) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!keep(file)) continue;
    try { out.push(JSON.parse(readFileSync(join(dir, file), "utf8"))); } catch { /* file may be mid-replace */ }
  }
  return out;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-400).map(line => JSON.parse(line));
  } catch { return []; }
}

function rankJob(job) {
  if (["starting", "running", "cancelling"].includes(job.status)) return 0;
  if (job.status === "queued") return 1;
  if (job.status === "failed" || job.status === "timed_out") return 2;
  return 3;
}

function sessionFor(job) {
  if (!job) return null;
  const candidates = latest.sessions.filter(session => session.cwd === job.cwd);
  const exact = job.threadId && candidates.find(session => session.threadId === job.threadId);
  if (exact) return exact;
  const active = candidates.filter(session => session.status !== "ended")
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (["starting", "running", "cancelling"].includes(job.status) && active.length) return active[0];
  return candidates.sort((a, b) => Math.abs((a.startedAt || 0) - (job.startedAt || 0)) - Math.abs((b.startedAt || 0) - (job.startedAt || 0)))[0] || null;
}

function approvalsFor(job) {
  const session = sessionFor(job);
  if (!session) return [];
  return latest.approvals.filter(item => item.sessionId === session.sessionId).sort((a, b) => a.createdAt - b.createdAt);
}

function currentEvents() {
  const session = sessionFor(latest.jobs[selected]);
  return session ? (latest.events.get(session.sessionId) || []) : [];
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
      try { return JSON.stringify(event).toLowerCase().includes(needle); }
      catch { return false; }
    });
  }
  return scoped;
}

function render() {
  dirty = false;
  const width = Math.max(80, process.stdout.columns || 120);
  const height = Math.max(24, process.stdout.rows || 36);
  const leftW = Math.max(24, Math.floor(width * 0.24));
  const rightW = Math.max(28, Math.floor(width * 0.26));
  const centerW = width - leftW - rightW - 4;
  const jobs = latest.jobs;
  const job = jobs[selected];
  const session = sessionFor(job);
  const approvals = approvalsFor(job);
  const events = scopedEvents(session ? (latest.events.get(session.sessionId) || []) : []);
  const lines = [];
  const tunnel = ready ? `${green("●")} Tunnel connected` : `${red("●")} Tunnel offline`;
  const adapter = ready?.version ? `Adapter v${ready.version}` : "Adapter ?";
  const running = jobs.filter(j => ["starting", "running", "cancelling"].includes(j.status)).length;
  const queued = jobs.filter(j => j.status === "queued").length;
  const held = latest.approvals.length;
  const followState = follow ? green("FOLLOW ●") : amber("FOLLOW ○");
  lines.push(padVisible(`${bold("LOCAL CODEX GUARD")}  ${tunnel}  ${dim(adapter)}  ${cyan(`${running} running`)}  ${dim(`${queued} queued`)}  ${held ? amber(`${held} APPROVAL REQUIRED`) : dim("0 held")}  ${followState}`, width));
  lines.push(dim("ChatGPT → Secure MCP Tunnel → Local Codex → Host"));
  lines.push("─".repeat(width));
  const bodyHeight = height - 6;
  const left = renderJobs(jobs, selected, leftW, bodyHeight);
  const center = renderCenter(job, session, approvals, events, centerW, bodyHeight);
  const right = renderInspector(job, session, approvals, rightW, bodyHeight);
  for (let i = 0; i < bodyHeight; i++) {
    lines.push(`${padVisible(left[i] || "", leftW)} │ ${padVisible(center[i] || "", centerW)} │ ${padVisible(right[i] || "", rightW)}`);
  }
  lines.push("─".repeat(width));
  const status = searching
    ? `${amber("SEARCH")} /${searchQuery}█  ${dim("Enter apply  Esc cancel  Backspace edit")}`
    : `${viewNames.map((name, index) => index === view ? bold(`[${name}]`) : dim(name)).join("  ")}   ${dim("↑↓/jk select  Tab view  f follow  / search  l output  d details  a/A/r approve  x kill  q quit")}`;
  lines.push(padVisible(status, width));
  process.stdout.write(`\x1b[H${lines.slice(0, height).join("\n")}`);
}

function renderJobs(jobs, selectedIndex, width, height) {
  const out = [bold("JOBS")];
  for (let i = 0; i < jobs.length && out.length < height; i++) {
    const job = jobs[i];
    const held = approvalsFor(job).length > 0;
    const state = held ? amber("! HOLD") : stateLabel(job.status);
    const name = basename(job.cwd || "?");
    const prefix = i === selectedIndex ? ">" : " ";
    out.push(crop(`${prefix} ${state} ${name}`, width));
    if (i === selectedIndex && out.length < height) out.push(dim(crop(`  ${short(job.jobId)} ${elapsed(job)}`, width)));
  }
  if (!jobs.length) out.push(dim("No jobs yet"));
  return out;
}

function renderCenter(job, session, approvals, events, width, height) {
  if (!job) return [bold("CONVERSATION"), dim("No Local Codex jobs found")];
  if (approvals.length) return renderApproval(approvals[0], job, width, height);
  const searchTag = searchQuery ? `  /${searchQuery}` : "";
  const out = [bold(`${basename(job.cwd)}  ${viewNames[view]}${searchTag}`), ""];
  if (!session) {
    out.push(dim(job.status === "queued" ? "Waiting for scheduler / folder lock…" : "No live guard session attached."));
    return out;
  }
  if (searchQuery && !events.length) {
    out.push(dim(`No visible events match /${searchQuery}`));
    return out;
  }
  if (view === 2) {
    for (const event of events.slice(-height + 3)) out.push(crop(JSON.stringify(event), width));
    return out;
  }
  if (view === 1) {
    for (const event of events.slice(-height + 3)) out.push(crop(formatEvent(event), width));
    return out;
  }
  const conversation = conversationLines(events, width);
  out.push(...conversation.slice(-(height - out.length)));
  return out;
}

function renderApproval(approval, job, width, height) {
  const params = approval.params || {};
  const command = Array.isArray(params.command) ? params.command.join(" ") : (params.command || params.commandActions?.[0]?.command || "File change / privileged action");
  const reason = params.reason || "Codex requested host authorization before continuing.";
  const target = params.networkApprovalContext?.host || detectTarget(command);
  const additional = params.additionalPermissions || {};
  const remoteWrite = /git\s+push|gh\s+(?:pr|issue|release|repo)|curl.*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)|upload|publish|npm\s+publish/i.test(command);
  const out = [
    amber(bold("⚠ ACTION REQUIRES HOST APPROVAL")), "",
    `${dim("Job")}       ${short(job.jobId)}`,
    `${dim("Workspace")} ${crop(job.cwd || "?", width - 10)}`,
    `${dim("Thread")}    ${short(approval.params?.threadId || sessionFor(job)?.threadId)}`,
    "", bold("PROPOSED ACTION"),
  ];
  for (const line of wrap(command, width)) out.push(bold(line));
  out.push("", bold("Reason"), ...wrap(reason, width));
  out.push("", bold("ACCESS CHANGE"));
  out.push(`Network access        ${approval.networkAccess ? amber("ENABLED") : green("OFF")}`);
  if (additional.network?.enabled) out.push(`Network delta         ${amber("OFF → ON")}`);
  out.push(`Remote write          ${remoteWrite ? red("POSSIBLE") : dim("not detected")}`);
  out.push(`Host credentials      ${approval.networkAccess ? amber("AVAILABLE") : green("FILTERED")}`);
  out.push(`Workspace writes      ${green("ALLOWED")}`);
  if (target) out.push(`External service      ${target}`);
  if (Object.keys(additional).length) out.push(`Additional perms      ${crop(compact(additional), Math.max(1, width - 22))}`);
  if (remoteWrite || additional.network?.enabled) out.push(red("RISK HIGH · authenticated/external write possible"));
  else out.push(amber("RISK REVIEW REQUIRED"));
  out.push("", amber("No action will execute until approved."));
  if (approvalDetails) {
    out.push("", bold("DETAILS"));
    out.push(`${dim("Method")}     ${crop(approval.method || "?", Math.max(1, width - 11))}`);
    out.push(`${dim("Request")}    ${crop(String(approval.requestId ?? "?"), Math.max(1, width - 11))}`);
    if (params.itemId) out.push(`${dim("Item")}       ${crop(params.itemId, Math.max(1, width - 11))}`);
    if (params.kind) out.push(`${dim("Kind")}       ${params.kind}`);
    if (Array.isArray(params.availableDecisions)) out.push(`${dim("Decisions")}  ${crop(params.availableDecisions.join(", "), Math.max(1, width - 11))}`);
    out.push(...wrap(JSON.stringify(params, null, 2), width).map(dim));
  }
  out.push("", "[a] Approve once   [A] Approve for this job", "[r] Reject          [x] Kill job   [d] Details");
  return out.slice(0, height);
}

function renderInspector(job, session, approvals, width, height) {
  const out = [bold("JOB INSPECTOR"), ""];
  if (!job) return out;
  const status = approvals.length ? amber("HOLD") : stateLabel(job.status);
  const fields = [
    ["STATUS", status], ["WORKSPACE", basename(job.cwd || "?")], ["MODEL", job.model || "pending"],
    ["REASONING", job.reasoningEffort || "pending"], ["NETWORK", job.networkAccess ? amber("ON") : green("OFF")],
    ["THREAD", short(job.threadId || session?.threadId)], ["JOB", short(job.jobId)], ["ELAPSED", elapsed(job)],
  ];
  for (const [key, value] of fields) out.push(`${dim(key.padEnd(11))}${crop(String(value), width - 11)}`);
  out.push("", bold("SCHEDULER"));
  out.push(`${dim("active".padEnd(11))}${ready?.activeCalls ?? "?"} / ${ready?.maxConcurrency ?? "?"}`);
  out.push(`${dim("queued".padEnd(11))}${ready?.queuedCalls ?? "?"}`);
  if (job.status === "queued") out.push(`${dim("folder lock".padEnd(11))}${basename(job.cwd || "?")}`);
  out.push("", bold("SANDBOX"));
  out.push(`${dim("workspace".padEnd(11))}write`);
  out.push(`${dim("network".padEnd(11))}${job.networkAccess ? amber("enabled") : "off"}`);
  out.push(`${dim("host auth".padEnd(11))}${job.networkAccess ? amber("available") : "filtered"}`);
  out.push(`${dim("cwd bound".padEnd(11))}${green("yes")}`);
  out.push("", `${dim("follow".padEnd(11))}${follow ? green("on") : amber("paused")}`);
  out.push(`${dim("output".padEnd(11))}${outputExpanded ? "expanded" : "collapsed"}`);
  if (searchQuery) out.push(`${dim("search".padEnd(11))}/${crop(searchQuery, Math.max(1, width - 12))}`);
  return out.slice(0, height);
}

function conversationLines(events, width) {
  const out = [];
  let assistant = "";
  const flushAssistant = () => {
    if (!assistant) return;
    out.push(cyan(bold("CODEX")), ...wrap(assistant, width));
    assistant = "";
  };
  for (const event of events) {
    if (event.type === "chatgpt.prompt") {
      flushAssistant(); out.push(bold("CHATGPT"), ...wrap(event.data?.text || "", width), "");
    } else if (event.type === "assistant.delta") {
      assistant += event.data?.text || "";
    } else if (["item.started", "item.completed"].includes(event.type)) {
      flushAssistant();
      const item = event.data?.item || {};
      if (/commandExecution/i.test(item.type || "")) {
        const command = Array.isArray(item.command) ? item.command.join(" ") : (item.command || "command");
        out.push(dim(`› ${crop(command, Math.max(1, width - 2))}`));
        const output = item.aggregatedOutput || item.output || item.stdout;
        if (typeof output === "string" && output.trim()) {
          const lines = wrap(output.trim(), width);
          if (!outputExpanded && lines.length > 3) {
            out.push(...lines.slice(0, 2).map(dim));
            out.push(dim(`▸ command output ${lines.length} lines · [l] expand`));
          } else {
            out.push(...lines.map(dim));
            if (outputExpanded && lines.length > 3) out.push(dim(`▾ command output ${lines.length} lines · [l] collapse`));
          }
        }
      } else if (/fileChange/i.test(item.type || "")) {
        out.push(dim(`› file change ${item.status || ""}`));
      }
    } else if (event.type === "turn.completed") {
      flushAssistant(); out.push(dim(`✓ turn ${event.data?.status || "completed"}`), "");
    }
  }
  flushAssistant();
  return out;
}

function formatEvent(event) {
  const time = event.time ? new Date(event.time).toLocaleTimeString([], { hour12: false }) : "";
  if (event.type === "assistant.delta") return `${time} assistant ${JSON.stringify(event.data?.text || "")}`;
  if (event.type === "chatgpt.prompt") return `${time} ChatGPT prompt ${crop(event.data?.text || "", 80)}`;
  if (event.type === "approval.requested") return `${time} SECURITY GATE awaiting host approval`;
  return `${time} ${event.type} ${compact(event.data)}`;
}

async function handleKey(data) {
  if (quitting) return;
  if (searching) {
    if (data === "\r" || data === "\n") { searching = false; dirty = true; return; }
    if (data === "\x1b") { searching = false; dirty = true; return; }
    if (data === "\x7f" || data === "\b") { searchQuery = searchQuery.slice(0, -1); dirty = true; return; }
    const printable = data.replace(/[\x00-\x1f\x7f]/g, "");
    if (printable) searchQuery = (searchQuery + printable).slice(0, 200);
    dirty = true;
    return;
  }
  if (data === "q" || data === "\u0003") return quit();
  if (data === "\t") { view = (view + 1) % viewNames.length; dirty = true; return; }
  if (data === "f") {
    follow = !follow;
    followCutoff = follow ? null : (currentEvents().at(-1)?.seq ?? 0);
    dirty = true;
    return;
  }
  if (data === "/") { searching = true; searchQuery = ""; dirty = true; return; }
  if (data === "l") { outputExpanded = !outputExpanded; dirty = true; return; }
  if (data === "d") { approvalDetails = !approvalDetails; dirty = true; return; }
  if (data === "j" || data === "\x1b[B") {
    selected = Math.max(0, Math.min(Math.max(0, latest.jobs.length - 1), selected + 1));
    followCutoff = null; approvalDetails = false; dirty = true; return;
  }
  if (data === "k" || data === "\x1b[A") {
    selected = Math.max(0, selected - 1);
    followCutoff = null; approvalDetails = false; dirty = true; return;
  }
  const job = latest.jobs[selected];
  const approval = approvalsFor(job)[0];
  if (data === "a" && approval) return decide(approval, "accept");
  if (data === "A" && approval) return decide(approval, "acceptForSession");
  if (data === "r" && approval) return decide(approval, "decline");
  if (data === "x" && job) return cancelJob(job.jobId);
}

function decide(approval, decision) {
  const target = join(approvalsDir, `${approval.approvalId}.decision.json`);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ decision, decidedAt: Date.now() })}\n`, { mode: 0o600 });
  renameSync(temp, target);
  dirty = true;
}

async function cancelJob(jobId) {
  try {
    const authorization = readFileSync(tokenFile, "utf8").trim();
    await fetch(`http://${host}:${port}/mcp`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `watch-${Date.now()}`, method: "tools/call", params: { name: "codex-cancel", arguments: { jobId } } }),
      signal: AbortSignal.timeout(1500),
    });
  } catch { /* visible state will remain unchanged if cancellation failed */ }
  dirty = true;
}

function quit() {
  if (quitting) return;
  quitting = true;
  restoreTerminal();
  process.exit(0);
}
function restoreTerminal() {
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
  try { process.stdout.write("\x1b[?25h\x1b[?1049l"); } catch {}
}
function stateLabel(status) {
  if (status === "queued") return dim("○ QUE");
  if (["starting", "running", "cancelling"].includes(status)) return cyan("● RUN");
  if (status === "completed") return green("✓ DONE");
  if (status === "cancelled" || status === "interrupted") return dim("■ STOP");
  return red("✕ FAIL");
}
function short(value) { return value ? String(value).slice(0, 8) : "—"; }
function elapsed(job) {
  const ms = Math.max(0, (job.finishedAt || Date.now()) - (job.startedAt || Date.now()));
  const sec = Math.floor(ms / 1000); return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}
function detectTarget(command) {
  const match = String(command).match(/(?:https?:\/\/|git@)([A-Za-z0-9.-]+)/i); return match?.[1] || (/git\s+push/i.test(command) ? "git remote" : "");
}
function compact(value) { try { return crop(JSON.stringify(value), 100); } catch { return ""; } }
function wrap(text, width) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw;
    while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    out.push(line);
  }
  return out;
}
function crop(text, width) { const plain = stripAnsi(String(text)); return plain.length <= width ? String(text) : `${plain.slice(0, Math.max(0, width - 1))}…`; }
function padVisible(text, width) { const value = crop(String(text), width); return value + " ".repeat(Math.max(0, width - stripAnsi(value).length)); }
function stripAnsi(value) { return value.replace(/\x1b\[[0-9;]*m/g, ""); }
function color(code, text) { return `\x1b[${code}m${text}\x1b[0m`; }
function bold(text) { return color("1", text); }
function dim(text) { return color("2", text); }
function red(text) { return color("31", text); }
function green(text) { return color("32", text); }
function amber(text) { return color("33", text); }
function cyan(text) { return color("36", text); }
