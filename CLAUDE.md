# CTRLStream

Product name: **CTRLStream**, slug `ctrlstream` everywhere (npm package, bin, plugin name, GitHub repo, data dir `~/.ctrlstream`). The folder is still called `better_obs` for historical reasons; that is not the product name. Never put OBS or Claude in a name field. OBS Studio goes in descriptions, keywords and the first line of the README, because the OBS Project polices OBS in product names and Anthropic's directory holds brand look-alikes.

## What this is

A local MCP server plus Claude skills that let a non-technical streamer set up OBS Studio for success and recover it when it breaks, by talking to Claude instead of hunting through settings. The engine stays OBS. We control OBS through obs-websocket v5 (built into OBS 28 and later) and, where the websocket cannot reach, through OBS's own config files on disk and the operating system.

## Read first, in this order

1. This file.
2. `README.md`: the product and install story.
3. `docs/DESIGN.md`: architecture, OBS facts we rely on, the tool catalogue, snapshot and diagnose formats, testing and packaging. It is the spec. If code and DESIGN.md disagree, stop and flag it in your report; do not silently pick one.

## The two user stories that define done

1. **Setup.** "Set me up to stream on Twitch at the best quality my PC and connection can handle, webcam bottom right, and give me a BRB scene." Ends with settings applied, scenes built, a 30-second test recording that played back fine, and a saved known-good snapshot.
2. **Recovery.** "My stream looks broken since I restarted OBS / changed something last night." Claude diagnoses from stats, logs, present devices and the diff against the last known-good snapshot, repairs or restores, and verifies with a short test.

Everything in the repo serves one of these two. If a feature serves neither, leave it out.

## Invariants. Never break these.

- **Backup before mutate.** The first mutating tool call in a session copies the active profile and scene collection to the backup directory before anything changes. Snapshots are separate, explicit, labelled.
- **Stream keys never leave the machine through us.** No tool result, log line, snapshot manifest, diff, or error message may contain a stream key, token, or password. Redact `key`, `*_key`, `token`, `password`, `server_password` wherever they appear. A tool to set the key exists for users who insist; the skill steers them to paste it into OBS instead.
- **Never write OBS config files while OBS is running.** OBS rewrites its config on exit and would clobber the write. File-writing tools check `obs_status` first and return a structured error naming `obs_quit` when OBS is up.
- **Live changes go through the websocket.** Only persistent-only settings (advanced encoder JSON, audio sample rate, hotkeys, websocket enablement) go through files, with OBS closed.
- **Redaction is name-based and aggressive.** The single redactor masks any field named `key` or ending in `Key`, `Token` or `Password`, including our own result fields. Name result fields accordingly or they will be masked.
- **Small structured results.** Tools return compact JSON. Screenshots return MCP image content, 1280 px wide at most.
- **Every tool ships with** a zod input schema, a description written for the model (when to use it, what it changes, what to check afterwards), and a unit test against the mock websocket server.
- **No telemetry, no network calls**, except the optional upload speed test, which is its own tool and says so in its description.
- **Windows and macOS are first-class.** Linux is best-effort. No hardcoded paths outside `src/obs/paths.ts`. Input kind IDs come from `GetInputKindList` at runtime, never from a hardcoded string, with a role-to-candidate-kinds table per OS.

## Stack

Node 22.18+ to build (the prompt generator runs TypeScript natively); the published server runs on Node 20+. TypeScript strict, ESM, pnpm. `@modelcontextprotocol/sdk` over stdio, `obs-websocket-js`, `zod`, `systeminformation`, `vitest`, `tsup`. Nothing else without asking in your report first.

## Layout and ownership

```
src/            the server. Owned by the server agent.
plugin/         the Claude plugin, and only the plugin: .claude-plugin/plugin.json and icon.png, skills/, .mcp.json,
                package.json + package-lock.json pinning the published `ctrlstream` package, README.md, LICENSE.
                Claude Code installs that lockfile with `npm ci --ignore-scripts` and the server runs from
                ${CLAUDE_PLUGIN_ROOT}/node_modules/ctrlstream/dist/index.js. Never put dev tooling or an npx
                launcher in here. Skills agent owns skills/, server agent owns the package files.
.claude-plugin/marketplace.json at the repo root lists the plugin with source ./plugin.
mcpb/           manifest.json for the Claude Desktop extension. Skills agent.
knowledge/      platform rules and encoder tables as data, embedded into the bundle at build time.
docs/           DESIGN.md is owned by the main session. user-guide.md by the skills agent.
test/           unit tests with the mock obs-websocket server; integration tests gated on OBS_INTEGRATION=1.
```

The repo root is not a plugin. Its `package.json` is the development package; a lockfile beside it would make Claude Code install the whole toolchain on users' machines.

Shared root files (`package.json`, `tsconfig.json`, `README.md`) are edited only by the agent whose brief says so. Stay inside your owned directories otherwise.

## Commands

```
pnpm install
pnpm build              # tsup -> dist/
pnpm test               # vitest, unit, no OBS needed
pnpm test:integration   # needs OBS running with websocket enabled; OBS_INTEGRATION=1
pnpm dev                # run the server on stdio
pnpm inspect            # MCP inspector against the built server
```

## Working rules for agents

- Read the three files above before touching anything.
- Do not commit. The main session commits.
- Do not install OBS plugins, change system settings, or write outside this repo, `~/.ctrlstream`, and scratch profiles or scene collections you created yourself under the OBS config dir for tests. Never modify a profile or scene collection you did not create.
- When you need an obs-websocket request name or field, read the protocol document linked in DESIGN.md. Do not guess.
- When you need an OBS config key name, verify it against the OBS source for the current release and against a real `basic.ini`, and record the source in `src/obs/config-keys.ts`.
- Anything uncertain goes in an `## Open questions` section of your final report, not into the code as a guess.
