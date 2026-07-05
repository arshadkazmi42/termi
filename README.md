# termi

**Your whole server fleet — from any browser.** termi is a mobile-first dashboard that lets you manage many servers over SSH from one UI: watch and drive their `screen` sessions in a real terminal, chat with a coding agent (Cursor / Claude Code) on each box, and keep an eye on load, disk, and uptime across the fleet. Runs as a PWA, so you can install it to your phone's home screen.

![node](https://img.shields.io/badge/node-20+-6e72f0?style=flat-square&labelColor=0a0a0c)
![license](https://img.shields.io/badge/license-MIT-6e72f0?style=flat-square&labelColor=0a0a0c)

---

## What it does

- **Fleet dashboard** — every server you manage on one screen, each with a live status dot, running-session chips, and CPU/memory context. Search across the fleet; tap a card to jump in.
- **Real terminals over SSH** — attach to any `screen` session on any server from the browser. Full xterm terminal with a mobile key bar (arrows, tab, ^C, esc, scrollback), split panes, and a full-screen mode. Create and rename sessions from the UI.
- **Agent chat per server** — talk to Cursor Agent CLI or Claude Code running *on that box*, with conversation context kept separately per server.
- **Analytics & uptime** — a dedicated page with CPU load, memory, disk, and system uptime per server, continuous uptime-% tracking, and a downtime incident timeline.
- **One hub, many boxes** — termi runs on a single "hub" server and connects out to the rest over SSH. Target servers need nothing installed beyond `sshd` + `screen` (which they already have).
- **Secure by design** — SSH keys and passwords are encrypted at rest (AES-256-GCM); host keys are pinned on first connect (TOFU). Put it behind Cloudflare Access for email/Google-gated HTTPS.
- **Automation-friendly** — every view has its own URL and all controls are real labelled links/buttons/inputs, so browser agents and assistive tech can drive it reliably.

---

## How it works

```
  phone / laptop                     hub server                    your fleet
 ┌──────────────┐   HTTPS   ┌─────────────────────────┐   SSH   ┌──────────────┐
 │  termi PWA   │◀────────▶│  termi (Node + Express)  │◀──────▶│  server A     │
 │ (any browser)│  (WSS)    │  • server/key registry   │         │  sshd + screen│
 └──────────────┘           │  • ssh2 connection pool  │◀──────▶│  server B     │
   Cloudflare Access        │  • node-pty (local box)  │         └──────────────┘
   (email / Google)         └─────────────────────────┘              …
```

Browsers can't open raw SSH, so the SSH happens on the hub. The hub holds your server list and keys (encrypted), opens a pooled SSH connection per target, and streams `screen -x` / commands back over WebSocket. The hub's *own* box is always available as **"this server"** (via `node-pty`, no SSH needed).

Because the hub holds credentials to your whole fleet, **run it behind Cloudflare Access** (or an equivalent gate) and never expose it raw.

---

## Requirements

- A Linux server to act as the hub (any small VPS — Hetzner, DigitalOcean, etc.)
- Node.js 20+ (the deploy script installs it if missing)
- `screen` on every box you want to manage (already present on most)
- Optional: Cursor Agent CLI and/or Claude Code on any box where you want the **chat** tab

---

## Quick start

```bash
git clone https://github.com/arshadkazmi42/termi.git
cd termi
bash deploy.sh
```

`deploy.sh` detects your OS/arch and installs everything (Node, PM2, screen, build tools, and optionally cloudflared), then starts termi under PM2. It will ask:

| Prompt | Example |
|--------|---------|
| Work directory for the agent | `/root/workspace` |
| Auth token (protects the UI) | a long random string |
| Port | `3619` |
| Remote access | Tailscale / Cloudflare / none |

Then open `http://YOUR-SERVER-IP:3619`, enter your token, and you're on the dashboard.

> **Set a strong `AUTH_TOKEN`.** It's both the login gate *and* the key that encrypts your stored SSH secrets.

---

## Adding servers

On the dashboard, tap **+ add server**:

- **Name, host/IP, user, port** — the SSH connection details.
- **Authentication** — either:
  - **SSH key** — pick a stored key or paste a new private key (with an optional passphrase). Keys live on the **SSH keys** page (`#/keys`) where you can add, rename, re-passphrase, or delete them.
  - **Password** — stored encrypted, used directly and for keyboard-interactive prompts.

Nothing is copied to the target server — it already trusts your key (or password). termi stores the credential encrypted on the hub and connects out. Empty servers auto-provision a `"<name>.terminal"` screen session so there's always a shell to open.

---

## Usage

- **Dashboard** (`#/servers`) — the fleet. Status dots, session chips, search, add/edit/remove. "this server" is the hub itself.
- **Screens** (`#/srv/<id>/screens`) — a server's `screen` sessions. Tap to open a terminal; **+ new screen** to create; **✎** to rename.
- **Terminal** — full xterm attached via `screen -x` (the session keeps running when you leave). Mobile key bar, drag-to-scroll history (screen copy mode), split panes (desktop), and a full-screen mode.
- **Chat** (`#/srv/<id>/chat`) — Cursor/Claude agent on that server, context kept per server via `--continue`.
- **Analytics** (`#/analytics`) — fleet summary, per-server CPU/mem/disk/uptime, uptime %, and recent up/down incidents.

---

## Remote access & security

For access from anywhere, put the hub behind **Cloudflare Tunnel + Access**:

1. Create a named tunnel pointing your subdomain (e.g. `termi.example.com`) at `http://localhost:<port>`, and run it (systemd or `cloudflared ... run`).
2. In **Cloudflare Zero Trust → Access → Applications**, add a self-hosted app for that subdomain.
3. Add a policy: **Allow → Include → Emails →** your address. Pick a login method: **One-time PIN** (zero setup, emails a code) or **Google** (needs a Google OAuth client).

Now the URL is gated by your email before it ever reaches termi, and the auth token is a second layer. Security properties:

- **Secrets encrypted at rest** — SSH private keys and passwords are AES-256-GCM encrypted with a key derived (scrypt) from `AUTH_TOKEN`. They're never sent back to the browser and never committed (`data/` is gitignored).
- **Host-key pinning** — a server's SSH host key is pinned on first connect; a later mismatch is refused.
- **No inbound ports on your fleet** — only the hub reaches them, over ordinary SSH.

---

## Configuration

Environment variables (written to the install dir's `.env` by `deploy.sh`):

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | `changeme` | UI login token **and** the encryption key for stored secrets |
| `PORT` | `3619` | Port to serve on |
| `WORK_DIR` | `/root/workspace` | Directory the local agent runs in |
| `DATA_DIR` | `./data` | Where the encrypted registry and uptime history are stored |
| `CLAUDE_USER` | `termi` | Non-root user to run Claude Code as (when hub runs as root) |

State lives in `DATA_DIR`: `registry.json` (servers + encrypted keys/passwords) and `uptime.json` (downtime history). Back these up if you care about your server list — they're intentionally not in git.

---

## Managing the service

```bash
pm2 status
pm2 logs agent-ui
pm2 restart agent-ui
```

termi runs under PM2, auto-restarts on crash, and survives reboots.

---

## Development

```bash
npm install
AUTH_TOKEN=dev PORT=3619 node server.js   # http://localhost:3619
npm test                                   # unit + integration tests
```

Project layout:

```
server.js          Express + socket.io server; screen/chat/analytics events
lib/registry.js    server & SSH-key registry, encrypted at rest
lib/remote.js      ssh2 connection pool, host-key pinning, exec/pty helpers
lib/monitor.js     uptime / downtime tracker
public/index.html  the entire PWA (dashboard, terminal, chat, analytics)
public/sw.js       service worker
deploy.sh          one-shot installer (Node, PM2, screen, cloudflared)
tests/             node:test unit + integration suites
```

---

## License

MIT
