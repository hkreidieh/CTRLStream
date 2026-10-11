# CTRLStream for OBS Studio

CTRLStream sets up OBS Studio for a great stream, and fixes it when it breaks, by letting Claude take the controls.

OBS is the standard for streaming and it is free, powerful and open source. It is also hard to configure, and when something changes between streams, a driver update, a new webcam, a settings dialog you did not mean to touch, it breaks in ways that take an evening of forum reading to undo. This project gives Claude hands on your OBS so you do not have to.

## What it does

**Setup.** Tell Claude what you want: "Set me up to stream on Twitch at the best quality my PC can handle, webcam bottom right, and give me a BRB scene." Claude checks your GPU, cameras, microphones, monitors and upload speed, picks the encoder and bitrate your hardware and platform can actually sustain, applies the settings, builds the scenes, looks at the result, runs a short test recording, and saves a known-good snapshot.

**Recovery.** When OBS misbehaves, say so: "My stream is stuttering since I restarted." Claude reads OBS's stats and logs, checks that your devices are still there, compares your current configuration with the last known-good snapshot, and either repairs the difference or restores the snapshot. Then it verifies.

**Everything stays on your machine.** The server runs locally and talks to OBS over its built-in WebSocket and config files. Your stream key never passes through Claude.

## How you install it

Three ways, same server:

| You use | Install |
|---|---|
| Claude Desktop chat (Mac or Windows) | Download [ctrlstream.mcpb](https://github.com/hkreidieh/CTRLStream/releases/latest/download/ctrlstream.mcpb) and drag it into Claude Desktop's Settings > Extensions page. Node.js comes bundled, nothing else to install. Add the CTRLStream plugin from the Claude directory too, so Claude has the setup and repair playbooks. |
| Cowork or Claude Code | Add the plugin from the Claude directory, or add this repository as a plugin marketplace. Needs Node.js 20 or later on your machine. |
| Cursor or any other MCP client | `npx ctrlstream`. Needs Node.js 20 or later. |

Claude in a web browser or on a phone cannot reach the OBS on your computer, so the tools only work from the desktop app, Cowork or Claude Code. The server also ships the playbooks as MCP prompts, so the extension works on its own if you skip the plugin.

Requirements: OBS Studio 30 or later. The server enables OBS's WebSocket server for you if it is off.

## Status

Pre-alpha. Under active development. Nothing is published yet.

## For developers

```
pnpm install
pnpm build
pnpm test
```

Install the plugin straight from this repository in Claude Code:

```
/plugin install ctrlstream --marketplace hkreidieh/CTRLStream
```


Read `CLAUDE.md` and `docs/DESIGN.md` before contributing. The design document is the spec: it lists the tools, the file locations OBS uses on each platform, the snapshot and diagnose formats, and the invariants around backups and secrets.

## License

MIT. The server talks to OBS over a socket and files, so it carries its own licence. A future native OBS plugin that links libobs will be GPL-2.0, as OBS requires.
