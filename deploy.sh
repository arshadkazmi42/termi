#!/bin/bash

# ╔════════════════════════════════════════╗
# ║           TERMI — DEPLOY SCRIPT        ║
# ║   Web UI for Cursor Agent / Claude     ║
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
IS_MACOS=false

# Detect macOS
if [[ "$(uname -s)" == "Darwin" ]]; then
  IS_MACOS=true
  OS="macos"
elif [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
fi

case "$ARCH" in
  x86_64)  ARCH_LABEL="amd64" ;;
  aarch64) ARCH_LABEL="arm64" ;;
  arm64)   ARCH_LABEL="arm64" ;;  # macOS M1/M2/M3
  armv7l)  ARCH_LABEL="armv7" ;;
  *)       ARCH_LABEL=$ARCH ;;
esac

info "Detected OS: ${OS} | Arch: ${ARCH} (${ARCH_LABEL})"

# Detect package manager
if $IS_MACOS; then
  if command -v brew &>/dev/null; then
    PKG_MANAGER="brew"
  else
    warn "Homebrew not found. Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to PATH for Apple Silicon
    if [ -f /opt/homebrew/bin/brew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    PKG_MANAGER="brew"
  fi
elif command -v apt-get &>/dev/null; then
  PKG_MANAGER="apt"
elif command -v yum &>/dev/null; then
  PKG_MANAGER="yum"
elif command -v dnf &>/dev/null; then
  PKG_MANAGER="dnf"
elif command -v pacman &>/dev/null; then
  PKG_MANAGER="pacman"
else
  warn "No known package manager found. Manual install may be needed."
  PKG_MANAGER="unknown"
fi

ok "Package manager: ${PKG_MANAGER}"

# ── Config ────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Configuration${NC}"

# Default workdir differs on macOS vs Linux
if $IS_MACOS; then
  DEFAULT_WORK_DIR="$HOME/workspace"
else
  DEFAULT_WORK_DIR="/root/workspace"
fi

read -p "Work directory for agent [${DEFAULT_WORK_DIR}]: " WORK_DIR
WORK_DIR=${WORK_DIR:-$DEFAULT_WORK_DIR}

read -p "Auth token to protect the UI: " AUTH_TOKEN
if [ -z "$AUTH_TOKEN" ]; then
  AUTH_TOKEN=$(openssl rand -hex 16 2>/dev/null || echo "changeme123")
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
    brew)
      brew install node@20
      # Link if not already linked
      brew link node@20 2>/dev/null || true
      # Add to PATH for current session
      if [ -f /opt/homebrew/bin/node ]; then
        export PATH="/opt/homebrew/bin:$PATH"
      elif [ -f /usr/local/bin/node ]; then
        export PATH="/usr/local/bin:$PATH"
      fi
      ;;
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
    *)
      # Fallback — download binary directly (Linux only)
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
  info "Installing cloudflared..."

  if $IS_MACOS; then
    # macOS — use brew
    if command -v brew &>/dev/null; then
      brew install cloudflare/cloudflare/cloudflared
    else
      # Direct download for macOS
      if [ "$ARCH_LABEL" = "arm64" ]; then
        CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
      else
        CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
      fi
      curl -fsSL "$CF_URL" -o /tmp/cloudflared.tgz
      tar -xzf /tmp/cloudflared.tgz -C /usr/local/bin/
      chmod +x /usr/local/bin/cloudflared
      rm /tmp/cloudflared.tgz
    fi
  else
    # Linux
    CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH_LABEL}"
    [ "$ARCH_LABEL" = "armv7" ] && CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm"
    curl -fsSL "$CF_URL" -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
  fi

  ok "cloudflared installed"
}

USE_CLOUDFLARE=false
USE_CF_ACCESS=false

