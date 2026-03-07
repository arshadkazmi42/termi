# termi

A lightweight web UI that lets you chat with your **Cursor Agent CLI** from any browser — phone, tablet, or desktop. No laptop needed.

![termi](https://img.shields.io/badge/termi-agent%20UI-00ff88?style=flat-square&labelColor=0a0a0f)
![node](https://img.shields.io/badge/node-20+-00ff88?style=flat-square&labelColor=0a0a0f)
![license](https://img.shields.io/badge/license-MIT-00ff88?style=flat-square&labelColor=0a0a0f)

---

## What it does

- Chat with Cursor Agent CLI from any browser
- Full conversation context maintained via `--continue` flag
- Run shell commands directly from the UI
- Stream agent responses live as they type
- Reset conversation with one click
- Mobile responsive — works great on phone

---

## Requirements

- A Linux VPS (Hetzner, DigitalOcean, AWS, etc.)
- Cursor account

---

## Step 1 — Install Cursor Agent CLI

On your VPS, run:

```bash
curl -fsSL https://cursor.sh/install-agent | bash
```

Verify it installed:

```bash
agent --version
```

---

## Step 2 — Login to Cursor

```bash
agent login
```

This will give you a URL to open in your browser. Login with your Cursor account and come back. You should see:

```
✓ Logged in as your@email.com
```

Verify:

```bash
agent status
```

---

## Step 3 — Deploy termi

Clone the repo:

```bash
git clone https://github.com/yourusername/termi.git
cd termi
```

Run the deploy script:

```bash
bash deploy.sh
```

The script will ask you:

| Question | Example |
|----------|---------|
| Work directory for agent | `/root/workspace/my-project` |
| Auth token | `mysecrettoken123` |
| Port | `3619` |
| Install cloudflared? | `Y` |

It automatically detects your OS and architecture and installs everything needed.

---

## Step 4 — Access termi

**Local access:**
```
http://YOUR-VPS-IP:3619
```

**Secure access via Cloudflare Tunnel (recommended):**

If you chose to install cloudflared, get your public URL:

```bash
pm2 logs termi-tunnel
```

Look for a line like:
```
https://random-name.trycloudflare.com
```

Open that URL from anywhere — phone, tablet, any browser. No open ports needed.

Enter your auth token on the login screen and click **Connect**.

---

## How context works

termi uses Cursor's built-in `--continue` flag to maintain conversation context across messages. Each message runs a fresh `agent` process but continues the same session:

- **First message** → starts a new session
- **Every message after** → continues the same session with full context
- **RESET button** → starts a brand new session

No need to keep any process alive in the background.

---

## Usage

### Agent Chat mode
Type your message and press Enter or tap Send. The agent responds with full context from previous messages.

### Command mode
Switch to the **Command** tab to run raw shell commands directly on your server.

### Quick commands
Tap the quick buttons (server status, processes, disk, deploy) for one-tap common tasks.

### Reset conversation
Click **RESET** in the header to start a fresh conversation.

---

## Keeping it running

termi runs via PM2 which auto-restarts on crash and survives reboots.

```bash
# Check status
pm2 status

# View logs
pm2 logs agent-ui

# Restart
pm2 restart agent-ui

# Stop
pm2 stop agent-ui
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | `changeme` | Token to protect your UI |
| `PORT` | `3619` | Port to run on |
| `WORK_DIR` | `/root/workspace` | Directory agent runs commands in |

Set in `/opt/agent-ui/.env` and restart:

```bash
pm2 restart agent-ui
```

---

## Troubleshooting

**Agent not found in PATH**
```bash
which agent
export PATH=$PATH:/path/to/agent
```

**Auth token forgotten**
```bash
cat /opt/agent-ui/.env
```

**Agent not responding**
```bash
# Test agent directly on your server
echo "hello" | agent --print --trust --yolo
```

**Port already in use**
```bash
lsof -i :3619
# Change port in .env and restart
pm2 restart agent-ui
```

---

## Security

- Always set a strong `AUTH_TOKEN`
- Use Cloudflare Tunnel instead of exposing the port directly
- For extra security add Cloudflare Access (Google login) on top — free at [one.dash.cloudflare.com](https://one.dash.cloudflare.com)

---

## License

MIT
