# termi — Your Whole Server Fleet, From Your Phone

## The Problem

You run more than one server. Maybe five, maybe fifty. And when something needs attention, you're not always at your desk — you're on your phone, on the move, away from your terminal.

SSH from a phone is painful. Juggling a separate login for every box is worse. You just want one place to see everything and jump in.

## One Dashboard For Everything

termi is a mobile-first dashboard for your entire fleet.

Every server shows up as a card — with a live status dot, the sessions running on it, and its load at a glance. Search across the whole fleet, then tap a card to drop straight into that machine.

Your own box is always there as "this server." Every other server is one SSH connection away.

## Real Terminals In The Browser

Tap a session and you get a real terminal — a full xterm attached to a live `screen` session over SSH.

There's a mobile key bar for the keys phones don't have: arrows, tab, escape, control-C, and scrollback. Drag to scroll through history. Go full-screen when you need the room. On desktop, split it into panes and watch several sessions at once.

Leave whenever you want — the session keeps running on the server.

## Talk To An Agent On Any Box

termi has a chat tab wired to a coding agent — Cursor or Claude Code — running on the server itself.

Ask it to check logs, restart a service, or ship a change. Each server keeps its own conversation, so context never gets crossed between machines.

## Health At A Glance

The analytics page watches the whole fleet.

- CPU load, memory, and disk for every server
- System uptime and how many sessions are active
- Continuous uptime tracking, so you know if a box went down — and when it came back

Green, amber, red. You see trouble before it finds you.

## Secure By Design

The hub holds the keys, so it's built to be locked down.

SSH keys and passwords are encrypted at rest. Host keys are pinned on first connect. Put it behind Cloudflare Access and the whole thing sits behind your email login over HTTPS — your servers never expose a single extra port.

## Add A Server In Seconds

Paste an IP, a user, and a key — or a password. That's it.

Nothing gets installed on the target. termi connects out over plain SSH, encrypts the credential on the hub, and the new server shows up on your dashboard, ready to open.

## One UI For Your Fleet

termi turns a pile of servers into a single, tappable dashboard you carry in your pocket.

Terminals, agents, and monitoring — for every box you own — from any browser.

Open source. Self-hosted. Yours.