read -p "Setup Cloudflare tunnel for secure remote access? [y/N]: " CF
CF=${CF:-N}
if [[ "$CF" =~ ^[Yy] ]]; then
  USE_CLOUDFLARE=true
  if ! command -v cloudflared &>/dev/null; then
    install_cloudflared
  else
    ok "cloudflared $(cloudflared --version 2>&1 | head -1) already installed"
  fi

  echo ""
  echo -e "${BOLD}Cloudflare Access (Google Login)${NC}"
  echo -e "  Adds Google authentication in front of termi via Cloudflare Access."
  echo -e "  Requires: Cloudflare account + domain on Cloudflare DNS."
  echo ""
  read -p "Setup Cloudflare Access with Google login? [y/N]: " CFA
  CFA=${CFA:-N}
  if [[ "$CFA" =~ ^[Yy] ]]; then
    USE_CF_ACCESS=true

    read -p "Cloudflare tunnel name [termi]: " CF_TUNNEL_NAME
    CF_TUNNEL_NAME=${CF_TUNNEL_NAME:-termi}

    read -p "Domain to expose termi on (e.g. termi.yourdomain.com): " CF_DOMAIN
    if [ -z "$CF_DOMAIN" ]; then
      warn "No domain entered — skipping Cloudflare Access setup"
      USE_CF_ACCESS=false
    else
      read -p "Allowed Google email domain (e.g. yourdomain.com) or specific email: " CF_ALLOWED_EMAIL
      CF_ALLOWED_EMAIL=${CF_ALLOWED_EMAIL:-*}
    fi
  fi
else
  info "Skipping Cloudflare tunnel setup"
fi

# ── Deploy files ──────────────────────────────────────────
info "Deploying files..."

# macOS uses /usr/local/opt, Linux uses /opt
if $IS_MACOS; then
  INSTALL_DIR="$HOME/.termi"
else
  INSTALL_DIR="/opt/agent-ui"
fi

mkdir -p "$INSTALL_DIR/public"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/server.js" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/public/index.html" "$INSTALL_DIR/public/"
ok "Files copied to $INSTALL_DIR"

# ── Install npm dependencies ──────────────────────────────
info "Installing npm dependencies..."
cd "$INSTALL_DIR" && npm install --silent
ok "Dependencies installed"

# ── Find agent binary ─────────────────────────────────────
info "Locating agent binary..."
AGENT_BIN=$(which agent 2>/dev/null || echo "")
if [ -z "$AGENT_BIN" ]; then
  # Check common locations
  for loc in "$HOME/.local/bin/agent" "/usr/local/bin/agent" "/opt/homebrew/bin/agent" "$HOME/.cursor/bin/agent"; do
    if [ -f "$loc" ]; then
      AGENT_BIN="$loc"
      break
    fi
  done
fi

if [ -z "$AGENT_BIN" ]; then
  warn "agent binary not found. Make sure Cursor CLI is installed and 'agent' is in your PATH"
  AGENT_BIN="agent"
else
  ok "Found agent at: $AGENT_BIN"
fi

# ── Setup Claude Code non-root user ──────────────────────
CLAUDE_USER="termi"

setup_claude_user() {
  info "Setting up Claude Code user (${CLAUDE_USER})..."

  # Create user if not exists
  if ! id "$CLAUDE_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$CLAUDE_USER"
    ok "Created user: ${CLAUDE_USER}"
  else
    ok "User ${CLAUDE_USER} already exists"
  fi

  # Find claude binary and symlink to /usr/local/bin
  CLAUDE_BIN=$(command -v claude 2>/dev/null || find /root/.local/bin /usr/local/bin /home -name claude 2>/dev/null | head -1)
  if [ -n "$CLAUDE_BIN" ]; then
    if [ "$CLAUDE_BIN" != "/usr/local/bin/claude" ]; then
      ln -sf "$CLAUDE_BIN" /usr/local/bin/claude
    fi
    ok "Claude binary: ${CLAUDE_BIN} → /usr/local/bin/claude"
  else
    warn "claude not found in PATH — skipping Claude Code setup"
    return
  fi

  # Copy root's claude auth/config to the termi user
  ROOT_CLAUDE="${HOME:-/root}/.claude"
  TERMI_CLAUDE="/home/${CLAUDE_USER}/.claude"
  if [ -d "$ROOT_CLAUDE" ]; then
    rm -rf "$TERMI_CLAUDE"
    cp -r "$ROOT_CLAUDE" "$TERMI_CLAUDE"
    chown -R "${CLAUDE_USER}:${CLAUDE_USER}" "$TERMI_CLAUDE"
    ok "Copied claude config to /home/${CLAUDE_USER}/.claude"
  else
    warn "No ~/.claude config found — Claude may need to be authenticated manually as ${CLAUDE_USER}"
  fi

  # Grant termi access to the work directory
  chmod o+rx "$(dirname "$WORK_DIR")" 2>/dev/null || true
  chmod -R o+rw "$WORK_DIR" 2>/dev/null || true
  ok "Workspace ${WORK_DIR} accessible to ${CLAUDE_USER}"

  # Verify
  if su -s /bin/bash -c "claude --version" "$CLAUDE_USER" &>/dev/null; then
    ok "Claude Code verified working as ${CLAUDE_USER}"
  else
    warn "Could not verify claude as ${CLAUDE_USER} — check auth manually"
  fi
}

