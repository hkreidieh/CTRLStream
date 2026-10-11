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
| Cowork or Claude Code | Add the plugin from the Claude directory, or add this repository as a plugin marketplace: `/plugin marketplace add hkreidieh/CTRLStream`, then `/plugin install ctrlstream@ctrlstream`. Claude Code installs the server package into the plugin when you install it. Needs Node.js 20 or later on your machine. |
| Cursor or any other MCP client | `npx ctrlstream`. Needs Node.js 20 or later. |

Claude in a web browser or on a phone cannot reach the OBS on your computer, so the tools only work from the desktop app, Cowork or Claude Code. The server also ships the playbooks as MCP prompts, so the extension works on its own if you skip the plugin.

Requirements: OBS Studio 30 or later. The server enables OBS's WebSocket server for you if it is off.

## Status

Pre-alpha, version 0.1.0. Under active development.

## For developers

```
pnpm install
pnpm build
pnpm test
```

The repository root is a plugin marketplace (`.claude-plugin/marketplace.json`) with one plugin, in the `plugin` folder: its manifest, the setup, troubleshoot and platforms skills, an `.mcp.json` that runs `node ${CLAUDE_PLUGIN_ROOT}/node_modules/ctrlstream/dist/index.js`, and a `package.json` plus `package-lock.json` that pin the `ctrlstream` npm package to an exact version. Claude Code installs that package with `npm ci --ignore-scripts` when someone installs the plugin. The server's source is in `src/` and is published to npm as `ctrlstream`.

Install the plugin from this repository in Claude Code:

```
/plugin marketplace add hkreidieh/CTRLStream
/plugin install ctrlstream@ctrlstream
```

To try the plugin folder from a checkout, install its package first, because `--plugin-dir` loads a plugin in place without installing anything:

```
cd plugin && npm ci --ignore-scripts && cd ..
claude --plugin-dir plugin
```


Read `CLAUDE.md` and `docs/DESIGN.md` before contributing. The design document is the spec: it lists the tools, the file locations OBS uses on each platform, the snapshot and diagnose formats, and the invariants around backups and secrets.

## License

MIT. The server talks to OBS over a socket and files, so it carries its own licence. A future native OBS plugin that links libobs will be GPL-2.0, as OBS requires.
