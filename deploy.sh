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

# ── Remote Access (optional) ─────────────────────────────
USE_TAILSCALE=false
USE_CLOUDFLARE=false

echo -e "${BOLD}Remote Access${NC}"
echo -e "  How do you want to access termi from your phone?"
echo ""
echo -e "  1) ${CYAN}Tailscale${NC} (recommended) — private network, only your devices, no domain needed"
echo -e "  2) ${CYAN}Cloudflare Tunnel${NC} — public URL with optional Google login, needs domain"
echo -e "  3) ${CYAN}None${NC} — local access only (localhost:${PORT})"
echo ""
read -p "Choose [1/2/3]: " REMOTE_CHOICE
REMOTE_CHOICE=${REMOTE_CHOICE:-3}

if [ "$REMOTE_CHOICE" = "1" ]; then
  USE_TAILSCALE=true

  # Install Tailscale
  if ! command -v tailscale &>/dev/null; then
    info "Installing Tailscale..."
    if $IS_MACOS; then
      if command -v brew &>/dev/null; then
        brew install --cask tailscale
      else
        fail "Install Tailscale from https://tailscale.com/download/mac"
      fi
    else
      curl -fsSL https://tailscale.com/install.sh | sh
    fi
    ok "Tailscale installed"
  else
    ok "Tailscale already installed"
  fi

  # Check if Tailscale is running
  if ! tailscale status &>/dev/null; then
    info "Starting Tailscale — you may need to authenticate..."
    if $IS_MACOS; then
      echo ""
      echo -e "  ${YELLOW}macOS:${NC} Open the Tailscale app and sign in."
      echo -e "  Then re-run this script."
      echo ""
      warn "Tailscale not connected yet — continuing setup, connect manually after"
    else
      tailscale up
      ok "Tailscale connected"
    fi
  else
    ok "Tailscale connected"
  fi

elif [ "$REMOTE_CHOICE" = "2" ]; then
  USE_CLOUDFLARE=true

  # Install cloudflared
  if ! command -v cloudflared &>/dev/null; then
    info "Installing cloudflared..."
    if $IS_MACOS; then
      if command -v brew &>/dev/null; then
        brew install cloudflare/cloudflare/cloudflared
      else
        if [ "$ARCH_LABEL" = "arm64" ]; then
          CF_DL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
        else
          CF_DL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
        fi
        curl -fsSL "$CF_DL" -o /tmp/cloudflared.tgz
        tar -xzf /tmp/cloudflared.tgz -C /usr/local/bin/
        chmod +x /usr/local/bin/cloudflared
        rm /tmp/cloudflared.tgz
      fi
    else
      CF_DL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH_LABEL}"
      [ "$ARCH_LABEL" = "armv7" ] && CF_DL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm"
      curl -fsSL "$CF_DL" -o /usr/local/bin/cloudflared
      chmod +x /usr/local/bin/cloudflared
    fi
    ok "cloudflared installed"
  else
    ok "cloudflared already installed"
  fi

  echo ""
  echo -e "  ${CYAN}a)${NC} Quick tunnel — random URL, no domain needed"
  echo -e "  ${CYAN}b)${NC} Named tunnel — custom domain + optional Google login"
  echo ""
  read -p "Choose [a/b]: " CF_TYPE
  CF_TYPE=${CF_TYPE:-a}

  if [ "$CF_TYPE" = "b" ]; then
    USE_CF_ACCESS=true

    read -p "Cloudflare tunnel name [termi]: " CF_TUNNEL_NAME
    CF_TUNNEL_NAME=${CF_TUNNEL_NAME:-termi}

    read -p "Domain (e.g. termi.yourdomain.com): " CF_DOMAIN
    if [ -z "$CF_DOMAIN" ]; then
      warn "No domain entered — falling back to quick tunnel"
      USE_CF_ACCESS=false
    else
      read -p "Allowed email (e.g. you@gmail.com): " CF_ALLOWED_EMAIL
      CF_ALLOWED_EMAIL=${CF_ALLOWED_EMAIL:-*}
    fi
  else
    USE_CF_ACCESS=false
  fi
else
  info "Local access only — skipping remote access setup"
fi

# ── Deploy files ──────────────────────────────────────────
info "Deploying files..."

# Install to home dir for non-root or macOS, /opt for root Linux
if $IS_MACOS || [ "$(id -u)" -ne 0 ]; then
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

