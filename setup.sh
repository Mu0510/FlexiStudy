#!/usr/bin/env bash
set -euo pipefail

OS_NAME="$(uname -s)"

log() {
  printf '\n[setup] %s\n' "$1"
}

warn() {
  printf '\n[setup:WARN] %s\n' "$1" >&2
}

die() {
  printf '\n[setup:ERROR] %s\n' "$1" >&2
  exit 1
}

if [[ -z ${BASH_VERSION:-} ]]; then
  die "This script must be run with Bash."
fi

bash_major=${BASH_VERSINFO[0]:-0}
if (( bash_major < 4 )); then
  if [[ "$OS_NAME" == "Darwin" && bash_major -ge 3 ]]; then
    warn "Detected Bash $BASH_VERSION. Consider installing a newer Bash (e.g. 'brew install bash') if you encounter issues."
  else
    die "This script requires Bash 4 or newer."
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
PROJECT_NAME="$(basename "$REPO_ROOT")"

DEFAULT_GEMINI_RUN_USER="geminicli"

determine_invoking_user() {
  if [[ -n ${SUDO_USER:-} ]]; then
    printf '%s' "$SUDO_USER"
    return
  fi

  if [[ -n ${USER:-} ]]; then
    printf '%s' "$USER"
    return
  fi

  if command -v id >/dev/null 2>&1; then
    id -un
    return
  fi

  if command -v whoami >/dev/null 2>&1; then
    whoami
    return
  fi

  printf '%s' ""
}

need_sudo=${SUDO:-}
if [[ -z ${need_sudo} ]]; then
  if [[ $EUID -eq 0 ]]; then
    SUDO=""
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "This script needs to install system packages but 'sudo' was not found. Please install sudo or rerun as root."
  fi
fi

sudo_can_see() {
  local binary="$1"
  if [[ -z ${SUDO:-} ]]; then
    command -v "$binary" >/dev/null 2>&1
  else
    $SUDO sh -c "command -v '$binary' >/dev/null 2>&1"
  fi
}

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    return
  fi

  log "Installing curl..."
  if [[ $OS_NAME == "Linux" ]] && command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update
    $SUDO apt-get install -y curl
  elif [[ $OS_NAME == "Darwin" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      die "Homebrew is required on macOS. Install it from https://brew.sh/ and rerun."
    fi
    brew install curl
  else
    die "curl is required but could not be installed automatically."
  fi
}

install_linux_dependencies() {
  if ! command -v apt-get >/dev/null 2>&1; then
    die "Unsupported Linux distribution. Install dependencies manually (Node.js 20, npm, python3, sqlite3, openssl, mkcert)."
  fi

  log "Updating apt package index..."
  $SUDO apt-get update

  log "Installing base packages..."
  $SUDO apt-get install -y python3 python3-venv python3-pip sqlite3 openssl libnss3-tools mkcert ca-certificates

  local install_node=0
  if ! command -v node >/dev/null 2>&1; then
    install_node=1
  else
    node_major=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ ${node_major:-0} -lt 20 ]]; then
      log "Detected Node.js version $(node --version). Upgrading to Node.js 20.x via NodeSource..."
      install_node=1
    fi
  fi

  if [[ $install_node -eq 0 && -n ${SUDO:-} ]]; then
    if ! sudo_can_see node || ! sudo_can_see npm; then
      log "Existing Node.js installation is not visible to root. Installing Node.js 20.x via NodeSource for system-wide availability..."
      install_node=1
    fi
  fi

  if [[ $install_node -eq 1 ]]; then
    ensure_curl
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
    $SUDO apt-get install -y nodejs
  fi
}

install_macos_dependencies() {
  if ! command -v brew >/dev/null 2>&1; then
    die "Homebrew is required on macOS. Install it from https://brew.sh/ and rerun."
  fi

  log "Updating Homebrew..."
  brew update

  ensure_node_with_brew
  ensure_python_with_brew

  for formula in mkcert nss sqlite openssl; do
    brew_install_or_upgrade "$formula"
  done
}

