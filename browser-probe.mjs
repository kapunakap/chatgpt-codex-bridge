import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";

const PROBE_TIMEOUT_MS = 20000;
export const BROWSER_RUNTIME_MARKER = "BROWSER_RUNTIME_SETUP_OK";
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
  description: "Read-only diagnostic for the official Codex Browser Use / Computer Use backend in cwd. Starts one ephemeral App Server thread but no model turn, browser tab, or navigation, and does not change Codex config. Reads managed Browser/Computer Use requirements, locally visible browser plugin metadata, the node_repl transport, and Browser runtime setup through a hardened read-only probe. Use this before assuming shell Chromium is the only browser path, especially on macOS.",
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

export function browserRuntimeSetupCode(browserClientPath) {
  return `await (async () => {\n` +
    `  const runtime = await import(${JSON.stringify(browserClientPath)});\n` +
    `  const agent = await runtime.setupBrowserRuntime();\n` +
    `  if (!agent || !agent.browsers) throw new Error("Browser runtime did not expose browser selection");\n` +
    `  nodeRepl.write(${JSON.stringify(BROWSER_RUNTIME_MARKER)});\n` +
    `})();`;
}

export function resolveOfficialBrowserBackend(requirementsValue, pluginsValue, mcpServersValue) {
  const requirements = requirementsValue?.requirements ?? null;
  const featureRequirements = requirements?.featureRequirements && typeof requirements.featureRequirements === "object"
    ? requirements.featureRequirements : null;
  const policyBlocked = requirements?.allowBrowserAndComputerUse === false || featureRequirements?.browser_use === false;
  if (policyBlocked) {
    return { status: "policy_blocked", errorCode: "browser_policy_blocked", message: "Managed Codex policy blocks official Browser Use on this host." };
  }

  let browserPlugin = null;
  for (const marketplace of pluginsValue?.marketplaces || []) {
    for (const plugin of marketplace?.plugins || []) {
      if (plugin?.id === "browser@openai-bundled") browserPlugin = plugin;
    }
  }
  if (browserPlugin && (!browserPlugin.installed || !browserPlugin.enabled)) {
    return { status: "plugin_disabled", errorCode: "browser_plugin_unavailable", message: "The bundled Browser plugin is not both installed and enabled." };
  }
  if (!browserPlugin) {
    return { status: "unknown", errorCode: "browser_plugin_unavailable", message: "The bundled Browser plugin is not visible to Codex App Server." };
  }
  const pluginRoot = browserPlugin?.source?.type === "local" && typeof browserPlugin.source.path === "string" && isAbsolute(browserPlugin.source.path)
    ? resolve(browserPlugin.source.path) : null;
  if (!pluginRoot) {
    return { status: "unknown", errorCode: "browser_plugin_unavailable", message: "The bundled Browser plugin does not expose a local runtime path." };
  }

  const nodeRepl = (mcpServersValue?.data || []).find(server => server?.name === "node_repl");
  const tools = nodeRepl?.tools && typeof nodeRepl.tools === "object" ? nodeRepl.tools : {};
  if (!tools.js) {
    return { status: "unknown", errorCode: "browser_transport_unavailable", message: "The trusted node_repl Browser transport is unavailable." };
  }
  return {
    status: "available",
    errorCode: null,
    message: "The official Codex Browser runtime and trusted node_repl transport are available.",
    pluginId: browserPlugin.id,
    pluginVersion: browserPlugin.localVersion ?? browserPlugin.version ?? null,
    browserClientPath: resolve(pluginRoot, "scripts/browser-client.mjs"),
    browserSkillPath: resolve(pluginRoot, "skills/control-in-app-browser/SKILL.md"),
  };
}

export function browserRuntimeResultOk(value) {
  if (!value || value.isError === true || !Array.isArray(value.content)) return false;
  return value.content.some(item => item?.type === "text" && item.text === BROWSER_RUNTIME_MARKER);
}

