import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorktreeManager } from "./worktree-manager.mjs";

const firstId = "11111111-1111-1111-1111-111111111111";
const secondId = "22222222-2222-2222-2222-222222222222";

test("rejects unsafe roots and retention values", async () => {
  await assert.rejects(createWorktreeManager({ rootDir: "relative", stateDir: "/private/tmp/state", retention: 15 }));
  await assert.rejects(createWorktreeManager({ rootDir: "/private/tmp/root", stateDir: "/private/tmp/state", retention: 0 }));
});

async function git(cwd, ...args) {
  const result = await command("git", ["-C", cwd, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t) {
  const temp = await mkdtemp(join(tmpdir(), "local-codex-worktree-manager-"));
  const repo = join(temp, "repo");
  await mkdir(join(repo, "packages", "app"), { recursive: true });
  await git(temp, "init", repo);
  await git(repo, "config", "user.name", "Test User");
  await git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "tracked.txt"), "committed\n");
  await writeFile(join(repo, "packages", "app", "app.txt"), "app committed\n");
  await writeFile(join(repo, ".gitignore"), "setup.local\nAGENTS.override.md\n");
  await writeFile(join(repo, ".worktreeinclude"), "setup.local\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await writeFile(join(repo, "setup.local"), "setup value\n");
  await writeFile(join(repo, "AGENTS.override.md"), "override value\n");
  t.after(() => rm(temp, { recursive: true, force: true }));
  return {
    temp,
    repo: await realpath(repo),
    rootDir: join(temp, "managed-worktrees"),
    stateDir: join(temp, "control"),
  };
}

test("creates a detached clean-HEAD worktree, maps subdirectories, copies declared setup, and disables hooks", async t => {
  const f = await repository(t);
  const marker = join(f.temp, "hook-ran");
  await mkdir(join(f.repo, ".githooks"));
  await writeFile(join(f.repo, ".githooks", "post-checkout"), `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`);
  await chmod(join(f.repo, ".githooks", "post-checkout"), 0o755);
  await git(f.repo, "config", "core.hooksPath", ".githooks");
  await writeFile(join(f.repo, "tracked.txt"), "dirty source\n");
  await writeFile(join(f.repo, "source-only.txt"), "untracked source\n");

  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 15 });
  const planned = await manager.plan({ id: firstId, sourceCwd: join(f.repo, "packages", "app") });
  assert.equal(planned.state, "planned");
  assert.equal(planned.sourceCwd, join(f.repo, "packages", "app"));
  assert.equal(planned.relativeCwd, "packages/app");
  const ready = await manager.prepare(firstId);
  assert.equal(ready.state, "ready");
  assert.equal(await readFile(join(ready.worktreeRoot, "tracked.txt"), "utf8"), "committed\n");
  await assert.rejects(readFile(join(ready.worktreeRoot, "source-only.txt"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(join(ready.worktreeRoot, "setup.local"), "utf8"), "setup value\n");
  assert.equal(await readFile(join(ready.worktreeRoot, "AGENTS.override.md"), "utf8"), "override value\n");
  assert.equal(await readFile(join(ready.executionCwd, "app.txt"), "utf8"), "app committed\n");
  assert.equal(await git(ready.worktreeRoot, "symbolic-ref", "-q", "HEAD").catch(() => ""), "");
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
  assert.equal((await stat(f.rootDir)).mode & 0o777, 0o700);
});

test("falls back to direct mode for disabled, non-Git, and unborn repositories", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 15 });
  const disabled = await manager.plan({ id: firstId, sourceCwd: f.repo, enabled: false });
  assert.equal(disabled.state, "direct");
  assert.equal(disabled.reason, "disabled");

  const plain = join(f.temp, "plain");
  await mkdir(plain);
  const nonGit = await manager.plan({ id: secondId, sourceCwd: plain });
  assert.equal(nonGit.state, "direct");
  assert.equal(nonGit.reason, "non_git");

  const unborn = join(f.temp, "unborn");
  await git(f.temp, "init", unborn);
  const unbornResult = await manager.plan({ id: "33333333-3333-3333-3333-333333333333", sourceCwd: unborn });
  assert.equal(unbornResult.state, "direct");
  assert.equal(unbornResult.reason, "unborn_head");
});

