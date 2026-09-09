#!/bin/zsh
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/install.sh \
    [--root /absolute/path/to/legacy/repository] \
    --tunnel-id tunnel_... \
    --runtime-api-key-file /absolute/path/to/runtime-api-key \
    [--dry-run]
USAGE
}

typeset target_root=""
typeset tunnel_id=""
typeset runtime_api_key_file=""
typeset dry_run="false"

while (( $# > 0 )); do
  case "$1" in
    --root)
      target_root="${2:-}"
      shift 2
      ;;
    --tunnel-id)
      tunnel_id="${2:-}"
      shift 2
      ;;
    --runtime-api-key-file)
      runtime_api_key_file="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      print -u2 "Unknown argument: $1"
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${tunnel_id}" || -z "${runtime_api_key_file}" ]]; then
  usage >&2
  exit 2
fi
if [[ "${OSTYPE}" != darwin* ]]; then
  print -u2 "This installer currently supports macOS only."
  exit 1
fi
if [[ -n "${target_root}" && ! -d "${target_root}" ]]; then
  print -u2 "Repository root does not exist: ${target_root}"
  exit 1
fi
if [[ ! -r "${runtime_api_key_file}" ]]; then
  print -u2 "Runtime API key file is not readable: ${runtime_api_key_file}"
  exit 1
fi
if [[ ! "${tunnel_id}" =~ '^tunnel_[A-Za-z0-9]+$' ]]; then
  print -u2 "Tunnel ID must look like tunnel_..."
  exit 1
fi

readonly SOURCE_ROOT="${0:A:h:h}"
readonly SOURCE_COMMIT="$(git -C "${SOURCE_ROOT}" rev-parse HEAD 2>/dev/null || print unknown)"
readonly TARGET_ROOT="${target_root:+${target_root:A}}"
readonly RUNTIME_API_KEY_FILE="${runtime_api_key_file:A}"
readonly USER_HOME="${HOME}"
readonly PROFILE_NAME="local-codex"
readonly PORT="8765"
readonly ADAPTER_PORT="8766"
readonly BIN_DIR="${USER_HOME}/.local/bin"
readonly LIBEXEC_DIR="${USER_HOME}/.local/libexec/local-codex-tunnel"
readonly STATE_DIR="${USER_HOME}/Library/Application Support/local-codex-tunnel"
readonly TUNNEL_STATE_DIR="${USER_HOME}/Library/Application Support/tunnel-client"
readonly PROFILE_DIR="${USER_HOME}/.config/tunnel-client"
readonly ADAPTER_PATH="${LIBEXEC_DIR}/adapter.mjs"
readonly OBSERVABILITY_PATH="${LIBEXEC_DIR}/observability.mjs"
readonly WORKTREE_MANAGER_PATH="${LIBEXEC_DIR}/worktree-manager.mjs"
readonly BROWSER_PROBE_PATH="${LIBEXEC_DIR}/browser-probe.mjs"
readonly BROWSER_PROXY_PATH="${LIBEXEC_DIR}/browser-proxy.mjs"
readonly CODEX_WRAPPER_PATH="${LIBEXEC_DIR}/codex-secure.mjs"
readonly INSTRUMENTED_CODEX_PATH="${LIBEXEC_DIR}/bin/local-codex-instrumented.mjs"
readonly TRACE_PROXY_PATH="${LIBEXEC_DIR}/bin/local-codex-trace-proxy.mjs"
readonly GUARD_PROXY_PATH="${LIBEXEC_DIR}/local-codex-guard-proxy.mjs"
readonly WATCH_NODE_PATH="${LIBEXEC_DIR}/local-codex-watch.mjs"
readonly WATCH_RENDER_PATH="${LIBEXEC_DIR}/local-codex-watch-render.mjs"
readonly DIAGNOSTICS_PATH="${LIBEXEC_DIR}/scripts/local-codex-diagnostics.mjs"
readonly LAUNCHER_PATH="${BIN_DIR}/local-codex-tunnel"
readonly WATCH_PATH="${BIN_DIR}/local-codex-watch"
readonly DOCTOR_PATH="${BIN_DIR}/local-codex-doctor"
readonly CANARY_PATH="${BIN_DIR}/local-codex-canary"
readonly RECEIPT_PATH="${BIN_DIR}/local-codex-receipt"
readonly TOKEN_FILE="${STATE_DIR}/adapter-token"
readonly THREADS_FILE="${STATE_DIR}/threads.json"
readonly CONFIG_FILE="${STATE_DIR}/config.env"
readonly PROFILE_FILE="${PROFILE_DIR}/${PROFILE_NAME}.yaml"
readonly HEALTH_URL_FILE="${TUNNEL_STATE_DIR}/health/${PROFILE_NAME}.url"
readonly LOG_FILE="${TUNNEL_STATE_DIR}/logs/${PROFILE_NAME}.log"
readonly TRACE_LOG_FILE="${STATE_DIR}/trace-events.jsonl"
readonly TRACE_STATE_DIR="${STATE_DIR}/traces"
readonly WORKTREE_ROOT="${USER_HOME}/Library/Application Support/local-codex-worktrees"