export function officialBrowserDynamicTools() {
  const tool = (name, description, properties, required) => ({
    type: "function", name, description, deferLoading: false,
    inputSchema: { type: "object", additionalProperties: false, properties, required },
  });
  const tabId = { type: "string", minLength: 1, maxLength: 200 };
  const selector = { type: "string", minLength: 1, maxLength: 4096 };
  return [{
    type: "namespace",
    name: "official_browser",
    description: "Validated operations executed by the official Codex Browser backend. Use these tools instead of node_repl or shell browser processes.",
    tools: [
      tool("open", "Open a URL in a new official Browser tab.", { url: { type: "string", minLength: 1, maxLength: 8192 } }, ["url"]),
      tool("snapshot", "Read the visible DOM snapshot from an opened tab.", { tabId }, ["tabId"]),
      tool("get_text", "Read rendered text from a selector in an opened tab.", { tabId, selector }, ["tabId", "selector"]),
      tool("click", "Click a selector in an opened tab.", { tabId, selector }, ["tabId", "selector"]),
      tool("fill", "Replace an input value in an opened tab.", { tabId, selector, value: { type: "string", maxLength: 100000 } }, ["tabId", "selector", "value"]),
      tool("press", "Press a key while a selector is focused.", { tabId, selector, value: { type: "string", minLength: 1, maxLength: 200 } }, ["tabId", "selector", "value"]),
      tool("screenshot", "Capture an opened tab.", { tabId, fullPage: { type: "boolean", default: false } }, ["tabId"]),
      tool("close", "Close an opened tab.", { tabId }, ["tabId"]),
    ],
  }];
}