test("retention snapshots Git-visible work and declared setup, then restores after source deletion", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 1 });
  await manager.plan({ id: firstId, sourceCwd: f.repo });
  const first = await manager.prepare(firstId);
  await manager.bindThread(firstId, "thread-1");
  await writeFile(join(first.worktreeRoot, "tracked.txt"), "worktree change\n");
  await writeFile(join(first.worktreeRoot, "new.txt"), "new work\n");
  await writeFile(join(first.worktreeRoot, "run.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(first.worktreeRoot, "run.sh"), 0o755);
  await symlink("new.txt", join(first.worktreeRoot, "new-link"));
  await writeFile(join(first.worktreeRoot, "setup.local"), "changed setup\n");

  await manager.plan({ id: secondId, sourceCwd: f.repo });
  await manager.prepare(secondId);
  await manager.bindThread(secondId, "thread-2");
  const pruned = await manager.prune(new Set());
  assert.deepEqual(pruned.map(record => record.id), [firstId]);
  assert.deepEqual(pruned.attemptedIds, [firstId]);
  assert.equal(pruned.hasMoreEligible, false);
  const snapshot = manager.get(firstId);
  assert.equal(snapshot.state, "snapshotted");
  assert.equal((await stat(snapshot.snapshotBundle)).mode & 0o777, 0o600);
  await assert.rejects(stat(first.worktreeRoot), { code: "ENOENT" });

  await rm(f.repo, { recursive: true, force: true });
  const restored = await manager.prepare(firstId);
  assert.equal(restored.state, "ready");
  assert.equal(await readFile(join(restored.worktreeRoot, "tracked.txt"), "utf8"), "worktree change\n");
  assert.equal(await readFile(join(restored.worktreeRoot, "new.txt"), "utf8"), "new work\n");
  assert.equal((await stat(join(restored.worktreeRoot, "run.sh"))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(restored.worktreeRoot, "new-link")), "new.txt");
  assert.equal(await readFile(join(restored.worktreeRoot, "setup.local"), "utf8"), "changed setup\n");
  assert.equal(await git(restored.worktreeRoot, "rev-parse", "HEAD"), snapshot.snapshotCommit);
});

test("active worktrees are protected and snapshot failure never deletes the worktree", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 1 });
  await manager.plan({ id: firstId, sourceCwd: f.repo });
  const first = await manager.prepare(firstId);
  await manager.bindThread(firstId, "thread-1");
  await manager.plan({ id: secondId, sourceCwd: f.repo });
  const second = await manager.prepare(secondId);
  await manager.bindThread(secondId, "thread-2");
  const protectedPrune = await manager.prune(new Set([firstId]));
  assert.deepEqual(protectedPrune.map(record => record.id), [secondId]);
  assert.equal((await lstat(first.worktreeRoot)).isDirectory(), true);

  const thirdId = "33333333-3333-3333-3333-333333333333";
  await manager.plan({ id: thirdId, sourceCwd: f.repo });
  const third = await manager.prepare(thirdId);
  await manager.bindThread(thirdId, "thread-3");
  manager.gitBin = join(f.temp, "missing-git");
  const failed = await manager.prune(new Set([firstId]));
  assert.deepEqual(failed, []);
  assert.equal((await lstat(third.worktreeRoot)).isDirectory(), true);
});

function command(commandName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}


test("disabled planning bypasses a busy worktree serializer", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 15 });
  let release;
  const blocker = manager.serial(() => new Promise(resolve => { release = resolve; }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const result = await Promise.race([
    manager.plan({ id: firstId, sourceCwd: f.repo, enabled: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("direct planning waited for serializer")), 250)),
  ]);
  assert.equal(result.state, "direct");
  assert.equal(result.reason, "disabled");
  release();
  await blocker;
});

test("a >200 prune backlog yields to new worktree admission between bounded candidates", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 15 });
  const idFor = value => `00000000-0000-0000-0000-${value.toString(16).padStart(12, "0")}`;
  for (let i = 1; i <= 225; i++) {
    manager.records.set(idFor(i), {
      id: idFor(i), state: "ready", lastUsedAt: i, createdAt: i,
      worktreeRoot: join(f.rootDir, `fake-${i}`), executionCwd: join(f.rootDir, `fake-${i}`),
    });
  }
  let releaseFirst;
  let firstStarted;
  let secondStarted;
  const firstStartedPromise = new Promise(resolve => { firstStarted = resolve; });
  const secondStartedPromise = new Promise(resolve => { secondStarted = resolve; });
  let snapshots = 0;
  manager.snapshotAndRemove = async record => {
    snapshots += 1;
    if (snapshots === 1) {
      firstStarted();
      await new Promise(resolve => { releaseFirst = resolve; });
    }
    if (snapshots === 2) secondStarted();
    record.state = "snapshotted";
  };
  const prune = manager.prune(new Set(), { limit: 4 });
  await firstStartedPromise;
  const admitted = manager.plan({ id: "ffffffff-ffff-ffff-ffff-ffffffffffff", sourceCwd: f.repo });
  while (!releaseFirst) await new Promise(resolve => setImmediate(resolve));
  releaseFirst();
  const winner = await Promise.race([
    admitted.then(() => "admitted"),
    secondStartedPromise.then(() => "second-prune"),
  ]);
  assert.equal(winner, "admitted");
  assert.equal((await admitted).state, "planned");
  const pruned = await prune;
  assert.equal(pruned.length, 4);
  assert.equal(pruned.attemptedIds.length, 4);
  assert.equal(pruned.hasMoreEligible, true);
  assert.equal(snapshots, 4);
});

