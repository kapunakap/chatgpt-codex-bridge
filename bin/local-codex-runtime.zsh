# Shared runtime selection and bounded startup polling for Local Codex.

local_codex_node_is_healthy() {
  local candidate="$1"
  [[ -x "${candidate}" ]] || return 1

  local major
  major=$("${candidate}" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null) || return 1
  [[ "${major}" == <-> ]] && (( major >= 22 ))
}

local_codex_resolve_node() {
  local candidate
  local candidates=()

  if [[ -n "${LOCAL_CODEX_NODE_BIN:-}" ]]; then
    candidates+=("${LOCAL_CODEX_NODE_BIN}")
  fi
  if (( $+commands[node] )); then
    candidates+=("${commands[node]}")
  fi
  local homebrew_prefix="${HOMEBREW_PREFIX:-/opt/homebrew}"
  candidates+=(
    "${homebrew_prefix}/opt/node@24/bin/node"
    "${homebrew_prefix}/opt/node@22/bin/node"
    /usr/local/opt/node@24/bin/node
    /usr/local/opt/node@22/bin/node
  )

  for candidate in "${candidates[@]}"; do
    if local_codex_node_is_healthy "${candidate}"; then
      print -r -- "${candidate}"
      return 0
    fi
  done

  print -u2 "Local Codex requires a working Node.js 22 or newer; no healthy runtime was found."
  return 1
}

local_codex_timeout_attempts() {
  local timeout_ms="$1"
  [[ "${timeout_ms}" == <-> ]] || return 1
  (( timeout_ms >= 1000 && timeout_ms <= 120000 )) || return 1
  print -r -- "$(( (timeout_ms + 99) / 100 ))"
}

local_codex_wait_for_ready() {
  local url="$1"
  local attempts="$2"
  local label="$3"
  local pid="$4"
  local curl_bin="${5:-/usr/bin/curl}"
  local sleep_bin="${6:-sleep}"
  local attempt

  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    if "${curl_bin}" -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      print -u2 "${label} stopped during startup"
      return 1
    fi
    "${sleep_bin}" 0.1
  done

  if ! "${curl_bin}" -fsS "${url}" >/dev/null; then
    print -u2 "${label} did not become ready"
    return 1
  fi
  return 0
}
