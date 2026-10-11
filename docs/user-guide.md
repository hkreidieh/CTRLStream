# CTRLStream for OBS Studio: user guide

CTRLStream lets Claude set up OBS Studio for your stream and fix it when it breaks. You talk; Claude changes the settings. Everything runs on your own computer, and your stream key never goes through Claude.

## Before you start

- OBS Studio 30 or newer, on Windows or macOS. Get it from https://obsproject.com.
- Open OBS once and close it, so it has created its settings.
- You don't need to touch OBS's WebSocket settings. CTRLStream switches it on for you the first time; Claude will tell you before it closes and reopens OBS.

Claude in a web browser or on a phone cannot reach OBS on your computer, so CTRLStream only works in Claude Desktop, Cowork, Claude Code or another app running on the same computer as OBS. Pick the install that matches how you use Claude.

## Claude Desktop (Mac or Windows)

You install two things: the extension gives Claude the tools to control OBS, and the CTRLStream plugin gives it the setup and repair playbooks, because Claude Desktop chat loads a plugin's playbooks but not the plugin's own copy of the tools. You don't need Node.js for this path.

1. Download `ctrlstream-0.1.0.mcpb`.
2. Double-click it, or drag it into the Claude Desktop window. (Or: Settings > Extensions > Advanced settings > Install Extension, then pick the file.)
3. You'll see "CTRLStream" with a few settings. Leave them all as they are and click Install.
4. Add the plugin: Customize > Plugins, find CTRLStream in the directory and add it. If it isn't listed yet, use Add > Add marketplace with `https://github.com/hkreidieh/CTRLStream`.
5. Start a new chat. The first time Claude uses CTRLStream it asks for permission to use its tools; allow it.

## Cowork or Claude Code (plugin)

The plugin brings both the tools and the playbooks. This path needs Node.js 20 or newer on your computer (the "LTS" installer from https://nodejs.org).

- Cowork: Customize > Plugins > Add > Add marketplace, paste `https://github.com/hkreidieh/CTRLStream`, then install CTRLStream.
- Claude Code: type `/plugin marketplace add hkreidieh/CTRLStream`, then `/plugin install ctrlstream@ctrlstream`.

## Any other MCP app (Cursor and others)

Add this server to the app's MCP settings. This path also needs Node.js 20 or newer.

```json
{ "mcpServers": { "ctrlstream": { "command": "npx", "args": ["-y", "ctrlstream@0.1.0"] } } }
```

## What to say first

To set up:

> Set me up to stream on Twitch at the best quality my PC and connection can handle, webcam bottom right, and give me a BRB scene.

Claude checks your computer, asks two or three short questions (where you stream, what you show, whether to keep recordings, and whether it may run a 10-second upload speed test), sets everything, builds four scenes (Starting Soon, Live, BRB, Ending), shows you how it looks, and records a 30-second private test for you to watch. When it asks for your stream key, it will tell you exactly where to paste it in OBS. Don't paste the key into the chat.

When something breaks:

> Fix my OBS. My stream is stuttering since I restarted.

Claude reads OBS's stats and logs, checks your camera and mic are still there, compares everything with the "known-good" snapshot it saved after setup, then repairs or restores it and runs a short test. In Claude Code you can also type `/ctrlstream:troubleshoot`.

## What goes over the internet

Nothing, except the optional upload speed test, which sends random data to Cloudflare's speed test for about ten seconds and only runs when you say yes. Backups and snapshots stay in a `.ctrlstream` folder in your home folder.
