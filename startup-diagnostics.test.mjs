import assert from "node:assert/strict";
import test from "node:test";
import {
  STARTUP_STDERR_LIMIT, appendStartupStderr, appServerTermination, classifyStartupStderr,
} from "./startup-diagnostics.mjs";

test("startup diagnostics classify exits, signals, spawn errors, and missing libraries safely", () => {
  assert.equal(appServerTermination({ signal: "SIGABRT" }).processSignal, "SIGABRT");
  assert.equal(appServerTermination({ code: 23 }).processExitCode, 23);
  assert.equal(appServerTermination({ spawnError: true }).processState, "spawn_error");
  const secretPath = "/Users/private/PRIVATE_RUNTIME_SECRET/libsimdjson.34.dylib";
  const missing = appServerTermination({ code: 134, stderr: `dyld: Library not loaded: ${secretPath}` });
  assert.equal(missing.startupDiagnostic, "missing_dynamic_library");
  const nested = appServerTermination({ code: 1, stderr: "LOCAL_CODEX_APP_SERVER_MISSING_DYNAMIC_LIBRARY=1\n" });
  assert.equal(nested.startupDiagnostic, "missing_dynamic_library");
  assert.match(nested.message, /missing dynamic library/);
  assert.equal(classifyStartupStderr("dyld: unrelated warning"), undefined);
  assert.doesNotMatch(missing.message, /Users|PRIVATE_RUNTIME_SECRET|simdjson/);
  assert.equal(classifyStartupStderr("ordinary startup output"), undefined);
  assert.equal(appendStartupStderr("x".repeat(STARTUP_STDERR_LIMIT), "yz").length, STARTUP_STDERR_LIMIT);
});
