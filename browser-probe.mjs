import { spawn } from "node:child_process";
import process from "node:process";

const PROBE_TIMEOUT_MS = 10000;
const BUNDLED_BROWSER_IDS = new Set([
  "browser@openai-bundled",
  "chrome@openai-bundled",
  "chrome-dev@openai-bundled",
  "chrome-internal@openai-bundled",
  "computer-use@openai-bundled",
]);

export const browserStatusTool = {
  name: "codex-browser-status",
  title: "Local Codex Browser Backend Status",
  description: "Read-only diagnostic for the official Codex Browser Use / Computer Use backend in cwd. Starts no thread or turn and does not change Codex config. Reads managed Browser/Computer Use requirements and locally visible browser-related plugin metadata through a hardened read-only App Server probe. Use this before assuming shell Chromium is the only browser path, especially on macOS.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      cwd: { type: "string", minLength: 1, maxLength: 4096, description: "Absolute existing workspace used only to scope local plugin discovery. The probe receives read-only workspace permissions." },
    },
    required: ["cwd"],
  },
  outputSchema: browserStatusSchema(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export function probePermissionConfig(cwd) {
  const denied = ["/Users", "/System/Volumes/Data/Users", "/Volumes", "/private/tmp", "/tmp", "/private/var/tmp", "/var/tmp", "/private/var/folders", "/var/folders"];
  const inside = path => cwd === "/" || path === cwd || path.startsWith(`${cwd}/`);
  const reads = process.platform === "darwin"
    ? ['":root"="read"', ...denied.filter(path => {
      const canonical = path.replace(/^\/System\/Volumes\/Data(?=\/)/, "").replace(/^\/tmp$/, "/private/tmp").replace(/^\/var(?=\/)/, "/private/var");
      return !inside(path) && !inside(canonical);
    }).map(path => `${JSON.stringify(path)}="deny"`)].join(", ")
    : '":minimal"="read"';
  const workspace = ['"."="read"', '".git"="read"', '".codex"="read"', '".env"="deny"', '".env.*"="deny"',
    '"**/.env"="deny"', '"**/.env.*"="deny"', '"*.env"="deny"', '"**/*.env"="deny"',
    '".npmrc"="deny"', '"**/.npmrc"="deny"', '".pypirc"="deny"', '"**/.pypirc"="deny"'].join(", ");
  return `permissions.local-codex-tunnel={description="Local Codex Browser Probe", workspace_roots={${JSON.stringify(cwd)}=true}, filesystem={${reads}, ":workspace_roots"={${workspace}}}, network={enabled=false}}`;
}

export function probeBrowserBackend({ cwd, codexBin, adapterVersion, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(codexBin, ["app-server", "--listen", "stdio://", "-c", probePermissionConfig(cwd)], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, LOCAL_CODEX_PROBE_MODE: "browser-status" },
    });
    let settled = false;
    let exited = false;
    let stdoutBuffer = "";
    let requestSequence = 0;
    const pending = new Map();
    const timer = setTimeout(() => finish(probeError("browser_probe_timeout", "Browser backend probe timed out")), PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.on("error", () => finish(probeError("browser_probe_spawn_failed", "Unable to start the Local Codex browser backend probe")));
    child.on("exit", code => {
      exited = true;
      if (!settled) finish(probeError("browser_probe_exit", `Browser backend probe exited with code ${code}`));
    });
    child.stdin.on("error", () => finish(probeError("browser_probe_pipe", "Browser backend probe connection closed")));
    child.stdout.on("data", chunk => {
      stdoutBuffer += chunk.toString();
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { return finish(probeError("browser_probe_invalid_json", "Browser backend probe returned invalid JSON")); }
        if (message.id === undefined || !pending.has(String(message.id))) continue;
        const entry = pending.get(String(message.id));
        pending.delete(String(message.id));
        if (message.error) entry.reject(rpcProbeError(entry.method, message.error));
        else entry.resolve(message.result);
      }
    });
    if (signal?.aborted) finish(probeError("request_cancelled", "Browser backend probe was cancelled"));
    else {
      signal?.addEventListener("abort", () => finish(probeError("request_cancelled", "Browser backend probe was cancelled")), { once: true });
      void start();
    }

    async function start() {
      try {
        await request("initialize", {
          clientInfo: { name: "local_codex_browser_probe", title: "Local Codex Browser Probe", version: adapterVersion },
          capabilities: { experimentalApi: true },
        });
        send({ method: "notifications/initialized", params: {} });
        const requirements = await optionalRequest("configRequirements/read", undefined);
        const plugins = await optionalRequest("plugin/installed", {
          cwds: [cwd],
          installSuggestionPluginNames: ["browser", "chrome", "chrome-dev", "chrome-internal", "computer-use"],
        });
        finish(null, summarize(cwd, requirements, plugins));
      } catch (error) {
        finish(error?.callCode ? error : probeError("browser_probe_failed", "Local Codex browser backend probe failed"));
      }
    }

    function optionalRequest(method, params) {
      return request(method, params)
        .then(value => ({ support: "ok", value }))
        .catch(error => {
          if (error.rpcCode === -32601) return { support: "unsupported", value: null };
          return { support: "error", value: null };
        });
    }

    function request(method, params) {
      return new Promise((resolve, reject) => {
        if (settled) return reject(probeError("browser_probe_ended", "Browser backend probe already ended"));
        const id = ++requestSequence;
        pending.set(String(id), { resolve, reject, method });
        send({ method, id, ...(params === undefined ? {} : { params }) });
      });
    }

    function send(value) {
      if (!settled && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`);
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const entry of pending.values()) entry.reject(error || probeError("browser_probe_ended", "Browser backend probe ended"));
      pending.clear();
      const done = () => {
        if (error) rejectPromise(error);
        else resolvePromise(value);
      };
      terminate("SIGTERM");
      if (exited || !child.pid) return done();
      const killTimer = setTimeout(() => terminate("SIGKILL"), 1000);
      child.once("exit", () => { clearTimeout(killTimer); done(); });
    }

    function terminate(sig) {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch (error) {
        if (error?.code !== "ESRCH") {
          try { child.kill(sig); } catch {}
        }
      }
    }
  });
}

function summarize(cwd, requirementsProbe, pluginsProbe) {
  const requirements = requirementsProbe.value?.requirements ?? null;
  const featureRequirements = requirements?.featureRequirements && typeof requirements.featureRequirements === "object"
    ? requirements.featureRequirements : null;
  const featureValue = key => featureRequirements?.[key] ?? null;
  const managed = {
    allowBrowserAndComputerUse: booleanOrNull(requirements?.allowBrowserAndComputerUse),
    browserUse: booleanOrNull(featureValue("browser_use")),
    browserUseFullCdpAccess: booleanOrNull(featureValue("browser_use_full_cdp_access")),
    browserUseExternal: booleanOrNull(featureValue("browser_use_external")),
    inAppBrowser: booleanOrNull(featureValue("in_app_browser")),
    computerUse: booleanOrNull(featureValue("computer_use")),
    browserUsePolicyPresent: requirements?.browserUse != null,
    inAppBrowserPolicyPresent: requirements?.inAppBrowser != null,
    computerUsePolicyPresent: requirements?.computerUse != null,
  };
  const policyBlocked = managed.allowBrowserAndComputerUse === false || managed.browserUse === false;

  const candidates = [];
  for (const marketplace of pluginsProbe.value?.marketplaces || []) {
    for (const plugin of marketplace?.plugins || []) {
      const id = typeof plugin?.id === "string" ? plugin.id : "";
      const name = typeof plugin?.name === "string" ? plugin.name : "";
      if (!BUNDLED_BROWSER_IDS.has(id) && !/browser|chrome|computer[ -]?use/i.test(`${id} ${name}`)) continue;
      candidates.push({
        id,
        name,
        installed: plugin?.installed === true,
        enabled: plugin?.enabled === true,
        bundled: BUNDLED_BROWSER_IDS.has(id),
      });
    }
  }
  const bundledReady = candidates.some(plugin => plugin.bundled && plugin.installed && plugin.enabled);
  const bundledDisabled = candidates.some(plugin => plugin.bundled && (!plugin.installed || !plugin.enabled));
  const officialBrowserBackend = policyBlocked ? "policy_blocked"
    : bundledReady ? "available"
      : bundledDisabled ? "plugin_disabled"
        : "unknown";

  return {
    status: "ok",
    cwd,
    platform: process.platform,
    shellChromiumStatus: process.platform === "darwin" ? "blocked_by_codex_seatbelt" : "not_known_blocked",
    officialBrowserBackend,
    managedPolicy: managed,
    bundledPlugins: candidates.slice(0, 20),
    probeSupport: {
      configRequirements: requirementsProbe.support,
      pluginInstalled: pluginsProbe.support,
    },
    message: officialBrowserBackend === "available"
      ? "The official Codex browser executor plugin is visible and enabled. This probe does not start a browser or grant website/CDP access."
      : officialBrowserBackend === "policy_blocked"
        ? "Managed Codex policy blocks Browser Use on this host."
        : officialBrowserBackend === "plugin_disabled"
          ? "A bundled Codex browser plugin is visible but not both installed and enabled."
          : "The read-only probe could not prove an official Codex browser executor backend. Do not infer that Browser Use is available from feature defaults alone.",
  };
}

function booleanOrNull(value) { return typeof value === "boolean" ? value : null; }

function rpcProbeError(method, rpcError) {
  const error = probeError("browser_probe_rpc_error", `Codex App Server rejected ${method}`);
  error.rpcCode = rpcError?.code;
  return error;
}

function probeError(code, message) {
  return Object.assign(new Error(message), { callCode: code });
}

function browserStatusSchema() {
  const nullableBoolean = { type: ["boolean", "null"] };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["ok", "error"] },
      cwd: { type: "string" },
      platform: { type: "string" },
      shellChromiumStatus: { type: "string", enum: ["blocked_by_codex_seatbelt", "not_known_blocked"] },
      officialBrowserBackend: { type: "string", enum: ["available", "policy_blocked", "plugin_disabled", "unknown"] },
      managedPolicy: {
        type: "object", additionalProperties: false,
        properties: {
          allowBrowserAndComputerUse: nullableBoolean,
          browserUse: nullableBoolean,
          browserUseFullCdpAccess: nullableBoolean,
          browserUseExternal: nullableBoolean,
          inAppBrowser: nullableBoolean,
          computerUse: nullableBoolean,
          browserUsePolicyPresent: { type: "boolean" },
          inAppBrowserPolicyPresent: { type: "boolean" },
          computerUsePolicyPresent: { type: "boolean" },
        },
        required: ["allowBrowserAndComputerUse", "browserUse", "browserUseFullCdpAccess", "browserUseExternal", "inAppBrowser", "computerUse", "browserUsePolicyPresent", "inAppBrowserPolicyPresent", "computerUsePolicyPresent"],
      },
      bundledPlugins: {
        type: "array", maxItems: 20,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            id: { type: "string" }, name: { type: "string" }, installed: { type: "boolean" }, enabled: { type: "boolean" }, bundled: { type: "boolean" },
          },
          required: ["id", "name", "installed", "enabled", "bundled"],
        },
      },
      probeSupport: {
        type: "object", additionalProperties: false,
        properties: {
          configRequirements: { type: "string", enum: ["ok", "unsupported", "error"] },
          pluginInstalled: { type: "string", enum: ["ok", "unsupported", "error"] },
        },
        required: ["configRequirements", "pluginInstalled"],
      },
      message: { type: "string" },
      errorCode: { type: "string" },
    },
    required: ["status"],
  };
}
