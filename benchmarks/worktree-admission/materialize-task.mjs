#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { fileURLToPath } from "node:url";

const taskSourceCommit = "0fdfa620d5d99ee5f40d3bc688d714f834fb2802";
const taskSourceTree = "be26240abf23a476fb940ccf5b0a307b8c3535e0";
const benchmarkDir = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if ((argv[index] === "--repo" || argv[index] === "--destination") && argv[index + 1]) values[argv[index++].slice(2)] = argv[index];
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  if (!values.repo || !values.destination) throw new Error("Both --repo and --destination are required");
  return values;
}

function childStatus(child) {
  return new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveStatus({ code, signal }));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = await realpath(resolve(options.repo));
  let destination = resolve(options.destination);
  destination = join(await realpath(dirname(destination)), basename(destination));
  const rel = relative(repo, destination);
  const insideSource = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (insideSource) {
    throw new Error("Destination must be outside the source checkout");
  }
  try {
    await lstat(destination);
    throw new Error("Destination must not already exist; use a new empty directory");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: destination,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const tree = await new Promise((resolveTree, reject) => {
    const child = spawn("git", ["-C", repo, "rev-parse", `${taskSourceCommit}^{tree}`], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolveTree(stdout.trim()) : reject(new Error(stderr.trim() || "Unable to verify pinned source tree")));
  });
  if (tree !== taskSourceTree) throw new Error(`Pinned source tree mismatch: expected ${taskSourceTree}, got ${tree}`);

  await mkdir(destination, { recursive: false, mode: 0o700 });
  const archive = spawn("git", ["-C", repo, "archive", "--format=tar", taskSourceCommit], { env, stdio: ["ignore", "pipe", "pipe"] });
  const extract = spawn("tar", ["-x", "-C", destination], { env, stdio: ["pipe", "ignore", "pipe"] });
  const archiveDone = childStatus(archive);
  const extractDone = childStatus(extract);
  let archiveStderr = "";
  let extractStderr = "";
  archive.stderr.on("data", chunk => { archiveStderr += chunk.toString(); });
  extract.stderr.on("data", chunk => { extractStderr += chunk.toString(); });
  const hash = createHash("sha256");
  let archiveBytes = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      archiveBytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(archive.stdout, meter, extract.stdin);
    const [gitStatus, tarStatus] = await Promise.all([archiveDone, extractDone]);
    if (gitStatus.code !== 0) throw new Error(archiveStderr.trim() || "git archive failed");
    if (tarStatus.code !== 0) throw new Error(extractStderr.trim() || "tar extraction failed");
    const taskFile = join(benchmarkDir, "TASK.md");
    await copyFile(taskFile, join(destination, "BENCHMARK_TASK.md"));
    const taskBytes = await (await import("node:fs/promises")).readFile(taskFile);
    process.stdout.write(`${JSON.stringify({
      task_source_commit: taskSourceCommit,
      task_source_tree: taskSourceTree,
      verified_tree: tree,
      archive_sha256: hash.digest("hex"),
      archive_bytes: archiveBytes,
      task_sha256: createHash("sha256").update(taskBytes).digest("hex"),
      destination,
      included_git_history: false,
      included_reference_or_grader: false,
    }, null, 2)}\n`);
  } catch (error) {
    try { archive.kill("SIGTERM"); } catch {}
    try { extract.kill("SIGTERM"); } catch {}
    await Promise.allSettled([archiveDone, extractDone]);
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});