if [[ "${dry_run}" == "true" ]]; then
  print "DRY_RUN_OK"
  print "scope=per_job"
  print "approval_mode=off"
  print "legacy_root=${TARGET_ROOT}"
  print "launcher=${LAUNCHER_PATH}"
  print "adapter_port=${ADAPTER_PORT}"
  print "public_port=${PORT}"
  print "trace_proxy=${TRACE_PROXY_PATH}"
  print "source_commit=${SOURCE_COMMIT}"
  print "trace_log=${TRACE_LOG_FILE}"
  print "observability=${OBSERVABILITY_PATH}"
  print "instrumented_codex=${INSTRUMENTED_CODEX_PATH}"
  print "doctor=${DOCTOR_PATH}"
  print "canary=${CANARY_PATH}"
  print "receipt=${RECEIPT_PATH}"
  print "worktree_manager=${WORKTREE_MANAGER_PATH}"
  print "worktree_root=${WORKTREE_ROOT}"
  print "watch=${WATCH_PATH}"
  print "watch_renderer=${WATCH_RENDER_PATH}"
  print "codex_wrapper=${CODEX_WRAPPER_PATH}"
  print "guard_proxy=${GUARD_PROXY_PATH}"
  print "browser_probe=${BROWSER_PROBE_PATH}"
  print "browser_proxy=${BROWSER_PROXY_PATH}"
  print "profile=${PROFILE_FILE}"
  exit 0
fi

for required_command in node codex tunnel-client curl openssl git; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    print -u2 "Required command is missing: ${required_command}"
    exit 1
  fi
done

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if (( node_major < 22 )); then
  print -u2 "Node.js 22 or newer is required."
  exit 1
fi

mkdir -p "${BIN_DIR}" "${LIBEXEC_DIR}" "${LIBEXEC_DIR}/bin" "${LIBEXEC_DIR}/scripts" "${PROFILE_DIR}"
mkdir -p "${TUNNEL_STATE_DIR}/health" "${TUNNEL_STATE_DIR}/logs"
install -d -m 700 "${STATE_DIR}"
install -d -m 700 "${TRACE_STATE_DIR}"
install -d -m 700 "${WORKTREE_ROOT}"
install -m 755 "${SOURCE_ROOT}/adapter.mjs" "${ADAPTER_PATH}"
install -m 644 "${SOURCE_ROOT}/observability.mjs" "${OBSERVABILITY_PATH}"
install -m 644 "${SOURCE_ROOT}/worktree-manager.mjs" "${WORKTREE_MANAGER_PATH}"
install -m 755 "${SOURCE_ROOT}/browser-probe.mjs" "${BROWSER_PROBE_PATH}"
install -m 755 "${SOURCE_ROOT}/browser-proxy.mjs" "${BROWSER_PROXY_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-secure.mjs" "${CODEX_WRAPPER_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-instrumented.mjs" "${INSTRUMENTED_CODEX_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-trace-proxy.mjs" "${TRACE_PROXY_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-guard-proxy.mjs" "${GUARD_PROXY_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-watch.mjs" "${WATCH_NODE_PATH}"
install -m 644 "${SOURCE_ROOT}/bin/local-codex-watch-render.mjs" "${WATCH_RENDER_PATH}"
install -m 755 "${SOURCE_ROOT}/scripts/local-codex-diagnostics.mjs" "${DIAGNOSTICS_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-tunnel" "${LAUNCHER_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-watch" "${WATCH_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-doctor" "${DOCTOR_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-canary" "${CANARY_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-receipt" "${RECEIPT_PATH}"

if [[ ! -s "${TOKEN_FILE}" ]]; then
  token_tmp=$(mktemp "${STATE_DIR}/adapter-token.XXXXXX")
  openssl rand -hex -out "${token_tmp}" 32
  sed -i '' 's/^/Bearer /' "${token_tmp}"
  chmod 600 "${token_tmp}"
  mv "${token_tmp}" "${TOKEN_FILE}"