prepend_path_if_missing() {
  local dir="$1"
  if [[ -d "$dir" ]] && [[ ":$PATH:" != *":$dir:"* ]]; then
    PATH="$dir:$PATH"
    export PATH
  fi
}

brew_install_or_upgrade() {
  local formula="$1"
  if brew ls --versions "$formula" >/dev/null 2>&1; then
    log "Upgrading $formula via Homebrew if needed..."
    brew upgrade "$formula" || true
  else
    log "Installing $formula via Homebrew..."
    brew install "$formula"
  fi
}

python3_meets_requirement() {
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  if python3 -c "import sys; exit(0 if sys.version_info >= (3, 11) else 1)" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

ensure_python_with_brew() {
  local formula="python@3.11"
  if python3_meets_requirement; then
    log "Detected Python $(python3 --version)."
  else
    log "Installing Python 3.11 via Homebrew..."
    brew_install_or_upgrade "$formula"
    brew link --overwrite --force "$formula" || true
  fi

  if brew ls --versions "$formula" >/dev/null 2>&1; then
    local python_prefix
    python_prefix="$(brew --prefix "$formula" 2>/dev/null || true)"
    if [[ -n "$python_prefix" ]]; then
      prepend_path_if_missing "$python_prefix/bin"
      hash -r 2>/dev/null || true
    fi
  fi
}

ensure_node_with_brew() {
  local desired_major=20
  local install_node=0

  if ! command -v node >/dev/null 2>&1; then
    install_node=1
  else
    local node_major
    node_major=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ -z ${node_major:-} || ${node_major} -lt desired_major ]]; then
      install_node=1
    fi
  fi

  if [[ $install_node -eq 1 ]]; then
    log "Installing Node.js ${desired_major}.x via Homebrew..."
    brew_install_or_upgrade "node@${desired_major}"
  else
    log "Detected Node.js $(node --version)."
  fi

  if brew ls --versions "node@${desired_major}" >/dev/null 2>&1; then
    local node_prefix
    node_prefix="$(brew --prefix "node@${desired_major}" 2>/dev/null || true)"
    if [[ -n "$node_prefix" ]]; then
      prepend_path_if_missing "$node_prefix/bin"
      hash -r 2>/dev/null || true
    fi
    brew link --overwrite --force "node@${desired_major}" || true
  fi
}

npm_global_install() {
  local package="$1"
  if [[ -n "$SUDO" ]]; then
    if ! sudo_can_see npm; then
      warn "npm is not available when using sudo. A system-wide Node.js installation is required."
      return 127
    fi
    $SUDO npm install -g "$package"
  else
    npm install -g "$package"
  fi
}

ensure_global_npm_cli() {
  log "Ensuring npm is installed globally..."
  if ! command -v npm >/dev/null 2>&1; then
    die "npm command not found even after Node.js installation."
  fi

  if [[ -n "$SUDO" ]] && ! sudo_can_see npm; then
    die "npm command is not accessible with sudo even after installation. Ensure Node.js is installed system-wide and rerun the setup."
  fi

  if ! npm_global_install npm; then
    die "Failed to install npm globally."
  fi

  hash -r 2>/dev/null || true
}

ensure_global_pnpm() {
  log "Ensuring pnpm is installed globally..."
  if command -v pnpm >/dev/null 2>&1; then
    log "Detected pnpm $(pnpm --version). Updating global installation to ensure root access..."
  else
    log "pnpm not found, installing globally via npm..."
  fi

  if ! npm_global_install pnpm; then
    die "Failed to install pnpm globally."
  fi

  hash -r 2>/dev/null || true

  if [[ -n "$SUDO" ]] && ! sudo_can_see pnpm; then
    die "pnpm command is not accessible with sudo even after installation."
  fi
}

case "$OS_NAME" in
  Linux)
    install_linux_dependencies
    ;;
  Darwin)
    install_macos_dependencies
    ;; 
  *)
    die "Unsupported operating system: $OS_NAME"
    ;;
esac

ensure_global_npm_cli
ensure_global_pnpm