# Only setup claude user when running as root — non-root users already have their own claude
if [ "$(id -u)" -eq 0 ]; then
  if command -v claude &>/dev/null || find /root/.local/bin -name claude &>/dev/null 2>/dev/null; then
    setup_claude_user
  else
    warn "claude CLI not found — skipping Claude Code setup (install it later and re-run deploy.sh)"
  fi
else
  CLAUDE_USER=$(whoami)
  if command -v claude &>/dev/null; then
    ok "Claude Code available for ${CLAUDE_USER}"
  else
    warn "claude not found in PATH — install it and re-run deploy.sh"
  fi
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

# ── Start remote access ──────────────────────────────────
REMOTE_URL=""

if $USE_TAILSCALE; then
  # Get Tailscale IP
  TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
  if [ -n "$TS_IP" ]; then
    REMOTE_URL="http://${TS_IP}:${PORT}"
    ok "Tailscale access: ${REMOTE_URL}"
  else
    warn "Tailscale IP not available — connect Tailscale and check with: tailscale ip -4"
  fi
fi

if $USE_CLOUDFLARE; then
  pm2 delete termi-tunnel 2>/dev/null || true

  if [ "${USE_CF_ACCESS:-false}" = "true" ]; then
    info "Setting up Cloudflare named tunnel..."

    if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
      info "Authenticating with Cloudflare — a browser window will open..."
      cloudflared tunnel login
    fi

    if ! cloudflared tunnel info "$CF_TUNNEL_NAME" &>/dev/null; then
      cloudflared tunnel create "$CF_TUNNEL_NAME"
      ok "Created tunnel: ${CF_TUNNEL_NAME}"
    else
      ok "Tunnel ${CF_TUNNEL_NAME} already exists"
    fi

    CF_TUNNEL_ID=$(cloudflared tunnel info "$CF_TUNNEL_NAME" 2>/dev/null | grep -oP 'Your tunnel \K[a-f0-9-]+' || cloudflared tunnel list 2>/dev/null | grep "$CF_TUNNEL_NAME" | awk '{print $1}')

    if [ -z "$CF_TUNNEL_ID" ]; then
      warn "Could not get tunnel ID — check 'cloudflared tunnel list'"
    else
      mkdir -p "$HOME/.cloudflared"
      cat > "$HOME/.cloudflared/config-termi.yml" << CFGEOF
tunnel: ${CF_TUNNEL_ID}
credentials-file: ${HOME}/.cloudflared/${CF_TUNNEL_ID}.json

ingress:
  - hostname: ${CF_DOMAIN}
    service: http://localhost:${PORT}
  - service: http_status:404
