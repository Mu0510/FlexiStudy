#!/usr/bin/env bash
set -euo pipefail

if [[ ${BASH_VERSINFO:-0} -lt 4 ]]; then
  echo "This script requires Bash 4 or newer." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
PROJECT_NAME="$(basename "$REPO_ROOT")"

log() {
  printf '\n[setup] %s\n' "$1"
}

die() {
  printf '\n[setup:ERROR] %s\n' "$1" >&2
  exit 1
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

OS_NAME="$(uname -s)"
install_node=0

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

  if ! command -v node >/dev/null 2>&1; then
    install_node=1
  else
    node_major=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ ${node_major:-0} -lt 20 ]]; then
      log "Detected Node.js version $(node --version). Upgrading to Node.js 20.x via NodeSource..."
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

  log "Installing dependencies via Homebrew..."
  brew install node@20 mkcert nss sqlite python@3.11 openssl || true
  brew link --overwrite node@20 || true
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

for cmd in node npm python3 sqlite3 openssl mkcert; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "Required command '$cmd' is not available even after attempted installation."
  fi
done

log "Node.js version: $(node --version)"
log "npm version: $(npm --version)"
log "Python version: $(python3 --version)"

log "Ensuring pnpm is installed..."
if ! command -v pnpm >/dev/null 2>&1; then
  log "pnpm not found, installing globally via npm..."
  if [[ -n "$SUDO" ]]; then
    $SUDO npm install -g pnpm || die "Failed to install pnpm globally."
  else
    npm install -g pnpm || die "Failed to install pnpm globally."
  fi
fi
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

log "Setup steps complete. Launching Gemini CLI to finish login..."
echo "\nWhen prompted by the Gemini CLI, follow the instructions to authenticate with your Google account."

if ! npx @google/gemini-cli@0.5.5; then
  die "Failed to run Gemini CLI."
fi

log "Setup complete. You can now start the development server with 'cd webnew && pnpm run dev'."