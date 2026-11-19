export const STARTUP_STDERR_LIMIT = 4096;

const SAFE_SIGNAL = /^SIG[A-Z0-9]{1,12}$/;

export function appendStartupStderr(current, chunk) {
  const previous = Buffer.from(current || "");
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const combined = Buffer.concat([previous, next]);
  return combined.subarray(Math.max(0, combined.length - STARTUP_STDERR_LIMIT)).toString("utf8");
}

export function classifyStartupStderr(stderr) {
  if (/\bLibrary not loaded:/i.test(stderr || "") ||
      /LOCAL_CODEX_APP_SERVER_MISSING_DYNAMIC_LIBRARY=1\b/.test(stderr || "")) {
    return "missing_dynamic_library";
  }
  return undefined;
}

export function appServerTermination({ code, signal, spawnError = false, stderr = "" }) {
  const startupDiagnostic = classifyStartupStderr(stderr);
  const nestedSignal = stderr.match(/LOCAL_CODEX_APP_SERVER_EXIT_SIGNAL=(SIG[A-Z0-9]{1,12})\b/)?.[1];
  const nestedSpawnError = /LOCAL_CODEX_APP_SERVER_SPAWN_ERROR=1\b/.test(stderr);
  const detail = startupDiagnostic === "missing_dynamic_library"
    ? " after a missing dynamic library during startup"
    : "";

  if (spawnError || nestedSpawnError) {
    return {
      callCode: "spawn_failed",
      processState: "spawn_error",
      startupDiagnostic,
      message: "Unable to spawn Codex app-server.",
    };
  }
  if ((typeof signal === "string" && signal) || nestedSignal) {
    const reportedSignal = nestedSignal || signal;
    const safeSignal = SAFE_SIGNAL.test(reportedSignal) ? reportedSignal : "signal";
    return {
      callCode: "server_exit",
      processState: "signal",
      processSignal: safeSignal,
      startupDiagnostic,
      message: `Codex app-server terminated by ${safeSignal}${detail}.`,
    };
  }
  if (Number.isInteger(code)) {
    return {
      callCode: "server_exit",
      processState: "exit_code",
      processExitCode: code,
      startupDiagnostic,
      message: `Codex app-server exited with code ${code}${detail}.`,
    };
  }
  return {
    callCode: "server_exit",
    processState: "unknown_exit",
    startupDiagnostic,
    message: `Codex app-server exited without an exit code or signal${detail}.`,
  };
}
