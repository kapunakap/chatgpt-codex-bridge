#!/usr/bin/env node

import { existsSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const marker = args.indexOf("--test-record-file");
if (marker < 0 || !args[marker + 1]) {
  process.stderr.write("missing --test-record-file\n");
  process.exit(2);
}

const recordFile = args[marker + 1];
const scratchDir = process.env.TMPDIR || null;
const privateScratch = typeof scratchDir === "string" && /(?:^|\/)\.?local-codex-tmp-[^/]+$/.test(scratchDir);
let scratchMode = null;
let scratchWritable = false;
if (privateScratch && existsSync(scratchDir)) {
  scratchMode = statSync(scratchDir).mode & 0o777;
  writeFileSync(join(scratchDir, "fixture-write"), "ok\n");
  scratchWritable = true;
}
const runGit = gitArgs => {
  const result = spawnSync("git", gitArgs, { encoding: "utf8", env: process.env });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
};
const gitAcceptance = args.includes("--test-git-acceptance") ? {
  revParse: runGit(["rev-parse", "--show-toplevel"]),
  status: runGit(["status", "--short"]),
} : null;
const zshHeredoc = args.includes("--test-zsh-heredoc") ? (() => {
  const result = spawnSync("/bin/zsh", ["-c", "cat <<'EOF'\nHEREDOC_OK\nEOF"], {
    encoding: "utf8",
    env: process.env,
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
})() : null;
writeFileSync(recordFile, JSON.stringify({
  args,
  gitAcceptance,
  zshHeredoc,
  env: {
    pathPresent: typeof process.env.PATH === "string",
    path: process.env.PATH || null,
    homePresent: typeof process.env.HOME === "string",
    openaiApiKeyPresent: "OPENAI_API_KEY" in process.env,
    databaseUrlPresent: "DATABASE_URL" in process.env,
    ghTokenPresent: "GH_TOKEN" in process.env,
    githubTokenPresent: "GITHUB_TOKEN" in process.env,
    sshAuthSockPresent: "SSH_AUTH_SOCK" in process.env,
    localTokenFilePresent: "LOCAL_CODEX_TOKEN_FILE" in process.env,
    approvalModePresent: "LOCAL_CODEX_APPROVAL_MODE" in process.env,
    runtimeApiKeyPresent: "TUNNEL_CLIENT_RUNTIME_API_KEY" in process.env,
    passwordPresent: "TEST_PASSWORD" in process.env,
    tmpdir: process.env.TMPDIR || null,
    tmp: process.env.TMP || null,
    temp: process.env.TEMP || null,
    tmpprefix: process.env.TMPPREFIX || null,
    scratchMode,
    scratchWritable,
    gitConfigNosystem: process.env.GIT_CONFIG_NOSYSTEM || null,
    gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL || null,
    gitConfigSystem: process.env.GIT_CONFIG_SYSTEM || null,
    gitTerminalPrompt: process.env.GIT_TERMINAL_PROMPT || null,
    developerDir: process.env.DEVELOPER_DIR || null,
    gitCeilingDirectories: process.env.GIT_CEILING_DIRECTORIES || null,
  },
}, null, 2));