if command -v claude &>/dev/null || find /root/.local/bin -name claude &>/dev/null 2>/dev/null; then
  setup_claude_user
else
  warn "claude CLI not found — skipping Claude Code setup (install it later and re-run deploy.sh)"
fi

# ── Write .env ────────────────────────────────────────────
cat > "$INSTALL_DIR/.env" << ENV
WORK_DIR=$WORK_DIR
AUTH_TOKEN=$AUTH_TOKEN
PORT=$PORT
AGENT_BIN=$AGENT_BIN
CLAUDE_USER=$CLAUDE_USER
ENV
ok "Config written to $INSTALL_DIR/.env"

# ── Start with PM2 ───────────────────────────────────────
info "Starting Agent UI with PM2..."
cd "$INSTALL_DIR"
pm2 delete agent-ui 2>/dev/null || true
WORK_DIR=$WORK_DIR AUTH_TOKEN=$AUTH_TOKEN PORT=$PORT \
  pm2 start server.js --name agent-ui --update-env
pm2 save

# PM2 startup differs on macOS vs Linux
if $IS_MACOS; then
  # macOS uses launchd
  pm2 startup launchd 2>/dev/null || pm2 startup 2>/dev/null || true
else
  pm2 startup 2>/dev/null || true
fi

ok "Agent UI started"

# ── Get public URL ────────────────────────────────────────
if $IS_MACOS; then
  LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")
else
  LOCAL_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR-IP")
fi
PUBLIC_URL="http://${LOCAL_IP}:${PORT}"

# ── Start Cloudflare tunnel (if requested) ───────────────
CF_URL=""
if $USE_CLOUDFLARE; then
  pm2 delete termi-tunnel 2>/dev/null || true

  if $USE_CF_ACCESS; then
    # ── Named tunnel with Cloudflare Access ──────────────
    info "Setting up Cloudflare named tunnel with Access..."

    # Login to cloudflare if not already
    if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
      info "Authenticating with Cloudflare — a browser window will open..."
      cloudflared tunnel login
    fi

    # Create tunnel (or reuse existing)
    if ! cloudflared tunnel info "$CF_TUNNEL_NAME" &>/dev/null; then
      cloudflared tunnel create "$CF_TUNNEL_NAME"
      ok "Created tunnel: ${CF_TUNNEL_NAME}"
    else
      ok "Tunnel ${CF_TUNNEL_NAME} already exists"
    fi

    # Get tunnel ID
    CF_TUNNEL_ID=$(cloudflared tunnel info "$CF_TUNNEL_NAME" 2>/dev/null | grep -oP 'Your tunnel \K[a-f0-9-]+' || cloudflared tunnel list 2>/dev/null | grep "$CF_TUNNEL_NAME" | awk '{print $1}')

    if [ -z "$CF_TUNNEL_ID" ]; then
      warn "Could not get tunnel ID — check 'cloudflared tunnel list'"
    else
      # Write tunnel config
      mkdir -p "$HOME/.cloudflared"
      cat > "$HOME/.cloudflared/config-termi.yml" << CFGEOF
tunnel: ${CF_TUNNEL_ID}
credentials-file: ${HOME}/.cloudflared/${CF_TUNNEL_ID}.json

ingress:
  - hostname: ${CF_DOMAIN}
    service: http://localhost:${PORT}
  - service: http_status:404