test("failed prune candidates are skipped for one drain while later batches continue", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 1 });
  const idFor = value => `00000000-0000-0000-0000-${value.toString(16).padStart(12, "0")}`;
  for (let i = 1; i <= 10; i++) {
    manager.records.set(idFor(i), {
      id: idFor(i), state: "ready", lastUsedAt: i, createdAt: i,
      worktreeRoot: join(f.rootDir, `fake-${i}`), executionCwd: join(f.rootDir, `fake-${i}`),
    });
  }
  const failedId = idFor(1);
  const snapshotAttempts = [];
  manager.snapshotAndRemove = async record => {
    snapshotAttempts.push(record.id);
    if (record.id === failedId) throw Object.assign(new Error("fixture snapshot failure"), { code: "fixture_failure" });
    record.state = "snapshotted";
  };

  const attemptedIds = new Set();
  let passes = 0;
  let result;
  do {
    result = await manager.prune(new Set(), { limit: 4, excludeIds: attemptedIds });
    for (const id of result.attemptedIds) attemptedIds.add(id);
    passes += 1;
  } while (result.hasMoreEligible);

  assert.equal(passes, 3);
  assert.equal(snapshotAttempts.filter(id => id === failedId).length, 1, "a permanent failure is not retried tightly");
  assert.deepEqual(new Set(snapshotAttempts), new Set(Array.from({ length: 10 }, (_, index) => idFor(index + 1))));
  assert.deepEqual([...manager.records.values()].filter(record => record.state === "ready").map(record => record.id), [failedId]);
});

test("stalled Git times out and releases the serializer", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 15 });
  await manager.plan({ id: firstId, sourceCwd: f.repo });
  manager.gitTimeoutMs = 100;
  const stalled = join(f.temp, "stalled-git.mjs");
  await writeFile(stalled, '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n');
  await chmod(stalled, 0o755);
  manager.gitBin = stalled;
  const before = Date.now();
  await assert.rejects(manager.prepare(firstId), error => error?.code === "worktree_git_timeout");
  assert.ok(Date.now() - before < 1500, "stalled Git must be bounded");
  const touched = await Promise.race([
    manager.touch(firstId),
    new Promise((_, reject) => setTimeout(() => reject(new Error("serializer remained blocked")), 250)),
  ]);
  assert.equal(touched.id, firstId);
});

test("aborted prepare settles state and Git before later serialized work", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 15 });
  await manager.plan({ id: firstId, sourceCwd: f.repo });
  const started = join(f.temp, "abort-started");
  const exited = join(f.temp, "abort-exited");
  const stalled = join(f.temp, "abortable-git.mjs");
  await writeFile(stalled, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "started");
process.on("SIGTERM", () => {
  setTimeout(() => {
    writeFileSync(${JSON.stringify(exited)}, "exited");
    process.exit(0);
  }, 80);
});
setInterval(() => {}, 1000);
`);
  await chmod(stalled, 0o755);
  manager.gitBin = stalled;
  const controller = new AbortController();
  let prepareSettled = false;
  const prepare = manager.prepare(firstId, { signal: controller.signal }).then(
    value => ({ value }),
    error => ({ error }),
  ).finally(() => { prepareSettled = true; });
  for (let i = 0; i < 100; i++) {
    try { await readFile(started); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(await readFile(started, "utf8"), "started");
  controller.abort();
  let followUpSettled = false;
  const followUp = manager.touch(firstId).finally(() => { followUpSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(prepareSettled, false, "prepare must wait for Git termination and state persistence");
  assert.equal(followUpSettled, false, "later serialized work must not race cancelled prepare cleanup");

  const outcome = await prepare;
  assert.equal(outcome.error?.code, "worktree_cancelled");
  assert.equal(await readFile(exited, "utf8"), "exited");
  const stable = manager.get(firstId);
  assert.equal(stable.state, "failed");
  assert.equal(stable.errorCode, "worktree_cancelled");
  const touched = await followUp;
  assert.equal(touched.state, "failed");
  await manager.waitForIdle();
  assert.equal(manager.get(firstId).state, "failed");
});