fi
chmod 600 "${TOKEN_FILE}"

config_tmp=$(mktemp "${STATE_DIR}/config.env.XXXXXX")
{
  if [[ -n "${TARGET_ROOT}" ]]; then
    printf 'LOCAL_CODEX_ROOT=%q\n' "${TARGET_ROOT}"
  fi
  printf 'LOCAL_CODEX_TOKEN_FILE=%q\n' "${TOKEN_FILE}"
  printf 'LOCAL_CODEX_STATE_FILE=%q\n' "${THREADS_FILE}"
  printf 'LOCAL_CODEX_LOG_FILE=%q\n' "${LOG_FILE}"
  printf 'LOCAL_CODEX_TRACE_LOG_FILE=%q\n' "${TRACE_LOG_FILE}"
  printf 'LOCAL_CODEX_TRACE_STATE_DIR=%q\n' "${TRACE_STATE_DIR}"
  printf 'LOCAL_CODEX_TRACE_LOG_MAX_BYTES=%q\n' "5242880"
  printf 'LOCAL_CODEX_TRACE_LOG_ROTATIONS=%q\n' "3"
  printf 'LOCAL_CODEX_BRIDGE_SOURCE_COMMIT=%q\n' "${SOURCE_COMMIT}"
  printf 'LOCAL_CODEX_JOBS_DIR=%q\n' "${STATE_DIR}/jobs"
  printf 'LOCAL_CODEX_WORKTREE_ROOT=%q\n' "${WORKTREE_ROOT}"
  printf 'LOCAL_CODEX_WORKTREE_RETENTION=%q\n' "15"
  printf 'LOCAL_CODEX_APPROVAL_MODE=%q\n' "off"
  printf 'LOCAL_CODEX_CALL_TIMEOUT_MS=%q\n' "1800000"
  printf 'LOCAL_CODEX_POLL_LEASE_MS=%q\n' "90000"
  printf 'LOCAL_CODEX_MAX_CONCURRENCY=%q\n' "10"
  printf 'LOCAL_CODEX_MAX_QUEUE=%q\n' "100"
  printf 'LOCAL_CODEX_HOST=%q\n' "127.0.0.1"
  printf 'LOCAL_CODEX_PORT=%q\n' "${PORT}"
  printf 'LOCAL_CODEX_ADAPTER_HOST=%q\n' "127.0.0.1"
  printf 'LOCAL_CODEX_ADAPTER_PORT=%q\n' "${ADAPTER_PORT}"
  printf 'LOCAL_CODEX_ADAPTER=%q\n' "${ADAPTER_PATH}"
  printf 'LOCAL_CODEX_TRACE_PROXY=%q\n' "${TRACE_PROXY_PATH}"
  printf 'LOCAL_CODEX_BIN=%q\n' "${INSTRUMENTED_CODEX_PATH}"
  printf 'LOCAL_CODEX_SECURE_BIN=%q\n' "${CODEX_WRAPPER_PATH}"
  printf 'LOCAL_CODEX_REAL_BIN=%q\n' "codex"
  printf 'LOCAL_CODEX_DIAGNOSTICS=%q\n' "${DIAGNOSTICS_PATH}"
  printf 'LOCAL_CODEX_TUNNEL_HEALTH_URL_FILE=%q\n' "${HEALTH_URL_FILE}"
  printf 'TUNNEL_CLIENT_PROFILE=%q\n' "${PROFILE_NAME}"
} > "${config_tmp}"
chmod 600 "${config_tmp}"
mv "${config_tmp}" "${CONFIG_FILE}"

profile_tmp=$(mktemp "${PROFILE_DIR}/${PROFILE_NAME}.yaml.XXXXXX")
node "${SOURCE_ROOT}/scripts/render-profile.mjs" \
  "${profile_tmp}" \
  "${tunnel_id}" \
  "${RUNTIME_API_KEY_FILE}" \
  "${TOKEN_FILE}" \
  "${HEALTH_URL_FILE}" \
  "${LOG_FILE}" \
  "${PORT}"
chmod 600 "${profile_tmp}"
mv "${profile_tmp}" "${PROFILE_FILE}"

print "Installed Local Codex tunnel with end-to-end tracing."
print "Start it with: ${LAUNCHER_PATH}"
print "Monitor activity with: ${WATCH_PATH}"
print "Run diagnostics with: ${DOCTOR_PATH}"
print "Run the harmless local canary with: ${CANARY_PATH}"
print "Render a sanitized job receipt with: ${RECEIPT_PATH} <jobId>"