CFGEOF
      ok "Tunnel config written"

      info "Creating DNS route ${CF_DOMAIN} -> tunnel..."
      cloudflared tunnel route dns "$CF_TUNNEL_NAME" "$CF_DOMAIN" 2>/dev/null || warn "DNS route may already exist"

      pm2 start "cloudflared tunnel --config ${HOME}/.cloudflared/config-termi.yml run ${CF_TUNNEL_NAME}" \
        --name termi-tunnel --update-env 2>/dev/null || true
      pm2 save

      REMOTE_URL="https://${CF_DOMAIN}"
      ok "Named tunnel started — ${REMOTE_URL}"

      echo ""
      echo -e "${BOLD}Cloudflare Access — Google Login${NC}"
      echo ""
      echo -e "  To protect termi with Google login, configure in Cloudflare dashboard:"
      echo ""
      echo -e "  1. Go to ${CYAN}https://dash.cloudflare.com${NC}"
      echo -e "  2. ${CYAN}Zero Trust → Access → Applications → Add application${NC}"
      echo -e "  3. Choose ${CYAN}Self-hosted${NC}, set domain to: ${CYAN}${CF_DOMAIN}${NC}"
      echo -e "  4. Add policy: Action ${CYAN}Allow${NC}, Include: Emails = ${CYAN}${CF_ALLOWED_EMAIL}${NC}"
      echo -e "  5. ${CYAN}Zero Trust → Settings → Authentication → Add Google${NC}"
      echo ""
      echo -e "  ${YELLOW}Google OAuth (one-time):${NC}"
      echo -e "  1. ${CYAN}console.cloud.google.com → APIs & Services → Credentials${NC}"
      echo -e "  2. Create OAuth 2.0 Client ID (Web application)"
      echo -e "  3. Redirect URI: ${CYAN}https://<team>.cloudflareaccess.com/cdn-cgi/access/callback${NC}"
      echo -e "  4. Paste Client ID + Secret into Cloudflare"
      echo ""
    fi
  else
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
if [ -n "$REMOTE_URL" ]; then
echo -e "  ${CYAN}Remote URL:${NC}   $REMOTE_URL"
fi
echo -e "  ${CYAN}Token:${NC}        $AUTH_TOKEN"
echo -e "  ${CYAN}Workdir:${NC}      $WORK_DIR"
echo -e "  ${CYAN}Install dir:${NC}  $INSTALL_DIR"
echo -e "  ${CYAN}Claude user:${NC}  $CLAUDE_USER"
echo ""
echo -e "${BOLD}── Access from your devices ──────────────────${NC}"
echo ""
if $USE_TAILSCALE; then
echo -e "  ${YELLOW}Mobile (iPhone / Android):${NC}"
echo -e "  1. Install Tailscale app from App Store or Play Store"
echo -e "  2. Sign in with the same account used on this server"
echo -e "  3. Open Safari/Chrome and go to: ${CYAN}${REMOTE_URL}${NC}"
echo -e "  4. Enter your auth token: ${CYAN}${AUTH_TOKEN}${NC}"
echo ""
echo -e "  ${YELLOW}Desktop (laptop / another machine):${NC}"
echo -e "  1. Install Tailscale: ${CYAN}https://tailscale.com/download${NC}"
echo -e "  2. Sign in with the same account"
echo -e "  3. Open browser and go to: ${CYAN}${REMOTE_URL}${NC}"
echo -e "  4. Enter your auth token: ${CYAN}${AUTH_TOKEN}${NC}"
echo ""
echo -e "  ${YELLOW}Same machine:${NC}"
echo -e "  Open browser → ${CYAN}http://localhost:${PORT}${NC}"
echo ""
elif $USE_CLOUDFLARE; then
  if [ "${USE_CF_ACCESS:-false}" = "true" ]; then
echo -e "  ${YELLOW}Mobile & Desktop:${NC}"
echo -e "  1. Open browser and go to: ${CYAN}${REMOTE_URL}${NC}"
echo -e "  2. Sign in with your Google account (${CYAN}${CF_ALLOWED_EMAIL}${NC})"
echo -e "  3. Enter your auth token: ${CYAN}${AUTH_TOKEN}${NC}"
echo ""
echo -e "  ${YELLOW}Same machine:${NC}"
echo -e "  Open browser → ${CYAN}http://localhost:${PORT}${NC}"
echo ""
  else
echo -e "  ${YELLOW}Mobile & Desktop:${NC}"
echo -e "  1. Get your Cloudflare URL: ${CYAN}pm2 logs termi-tunnel${NC}"
echo -e "     (look for a line like: ${CYAN}https://random-name.trycloudflare.com${NC})"
echo -e "  2. Open that URL in your phone/desktop browser"
echo -e "  3. Enter your auth token: ${CYAN}${AUTH_TOKEN}${NC}"
echo -e "  Note: URL changes on restart — re-check with pm2 logs"
echo ""
echo -e "  ${YELLOW}Same machine:${NC}"
echo -e "  Open browser → ${CYAN}http://localhost:${PORT}${NC}"
echo ""
  fi
else
echo -e "  ${YELLOW}Same network (WiFi):${NC}"
echo -e "  1. Find this machine's local IP: ${CYAN}${PUBLIC_URL}${NC}"
echo -e "  2. Open that URL on your phone/desktop browser"
echo -e "  3. Enter your auth token: ${CYAN}${AUTH_TOKEN}${NC}"
echo -e "  Note: phone must be on the same WiFi network"
echo ""
echo -e "  ${YELLOW}Same machine:${NC}"
echo -e "  Open browser → ${CYAN}http://localhost:${PORT}${NC}"
echo ""
fi
echo -e "${BOLD}── Management ───────────────────────────────${NC}"
echo ""
echo -e "  pm2 status          — check running processes"
echo -e "  pm2 logs agent-ui   — view server logs"
echo -e "  pm2 restart agent-ui — restart server"
echo ""
echo -e "  ${YELLOW}Re-sync claude auth (if you re-login):${NC}"
echo -e "  cp -r ~/.claude /home/${CLAUDE_USER}/.claude && chown -R ${CLAUDE_USER}:${CLAUDE_USER} /home/${CLAUDE_USER}/.claude"
echo ""
