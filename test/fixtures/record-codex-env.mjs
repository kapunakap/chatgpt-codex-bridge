#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const marker = args.indexOf("--test-record-file");
if (marker < 0 || !args[marker + 1]) {
  process.stderr.write("missing --test-record-file\n");
  process.exit(2);
}

const recordFile = args[marker + 1];
writeFileSync(recordFile, JSON.stringify({
  args,
  env: {
    pathPresent: typeof process.env.PATH === "string",
    homePresent: typeof process.env.HOME === "string",
    openaiApiKeyPresent: "OPENAI_API_KEY" in process.env,
    databaseUrlPresent: "DATABASE_URL" in process.env,
    localTokenFilePresent: "LOCAL_CODEX_TOKEN_FILE" in process.env,
    runtimeApiKeyPresent: "TUNNEL_CLIENT_RUNTIME_API_KEY" in process.env,
    passwordPresent: "TEST_PASSWORD" in process.env,
  },
}, null, 2));
