#!/bin/bash

# ╔════════════════════════════════════════╗
# ║           TERMI — DEPLOY SCRIPT        ║
# ║   Web UI for Cursor Agent CLI          ║
# ╚════════════════════════════════════════╝

set -e

# ── Colors ────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
info() { echo -e "${CYAN}▶${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

echo ""
echo -e "${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║         TERMI — SETUP                  ║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""

# ── Detect OS & Architecture ──────────────────────────────
OS=""
ARCH=$(uname -m)
PKG_MANAGER=""

if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
fi

case "$ARCH" in
  x86_64)  ARCH_LABEL="amd64" ;;
  aarch64) ARCH_LABEL="arm64" ;;
  armv7l)  ARCH_LABEL="armv7" ;;
  *)       ARCH_LABEL=$ARCH ;;
esac

info "Detected OS: ${OS} | Arch: ${ARCH} (${ARCH_LABEL})"

# Detect package manager
if command -v apt-get &>/dev/null; then
  PKG_MANAGER="apt"
elif command -v yum &>/dev/null; then
  PKG_MANAGER="yum"
elif command -v dnf &>/dev/null; then
  PKG_MANAGER="dnf"
elif command -v pacman &>/dev/null; then
  PKG_MANAGER="pacman"
elif command -v brew &>/dev/null; then
  PKG_MANAGER="brew"
else
  warn "No known package manager found. Manual install may be needed."
  PKG_MANAGER="unknown"
fi

ok "Package manager: ${PKG_MANAGER}"

# ── Config ────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Configuration${NC}"
read -p "Work directory for agent [/root/workspace]: " WORK_DIR
WORK_DIR=${WORK_DIR:-/root/workspace}
read -p "Auth token to protect the UI: " AUTH_TOKEN
if [ -z "$AUTH_TOKEN" ]; then
  AUTH_TOKEN=$(openssl rand -hex 16 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "changeme123")
  warn "No token entered — generated: ${AUTH_TOKEN}"
fi
read -p "Port [3619]: " PORT
PORT=${PORT:-3619}

echo ""

# ── Install curl if missing ───────────────────────────────
if ! command -v curl &>/dev/null; then
  info "Installing curl..."
  case $PKG_MANAGER in
    apt)    apt-get update -qq && apt-get install -y curl ;;
    yum)    yum install -y curl ;;
    dnf)    dnf install -y curl ;;
    pacman) pacman -Sy --noconfirm curl ;;
    brew)   brew install curl ;;
  esac
fi

# ── Install Node.js ───────────────────────────────────────
if ! command -v node &>/dev/null; then
  info "Installing Node.js..."
  case $PKG_MANAGER in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y nodejs
      ;;
    yum|dnf)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      $PKG_MANAGER install -y nodejs
      ;;
    pacman)
      pacman -Sy --noconfirm nodejs npm
      ;;
    brew)
      brew install node
      ;;
    *)
      # Fallback — download binary directly
      NODE_VERSION="20.11.0"
      NODE_ARCH=$ARCH_LABEL
      [ "$ARCH" = "x86_64" ] && NODE_ARCH="x64"
      NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
      info "Downloading Node.js binary for ${ARCH}..."
      curl -fsSL "$NODE_URL" -o /tmp/node.tar.xz
      tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
      rm /tmp/node.tar.xz
      ;;
  esac
else
  ok "Node.js $(node -v) already installed"
fi

# ── Install PM2 ───────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2..."
  npm install -g pm2
else
  ok "PM2 $(pm2 -v) already installed"
fi

# ── Install cloudflared (optional) ───────────────────────
install_cloudflared() {
  info "Installing cloudflared for ${ARCH_LABEL}..."
  CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH_LABEL}"
  
  # arm fallback
  [ "$ARCH_LABEL" = "armv7" ] && CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm"

  curl -fsSL "$CF_URL" -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
  ok "cloudflared installed"
}

if ! command -v cloudflared &>/dev/null; then
  read -p "Install cloudflared for secure tunnel? (recommended) [Y/n]: " CF
  CF=${CF:-Y}
  if [[ "$CF" =~ ^[Yy] ]]; then
    install_cloudflared
  fi
else
  ok "cloudflared $(cloudflared --version 2>&1 | head -1) already installed"
fi

# ── Deploy files ──────────────────────────────────────────
info "Deploying files..."
mkdir -p /opt/agent-ui/public

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/server.js" /opt/agent-ui/
cp "$SCRIPT_DIR/package.json" /opt/agent-ui/
cp "$SCRIPT_DIR/public/index.html" /opt/agent-ui/public/
ok "Files copied to /opt/agent-ui"

# ── Install npm dependencies ──────────────────────────────
info "Installing npm dependencies..."
cd /opt/agent-ui && npm install --silent
ok "Dependencies installed"

# ── Write .env ────────────────────────────────────────────
cat > /opt/agent-ui/.env << ENV
WORK_DIR=$WORK_DIR
AUTH_TOKEN=$AUTH_TOKEN
PORT=$PORT
ENV
ok "Config written to /opt/agent-ui/.env"

# ── Start with PM2 ───────────────────────────────────────
info "Starting Agent UI with PM2..."
cd /opt/agent-ui
pm2 delete agent-ui 2>/dev/null || true
WORK_DIR=$WORK_DIR AUTH_TOKEN=$AUTH_TOKEN PORT=$PORT \
  pm2 start server.js --name agent-ui --update-env
pm2 save
pm2 startup 2>/dev/null || true
ok "Agent UI started"

# ── Start cloudflare tunnel if installed ──────────────────
PUBLIC_URL="http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR-IP'):${PORT}"
if command -v cloudflared &>/dev/null; then
  info "Starting Cloudflare tunnel..."
  pm2 delete termi-tunnel 2>/dev/null || true
  pm2 start "cloudflared tunnel --url http://localhost:${PORT}" \
    --name termi-tunnel --no-autorestart 2>/dev/null || true
  pm2 save
  warn "Cloudflare URL will appear in: pm2 logs termi-tunnel"
fi

# ── Done ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           SETUP DONE ✓                 ║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Local URL:${NC}   $PUBLIC_URL"
echo -e "  ${CYAN}Token:${NC}       $AUTH_TOKEN"
echo -e "  ${CYAN}Workdir:${NC}     $WORK_DIR"
echo -e "  ${CYAN}Session:${NC}     $SCREEN_SESSION"
echo ""
echo -e "  ${YELLOW}Start your agent session:${NC}"
echo -e "  screen -S $SCREEN_SESSION"
echo -e "  agent --yolo   (inside screen)"
echo -e "  Ctrl+A D       (detach)"
echo ""
echo -e "  ${YELLOW}View cloudflare URL:${NC}"
echo -e "  pm2 logs termi-tunnel"
echo ""
