# CTRLStream for OBS Studio

CTRLStream lets Claude set up OBS Studio for streaming and fix it when it breaks. Ask in plain words ("set me up to stream on Twitch with my webcam bottom right", "my stream looks broken since yesterday") and Claude checks your computer, picks settings your hardware and connection can sustain, builds your scenes, runs a short test recording, and saves a known-good snapshot it can restore later.

It runs in **Claude Code** and **Cowork** on the computer where OBS Studio is installed (macOS or Windows; Linux best effort). It does not run in a browser, because it has to reach OBS on your machine.

## Install

In Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add hkreidieh/CTRLStream
/plugin install ctrlstream@ctrlstream
```

## What's included

- Three skills: `setup` (first-time setup for Twitch, YouTube, Kick, TikTok or Facebook), `troubleshoot` (diagnose and repair), and `platforms` (bitrate, resolution and encoder rules per platform).
- A local MCP server, the `ctrlstream` npm package pinned to version 0.1.0. When you install the plugin, Claude Code installs that package into the plugin folder with `npm ci --ignore-scripts` from the lockfile, which pins the exact version and its integrity hash. The package has no dependencies of its own and runs no install scripts. The server then runs with `node` from that folder.

## What it does on your computer

Everything below is local unless it says otherwise. There is no telemetry and no account.

- **Talks to OBS on this machine** through OBS's built-in obs-websocket server at `127.0.0.1` (port 4455 by default), to read and change scenes, sources, settings and outputs.
- **Reads OBS's own files**: its profiles, scene collections, logs and crash reports, and its WebSocket settings file. That file holds the OBS WebSocket password; CTRLStream reads it solely to connect to OBS on this machine, and never sends it anywhere or shows it in a result.
- **Edits OBS's config files only while OBS is closed**, and only for settings OBS can't change live: turning on the WebSocket server, audio sample rate, advanced encoder settings, and restoring a snapshot. It backs up your profile and scene collection before its first change in a session.
- **Writes its own data under `~/.ctrlstream`**: automatic backups, the snapshots you save, and an undo log.
- **Starts and quits OBS** when you ask, using the operating system's normal app controls.
- **Reads hardware information** (CPU, memory, graphics card, displays) to choose settings. On macOS it reads display IDs through the built-in `osascript` scripting bridge.
- **Optional upload speed test**: only when you agree, it sends random bytes to `https://speed.cloudflare.com/__up` (Cloudflare) for about ten seconds to measure your upload speed. This is the only internet connection CTRLStream makes.
- **Keeps stream keys private**: stream keys, tokens and passwords are redacted from every result. CTRLStream asks you to paste your stream key into OBS yourself rather than into the chat.

## Requirements

OBS Studio 28 or later, which includes obs-websocket. Node.js 20 or later available as `node`.

## License

MIT. Source: https://github.com/hkreidieh/CTRLStream
