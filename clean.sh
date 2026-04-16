#!/bin/bash

# ╔════════════════════════════════════════╗
# ║         TERMI — CLEAN SCRIPT           ║
# ║   Stop and remove termi installation   ║
# ╚════════════════════════════════════════╝

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
info() { echo -e "${CYAN}▶${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

echo ""
echo -e "${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║         TERMI — CLEANUP                ║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""

# ── Stop PM2 processes ───────────────────────────────────
if command -v pm2 &>/dev/null; then
  info "Stopping PM2 processes..."

  pm2 delete agent-ui 2>/dev/null && ok "Stopped agent-ui" || warn "agent-ui not running"
  pm2 delete termi-tunnel 2>/dev/null && ok "Stopped termi-tunnel" || warn "termi-tunnel not running"
  pm2 save 2>/dev/null

  read -p "Remove PM2 startup config? [y/N]: " RM_STARTUP
  if [[ "$RM_STARTUP" =~ ^[Yy] ]]; then
    pm2 unstartup 2>/dev/null || true
    ok "PM2 startup removed"
  fi
else
  warn "PM2 not found — skipping process cleanup"
fi

# ── Remove install directory ─────────────────────────────
IS_MACOS=false
[[ "$(uname -s)" == "Darwin" ]] && IS_MACOS=true

if $IS_MACOS || [ "$(id -u)" -ne 0 ]; then
  INSTALL_DIR="$HOME/.termi"
else
  INSTALL_DIR="/opt/agent-ui"
fi

if [ -d "$INSTALL_DIR" ]; then
  read -p "Remove install directory ${INSTALL_DIR}? [y/N]: " RM_DIR
  if [[ "$RM_DIR" =~ ^[Yy] ]]; then
    rm -rf "$INSTALL_DIR"
    ok "Removed ${INSTALL_DIR}"
  fi
else
  warn "Install directory ${INSTALL_DIR} not found"
fi

# ── Remove cloudflared tunnel config ─────────────────────
if [ -f "$HOME/.cloudflared/config-termi.yml" ]; then
  read -p "Remove Cloudflare tunnel config? [y/N]: " RM_CF
  if [[ "$RM_CF" =~ ^[Yy] ]]; then
    rm -f "$HOME/.cloudflared/config-termi.yml"
    ok "Removed cloudflare tunnel config"
  fi
fi

# ── Remove termi user (Linux only) ──────────────────────
if ! $IS_MACOS && id "termi" &>/dev/null; then
  read -p "Remove termi system user? [y/N]: " RM_USER
  if [[ "$RM_USER" =~ ^[Yy] ]]; then
    userdel -r termi 2>/dev/null && ok "Removed user termi" || warn "Could not remove user termi"
  fi
fi

# ── Tailscale note ───────────────────────────────────────
if command -v tailscale &>/dev/null; then
  echo ""
  warn "Tailscale is installed but NOT removed (you may use it for other things)."
  echo -e "  To remove: ${CYAN}tailscale down && sudo apt remove tailscale${NC} (Linux)"
  echo -e "             ${CYAN}brew uninstall --cask tailscale${NC} (macOS)"
fi

# ── Done ─────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║         CLEANUP DONE                   ║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${YELLOW}Note:${NC} PM2 and Node.js were not uninstalled."
echo -e "  To remove them manually:"
echo -e "    npm uninstall -g pm2"
echo -e "    brew uninstall node  ${CYAN}(macOS)${NC}"
echo -e "    apt remove nodejs    ${CYAN}(Linux)${NC}"
echo ""