set_env_var_in_file() {
  local env_path="$1"
  local key="$2"
  local value="$3"

  python3 - "$env_path" "$key" "$value" <<'PY'
import os
import sys

env_path, key, value = sys.argv[1:4]
lines = []
found = False

if os.path.exists(env_path):
    with open(env_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

for idx, line in enumerate(lines):
    if line.startswith(f"{key}="):
        lines[idx] = f"{key}={value}\n"
        found = True
        break

if not found:
    if lines and not lines[-1].endswith("\n"):
        lines[-1] = lines[-1] + "\n"
    lines.append(f"{key}={value}\n")

with open(env_path, 'w', encoding='utf-8') as f:
    f.writelines(lines)
PY
}

for cmd in node npm pnpm python3 sqlite3 openssl mkcert; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "Required command '$cmd' is not available even after attempted installation."
  fi
done

log "Node.js version: $(node --version)"
log "npm version: $(npm --version)"
log "Python version: $(python3 --version)"

log "pnpm version: $(pnpm --version)"

log "Ensuring mkcert trust store is configured..."
mkcert -install

CERT_DIR="$REPO_ROOT/webnew/certs"
mkdir -p "$CERT_DIR"

log "Creating fresh development certificates with mkcert..."
mkcert -cert-file "$CERT_DIR/cert.pem" -key-file "$CERT_DIR/key.pem" localhost 127.0.0.1 ::1

log "Removing existing lockfiles..."
rm -f "$REPO_ROOT/package-lock.json"
rm -f "$REPO_ROOT/webnew/package-lock.json"
rm -f "$REPO_ROOT/pnpm-lock.yaml"

log "Installing Node.js dependencies at repository root with pnpm..."
pnpm install --dir "$REPO_ROOT"

log "Installing Node.js dependencies for web frontend with pnpm..."
pnpm install --dir "$REPO_ROOT/webnew"

log "Initializing Python SQLite databases..."
python3 "$REPO_ROOT/manage_log.py" --help >/dev/null
python3 "$REPO_ROOT/manage_context.py" --help >/dev/null

log "Ensuring notify and runtime directories exist..."
mkdir -p "$REPO_ROOT/webnew/notify"/{config,schedule,prompts,policy}
mkdir -p "$REPO_ROOT/webnew/mnt/runtime"

create_env_file() {
  local env_path="$1"
  if [[ -f "$env_path" ]]; then
    log "Environment file $env_path already exists. Skipping creation."
    return
  fi
  log "Creating environment file at $env_path"
  cat <<EOF > "$env_path"
NODE_ENV=development
PORT=3000
HOST=127.0.0.1
ENABLE_DEV_HTTPS=true
NEXT_PUBLIC_PROJECT_ROOT="$REPO_ROOT"
NEXT_PUBLIC_PROJECT_ROOT_BASENAME="$PROJECT_NAME"
EOF
}

create_env_file "$REPO_ROOT/.env.local"
create_env_file "$REPO_ROOT/webnew/.env.local"

gemini_run_user="$(determine_invoking_user)"
if [[ -z "$gemini_run_user" ]]; then
  warn "Unable to determine invoking user. Falling back to default '$DEFAULT_GEMINI_RUN_USER'."
  gemini_run_user="$DEFAULT_GEMINI_RUN_USER"
fi

log "Configuring GEMINI_RUN_AS_USER=$gemini_run_user in environment files..."
set_env_var_in_file "$REPO_ROOT/.env.local" "GEMINI_RUN_AS_USER" "$gemini_run_user"
set_env_var_in_file "$REPO_ROOT/webnew/.env.local" "GEMINI_RUN_AS_USER" "$gemini_run_user"

log "Setup steps complete. Launching Gemini CLI to finish login..."
echo "\nWhen prompted by the Gemini CLI, follow the instructions to authenticate with your Google account."

if ! npx @google/gemini-cli@0.8.2; then
  die "Failed to run Gemini CLI."
fi

log "Setup complete. You can now start the development server with 'cd webnew && sudo -E npm run dev 2>&1 | cat'."
