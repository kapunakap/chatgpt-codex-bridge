#!/bin/zsh
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/install.sh \
    [--root /absolute/path/to/legacy/repository] \
    --tunnel-id tunnel_... \
    --runtime-api-key-file /absolute/path/to/runtime-api-key \
    [--dry-run]
EOF
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
readonly TARGET_ROOT="${target_root:+${target_root:A}}"
readonly RUNTIME_API_KEY_FILE="${runtime_api_key_file:A}"
readonly USER_HOME="${HOME}"
readonly PROFILE_NAME="local-codex"
readonly PORT="8765"
readonly BIN_DIR="${USER_HOME}/.local/bin"
readonly LIBEXEC_DIR="${USER_HOME}/.local/libexec/local-codex-tunnel"
readonly STATE_DIR="${USER_HOME}/Library/Application Support/local-codex-tunnel"
readonly TUNNEL_STATE_DIR="${USER_HOME}/Library/Application Support/tunnel-client"
readonly PROFILE_DIR="${USER_HOME}/.config/tunnel-client"
readonly ADAPTER_PATH="${LIBEXEC_DIR}/adapter.mjs"
readonly LAUNCHER_PATH="${BIN_DIR}/local-codex-tunnel"
readonly TOKEN_FILE="${STATE_DIR}/adapter-token"
readonly THREADS_FILE="${STATE_DIR}/threads.json"
readonly CONFIG_FILE="${STATE_DIR}/config.env"
readonly PROFILE_FILE="${PROFILE_DIR}/${PROFILE_NAME}.yaml"
readonly HEALTH_URL_FILE="${TUNNEL_STATE_DIR}/health/${PROFILE_NAME}.url"
readonly LOG_FILE="${TUNNEL_STATE_DIR}/logs/${PROFILE_NAME}.log"

if [[ "${dry_run}" == "true" ]]; then
  print "DRY_RUN_OK"
  print "scope=per_job"
  print "legacy_root=${TARGET_ROOT}"
  print "launcher=${LAUNCHER_PATH}"
  print "profile=${PROFILE_FILE}"
  exit 0
fi

for required_command in node codex tunnel-client curl openssl; do
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

mkdir -p "${BIN_DIR}" "${LIBEXEC_DIR}" "${PROFILE_DIR}"
mkdir -p "${TUNNEL_STATE_DIR}/health" "${TUNNEL_STATE_DIR}/logs"
install -d -m 700 "${STATE_DIR}"
install -m 755 "${SOURCE_ROOT}/adapter.mjs" "${ADAPTER_PATH}"
install -m 755 "${SOURCE_ROOT}/bin/local-codex-tunnel" "${LAUNCHER_PATH}"

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
  printf 'LOCAL_CODEX_JOBS_DIR=%q\n' "${STATE_DIR}/jobs"
  printf 'LOCAL_CODEX_CALL_TIMEOUT_MS=%q\n' "1800000"
  printf 'LOCAL_CODEX_HOST=%q\n' "127.0.0.1"
  printf 'LOCAL_CODEX_PORT=%q\n' "${PORT}"
  printf 'LOCAL_CODEX_ADAPTER=%q\n' "${ADAPTER_PATH}"
  printf 'LOCAL_CODEX_BIN=%q\n' "codex"
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

print "Installed Local Codex tunnel."
print "Start it with: ${LAUNCHER_PATH}"