CFGEOF
      ok "Tunnel config written to ~/.cloudflared/config-termi.yml"

      # Create DNS route
      info "Creating DNS route ${CF_DOMAIN} -> tunnel..."
      cloudflared tunnel route dns "$CF_TUNNEL_NAME" "$CF_DOMAIN" 2>/dev/null || warn "DNS route may already exist"

      # Start named tunnel via PM2
      pm2 start "cloudflared tunnel --config ${HOME}/.cloudflared/config-termi.yml run ${CF_TUNNEL_NAME}" \
        --name termi-tunnel --update-env 2>/dev/null || true
      pm2 save

      CF_URL="https://${CF_DOMAIN}"
      ok "Named tunnel started — ${CF_URL}"

      # ── Cloudflare Access policy ─────────────────────
      echo ""
      echo -e "${BOLD}Cloudflare Access — Google Login${NC}"
      echo ""
      echo -e "  Cloudflare Access policies must be configured via the dashboard."
      echo -e "  Follow these steps:"
      echo ""
      echo -e "  1. Go to ${CYAN}https://one.dash.cloudflare.com${NC}"
      echo -e "  2. Navigate to ${CYAN}Access → Applications → Add an application${NC}"
      echo -e "  3. Choose ${CYAN}Self-hosted${NC}"
      echo -e "  4. Set application domain to: ${CYAN}${CF_DOMAIN}${NC}"
      echo -e "  5. Add a policy:"
      echo -e "     - Action: ${CYAN}Allow${NC}"
      echo -e "     - Include: ${CYAN}Emails ending in ${CF_ALLOWED_EMAIL}${NC}"
      echo -e "  6. Under ${CYAN}Authentication → Identity providers${NC}, add ${CYAN}Google${NC}"
      echo -e "     (requires Google OAuth client ID + secret from console.cloud.google.com)"
      echo ""
      echo -e "  ${YELLOW}Google OAuth setup:${NC}"
      echo -e "  1. Go to ${CYAN}console.cloud.google.com → APIs & Services → Credentials${NC}"
      echo -e "  2. Create OAuth 2.0 Client ID (Web application)"
      echo -e "  3. Add redirect URI: ${CYAN}https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback${NC}"
      echo -e "  4. Copy Client ID + Secret into Cloudflare Access identity provider settings"
      echo ""
    fi
  else
    # ── Quick tunnel (random URL, no Access) ─────────────
    info "Starting Cloudflare quick tunnel..."
    pm2 start "cloudflared tunnel --url http://localhost:${PORT}" \
      --name termi-tunnel --no-autorestart 2>/dev/null || true
    pm2 save
    warn "Cloudflare URL will appear in: pm2 logs termi-tunnel"
  fi
fi

# ── Done ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           SETUP DONE                   ║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Local URL:${NC}    $PUBLIC_URL"
if [ -n "$CF_URL" ]; then
echo -e "  ${CYAN}Public URL:${NC}   $CF_URL (Cloudflare Access protected)"
fi
echo -e "  ${CYAN}Token:${NC}        $AUTH_TOKEN"
echo -e "  ${CYAN}Workdir:${NC}      $WORK_DIR"
echo -e "  ${CYAN}Install dir:${NC}  $INSTALL_DIR"
echo -e "  ${CYAN}Claude user:${NC}  $CLAUDE_USER"
echo ""
if $IS_MACOS; then
echo -e "  ${YELLOW}macOS notes:${NC}"
echo -e "  • Open http://localhost:${PORT} in browser"
echo -e "  • Use cloudflare tunnel URL for mobile access"
echo ""
fi
if $USE_CLOUDFLARE && ! $USE_CF_ACCESS; then
echo -e "  ${YELLOW}View cloudflare URL:${NC}"
echo -e "  pm2 logs termi-tunnel"
echo ""
fi
echo -e "  ${YELLOW}Manage:${NC}"
echo -e "  pm2 status          — check running processes"
echo -e "  pm2 logs agent-ui   — view server logs"
echo -e "  pm2 restart agent-ui — restart server"
echo ""
echo -e "  ${YELLOW}Re-sync claude auth (if you re-login):${NC}"
echo -e "  cp -r ~/.claude /home/${CLAUDE_USER}/.claude && chown -R ${CLAUDE_USER}:${CLAUDE_USER} /home/${CLAUDE_USER}/.claude"
echo ""