export async function createOfficialBrowserBroker({ cwd, codexBin, adapterVersion, signal }) {
  const child = spawn(codexBin, ["app-server", "--listen", "stdio://", "-c", probePermissionConfig(cwd)], {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, LOCAL_CODEX_PROBE_MODE: "browser-status" },
  });
  let buffer = "";
  let sequence = 0;
  let closed = false;
  let brokerThreadId = null;
  const pending = new Map();

  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { failAll(brokerError("browser_runtime_unavailable", "Official Browser broker returned invalid JSON")); continue; }
      if (message.id === undefined || !pending.has(String(message.id))) continue;
      const entry = pending.get(String(message.id));
      pending.delete(String(message.id));
      clearTimeout(entry.timer);
      if (message.error) entry.reject(brokerError("browser_runtime_unavailable", `Official Browser broker rejected ${entry.method}`));
      else entry.resolve(message.result);
    }
  });
  child.on("error", () => failAll(brokerError("browser_runtime_unavailable", "Unable to start the official Browser broker")));
  child.on("exit", () => {
    closed = true;
    failAll(brokerError("browser_runtime_unavailable", "Official Browser broker exited unexpectedly"));
  });
  child.stdin.on("error", () => failAll(brokerError("browser_runtime_unavailable", "Official Browser broker connection closed")));
  signal?.addEventListener("abort", () => { void close(); }, { once: true });

  try {
    await request("initialize", {
      clientInfo: { name: "local_codex_browser_broker", title: "Local Codex Browser Broker", version: adapterVersion },
      capabilities: { experimentalApi: true },
    });
    send({ method: "notifications/initialized", params: {} });
    const [requirements, plugins, mcpServers] = await Promise.all([
      request("configRequirements/read", undefined),
      request("plugin/installed", {
        cwds: [cwd], installSuggestionPluginNames: ["browser", "chrome", "chrome-dev", "chrome-internal", "computer-use"],
      }),
      request("mcpServerStatus/list", { detail: "full", limit: 100 }),
    ]);
    const runtime = resolveOfficialBrowserBackend(requirements, plugins, mcpServers);
    if (runtime.status !== "available") throw brokerError(runtime.errorCode, runtime.message);
    const thread = await request("thread/start", {
      cwd, ephemeral: true, approvalPolicy: "never", permissions: "local-codex-tunnel",
      developerInstructions: "Official Browser broker only. Start no model turn and make no workspace changes.",
    });
    brokerThreadId = thread?.thread?.id;
    if (typeof brokerThreadId !== "string" || !brokerThreadId) {
      throw brokerError("browser_runtime_unavailable", "Official Browser broker did not create an ephemeral thread");
    }
    const setupCode = `const { setupBrowserRuntime } = await import(${JSON.stringify(runtime.browserClientPath)});\n` +
      `const localCodexBrowserAgent = await setupBrowserRuntime();\n` +
      `const localCodexBrowserTabs = new Map();\n` +
      `nodeRepl.write(${JSON.stringify(BROWSER_RUNTIME_MARKER)});`;
    const setup = await callNodeRepl(setupCode, "Start Browser broker", null, 15000);
    if (!browserRuntimeResultOk(setup)) throw brokerError("browser_runtime_unavailable", "Official Browser broker setup failed");

    return {
      runtime,
      async execute(tool, args, turnMetadata) {
        if (closed) throw brokerError("browser_runtime_unavailable", "Official Browser broker is closed");
        const code = browserBrokerCode(tool, args);
        return callNodeRepl(code, `Official Browser ${tool}`, turnMetadata, 20000);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error?.callCode ? error : brokerError("browser_runtime_unavailable", "Official Browser broker initialization failed");
  }

  function request(method, params, timeoutMs = 20000) {
    return new Promise((resolvePromise, rejectPromise) => {
      if (closed) return rejectPromise(brokerError("browser_runtime_unavailable", "Official Browser broker is closed"));
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(String(id));
        rejectPromise(brokerError("browser_runtime_unavailable", `Official Browser broker timed out during ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(String(id), { resolve: resolvePromise, reject: rejectPromise, method, timer });
      send({ method, id, ...(params === undefined ? {} : { params }) });
    });
  }

  function send(value) {
    if (!closed && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  function callNodeRepl(code, title, turnMetadata, timeoutMs) {
    const params = {
      server: "node_repl", threadId: brokerThreadId, tool: "js",
      arguments: { code, timeout_ms: timeoutMs, title },
    };
    if (turnMetadata) params._meta = { "x-codex-turn-metadata": JSON.stringify(turnMetadata) };
    return request("mcpServer/tool/call", params, timeoutMs + 5000);
  }

  async function close() {
    if (closed) return;
    closed = true;
    failAll(brokerError("browser_runtime_unavailable", "Official Browser broker closed"));
    terminate("SIGTERM");
  }

  function terminate(sig) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(sig);
      else process.kill(-child.pid, sig);
    } catch {
      try { child.kill(sig); } catch {}
    }
  }

  function failAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }
}

function browserBrokerCode(tool, args) {
  const tab = value => {
    if (typeof value !== "string" || !value || value.length > 200) throw brokerError("browser_tool_invalid", "tabId is invalid");
    return JSON.stringify(value);
  };
  const selector = value => {
    if (typeof value !== "string" || !value || value.length > 4096) throw brokerError("browser_tool_invalid", "selector is invalid");
    return JSON.stringify(value);
  };
  const text = (value, max, name) => {
    if (typeof value !== "string" || value.length > max) throw brokerError("browser_tool_invalid", `${name} is invalid`);
    return JSON.stringify(value);
  };
  const wrap = body => `await (async () => {\n${body}\n})();`;
  const getTab = id => `const tab = localCodexBrowserTabs.get(${tab(id)});\nif (!tab) throw new Error("Unknown Browser tab");`;
  switch (tool) {
    case "open": {
      const url = text(args?.url, 8192, "url");
      return wrap(`const browser = await localCodexBrowserAgent.browsers.getForUrl(${url});\n` +
        `const tab = await browser.tabs.new();\nawait tab.goto(${url});\nlocalCodexBrowserTabs.set(String(tab.id), tab);\n` +
        `nodeRepl.write(JSON.stringify({ tabId: String(tab.id), title: await tab.title(), url: await tab.url() }));`);
    }
    case "snapshot":
      return wrap(`${getTab(args?.tabId)}\nnodeRepl.write(await tab.playwright.domSnapshot());`);
    case "get_text":
      return wrap(`${getTab(args?.tabId)}\nnodeRepl.write(await tab.playwright.locator(${selector(args?.selector)}).innerText());`);
    case "click":
      return wrap(`${getTab(args?.tabId)}\nawait tab.playwright.locator(${selector(args?.selector)}).click({});\nnodeRepl.write("OK");`);
    case "fill":
      return wrap(`${getTab(args?.tabId)}\nawait tab.playwright.locator(${selector(args?.selector)}).fill(${text(args?.value, 100000, "value")}, {});\nnodeRepl.write("OK");`);
    case "press":
      return wrap(`${getTab(args?.tabId)}\nawait tab.playwright.locator(${selector(args?.selector)}).press(${text(args?.value, 200, "value")}, {});\nnodeRepl.write("OK");`);
    case "screenshot":
      if (args?.fullPage !== undefined && typeof args.fullPage !== "boolean") throw brokerError("browser_tool_invalid", "fullPage is invalid");
      return wrap(`${getTab(args?.tabId)}\nawait nodeRepl.emitImage(await tab.screenshot({ fullPage: ${args?.fullPage === true} }));`);
    case "close":
      return wrap(`${getTab(args?.tabId)}\nawait tab.close();\nlocalCodexBrowserTabs.delete(${tab(args?.tabId)});\nnodeRepl.write("OK");`);
    default:
      throw brokerError("browser_tool_invalid", "Unknown official Browser tool");
  }
}

function brokerError(code, message) {
  return Object.assign(new Error(message), { callCode: code });
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
        const mcpServers = await optionalRequest("mcpServerStatus/list", { detail: "full", limit: 100 });
        let runtimeSetup = { support: "unsupported", value: null };
        const resolved = requirements.support === "ok" && plugins.support === "ok" && mcpServers.support === "ok"
          ? resolveOfficialBrowserBackend(requirements.value, plugins.value, mcpServers.value) : null;
        if (resolved?.status === "available") {
          const thread = await optionalRequest("thread/start", {
            cwd,
            ephemeral: true,
            approvalPolicy: "never",
            permissions: "local-codex-tunnel",
            developerInstructions: "Read-only Browser runtime diagnostic. Do not start a model turn, open a tab, or navigate.",
          });
          const threadId = thread.value?.thread?.id;
          if (thread.support === "ok" && typeof threadId === "string" && threadId) {
            runtimeSetup = await optionalRequest("mcpServer/tool/call", {
              server: "node_repl",
              threadId,
              tool: "js",
              arguments: {
                code: browserRuntimeSetupCode(resolved.browserClientPath),
                timeout_ms: 15000,
                title: "Check Browser runtime",
              },
            });
            if (runtimeSetup.support === "ok" && !browserRuntimeResultOk(runtimeSetup.value)) {
              runtimeSetup = { support: "error", value: runtimeSetup.value };
            }
            const reset = await optionalRequest("mcpServer/tool/call", {
              server: "node_repl", threadId, tool: "js_reset", arguments: {},
            });
            if (reset.support !== "ok" || reset.value?.isError === true) {
              runtimeSetup = { support: "error", value: runtimeSetup.value };
            }
          } else {
            runtimeSetup = { support: thread.support === "unsupported" ? "unsupported" : "error", value: null };
          }
        }
        finish(null, summarize(cwd, requirements, plugins, mcpServers, runtimeSetup));
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

function summarize(cwd, requirementsProbe, pluginsProbe, mcpServersProbe, runtimeSetupProbe) {
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
  const resolved = requirementsProbe.support === "ok" && pluginsProbe.support === "ok" && mcpServersProbe.support === "ok"
    ? resolveOfficialBrowserBackend(requirementsProbe.value, pluginsProbe.value, mcpServersProbe.value) : null;
  const officialBrowserBackend = policyBlocked ? "policy_blocked"
    : resolved?.status === "plugin_disabled" ? "plugin_disabled"
      : resolved?.status === "available" && runtimeSetupProbe.support === "ok" ? "available"
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
      mcpServerStatus: mcpServersProbe.support,
      browserRuntimeSetup: runtimeSetupProbe.support,
    },
    message: officialBrowserBackend === "available"
      ? "The official Codex Browser runtime is available through the trusted node_repl transport. This probe did not open a browser tab or grant website/CDP access."
      : officialBrowserBackend === "policy_blocked"
        ? "Managed Codex policy blocks Browser Use on this host."
        : officialBrowserBackend === "plugin_disabled"
          ? "A bundled Codex browser plugin is visible but not both installed and enabled."
          : resolved?.message || "The read-only probe could not prove an official Codex browser executor backend. Do not infer that Browser Use is available from feature defaults alone.",
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
          mcpServerStatus: { type: "string", enum: ["ok", "unsupported", "error"] },
          browserRuntimeSetup: { type: "string", enum: ["ok", "unsupported", "error"] },
        },
        required: ["configRequirements", "pluginInstalled", "mcpServerStatus", "browserRuntimeSetup"],
      },
      message: { type: "string" },
      errorCode: { type: "string" },
    },
    required: ["status"],
  };
}
