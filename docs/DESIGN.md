# Design

Status: v0.1 spec, 2026-10-11, renamed to CTRLStream the same day. Owner: main session, approved by Hicham. Agents implement against this; disagreements get flagged, not resolved silently.

## 1. Goal and non-goals

**Goal.** A non-technical streamer can (a) set OBS up for success in one conversation and (b) hand OBS to Claude when it breaks between streams, and get it back working without touching settings themselves.

**Non-goals for v1.** A new OBS front-end. Overlay or alert generation. Multistreaming infrastructure. A hosted or remote service. Mobile. Linux parity. Hotkey binding and plugin installation (phase 2, needs a native OBS plugin).

## 2. Architecture

```
Claude (Desktop chat via .mcpb | Cowork or Claude Code via plugin | any MCP client via npx)
   │  MCP over stdio
   ▼
ctrlstream  (Node process on the streamer's machine)
   ├── obs-websocket v5 client  ─────►  OBS Studio  ws://127.0.0.1:4455   (live control, stats, screenshots)
   ├── OBS config files on disk ─────►  profiles, scene collections, logs, websocket config   (OBS closed for writes)
   ├── OS probes  ───────────────────►  GPU, CPU, RAM, displays, process list, launch/quit OBS
   └── ~/.ctrlstream/  ─────────────►  backups, snapshots, session undo log
```

Skills (Markdown, in `skills/`) carry the expertise: how to run a setup, how to read a diagnosis, platform rules. The server carries capability and safety. Keep interpretation out of the server except where it is deterministic (finding codes in `diagnose`).

## 3. OBS facts we rely on

Verify each against a real install before shipping; record where you verified it.

### 3.1 Config directory

| OS | Path |
|---|---|
| Windows | `%APPDATA%\obs-studio` |
| macOS | `~/Library/Application Support/obs-studio` |
| Linux | `~/.config/obs-studio`; Flatpak `~/.var/app/com.obsproject.Studio/config/obs-studio`; Snap `~/snap/obs-studio/current/.config/obs-studio` |

Portable mode on Windows keeps config in `<OBS install>/config/obs-studio`. The marker file (`portable_mode`, `portable_mode.txt`, or `obs_portable_mode*`) sits in the install root, two folders above `obs64.exe`. `global.ini` `[Locations]` can relocate profiles and scene collections; honour it.

### 3.2 Files inside it

| File | Holds | Read while running | Write while running |
|---|---|---|---|
| `global.ini`, and `user.ini` on OBS 31+ | `[Basic] Profile`, `ProfileDir`, `SceneCollection`, `SceneCollectionFile` live in `user.ini` on 31+ and in `global.ini` before; read both | yes | no |
| `basic/profiles/<ProfileDir>/basic.ini` | video, audio, simple and advanced output settings, hotkey bindings for profile-level actions | yes | no |
| `basic/profiles/<ProfileDir>/service.json` | stream service type, server, **key** | yes, redact | no |
| `basic/profiles/<ProfileDir>/streamEncoder.json`, `recordEncoder.json` | advanced-mode encoder settings | yes | no |
| `basic/scenes/<SceneCollectionFile>.json` and `.json.bak` | scenes, sources, scene items, filters, per-source hotkeys | yes | no |
| `plugin_config/obs-websocket/config.json` | `server_enabled`, `server_port`, `server_password`, `auth_required`, `alerts_enabled` | yes | only when OBS closed |
| `logs/*.txt` | startup log with loaded modules, **Available Encoders**, device init, errors | yes | never |
| `crashes/*.txt` on Windows; `~/Library/Logs/DiagnosticReports/OBS*.ips` on macOS | crash reports with timestamps | yes | never |
| `.sentinel/run_<uuid>` | present while OBS runs; left behind after an unclean shutdown, which the next log reports as "Crash or unclean shutdown detected" | yes | never |

`basic.ini` keys (verify names against the OBS source for the current release and against a real file; record in `src/obs/config-keys.ts`):

- `[Output] Mode` = `Simple` | `Advanced`
- `[SimpleOutput]` `VBitrate`, `ABitrate`, `StreamEncoder`, `Preset`, `NVENCPreset2`, `StreamAudioEncoder`, `RecQuality`, `RecFormat2`, `RecEncoder`, `FilePath`, `FileNameWithoutSpace`
- `[Video]` `BaseCX`, `BaseCY`, `OutputCX`, `OutputCY`, `FPSType` (0 common, 1 integer, 2 fraction), `FPSCommon`, `FPSInt`, `FPSNum`, `FPSDen`, `ScaleType`
- `[Audio]` `SampleRate`, `ChannelSetup`
- `[AdvOut]` `Encoder`, `RecEncoder`, `RecType`, `RecFilePath`, `RecFormat2`, `RecTracks`, `TrackIndex`, `Track1Bitrate`, `ApplyServiceSettings`

Simple-mode encoder identifiers as stored in `StreamEncoder`, verified against the 30.2 and 32.2 source: `x264`, `x264_lowcpu` (recording only), `nvenc`, `nvenc_hevc`, `nvenc_av1`, `amd`, `amd_hevc`, `amd_av1`, `qsv`, `qsv_av1`, `apple_h264`, `apple_hevc`. There is no `qsv_hevc` in Simple mode; Intel HEVC is Advanced-only. Apple encoders appear only on Apple Silicon with macOS 13+. The libobs encoder IDs in the log differ and changed in OBS 31: `jim_nvenc` on 30, `obs_nvenc_h264_tex`, `obs_nvenc_hevc_tex`, `obs_nvenc_av1_tex` on 31+. `knowledge/encoders.json` is the single mapping table; the server reads it and a test fails if its fallback drifts.

Profiles and scene collections are found by the name inside the file (`[General] Name` in `basic.ini`, `name` in the collection JSON), never by folder or file name: OBS stores `ctrlstream-test` as `ctrlstreamtest/`.

### 3.3 Websocket behaviour

- Built into OBS since 28. Default port 4455. If `server_enabled` is false we enable it by editing `plugin_config/obs-websocket/config.json` with OBS closed, generating a strong password, and storing nothing elsewhere. Zero-config connect: read host, port and password from that file at every connect.
- `SetProfileParameter` writes `basic.ini` live. Verified on OBS 32.2.2: bitrates, presets, `UseAdvanced`, `x264Settings`, `FilePath`, `FileNameWithoutSpace`, `MuxerCustom`, `RecTracks` and replay-buffer size apply on the next stream or recording start. `StreamEncoder`, `RecFormat2`, `StreamAudioEncoder`, `RecEncoder`, `RecAudioEncoder`, `RecQuality`, `RecRB` and `[Output] Mode` need an outputs reset (restart, profile switch, or OK in Settings). `[Audio]` needs a full restart. `output_set_simple` and `record_set` report `appliesOn: next_start | restart` per change.
- Unless `[Stream1] IgnoreRecommended` is true, OBS silently caps the encoder bitrate at the service maximum from its own `services.json`. Report the effective bitrate, not `VBitrate`.
- Simple mode with the `rtmp_custom` service sets no keyframe interval; x264 falls back to 250 frames. Kick and TikTok therefore use `output_set_advanced` with a 2 s keyframe interval.
- Safe Mode disables obs-websocket on OBS 30 to 33. Detect it from the log line `Safe Mode enabled.`; `obs_launch` with `safeMode` returns at once instead of waiting for a socket. `obs_launch` also offers `onlyBundledPlugins`, which uses `--only-bundled-plugins` and keeps the websocket; unverified on OBS 33, pending Hicham's decision.
- At startup OBS silently rewrites an unavailable Simple-mode `StreamEncoder` to `x264` and saves it (`CheckForSimpleModeX264Fallback`), so an encoder that no longer exists is visible only from files while OBS is closed. Every closed-state read of the profile records the encoders to the session and to `~/.ctrlstream/closed-state.json`; after a launch ENCODER_UNAVAILABLE says "was nvenc on disk while OBS was closed; OBS replaced it with x264 when it started". Setting the encoder in the session clears the record.
- Changing the canvas size rescales every item of the loaded scene collection. Tests and tools that switch profiles must switch the scene collection first on the way in and the profile first on the way out.
- macOS displays are never enumerated through OBS: ScreenCaptureKit's display list begins with a NULL placeholder (`plugins/mac-capture/mac-sck-common.m`) and obs-websocket 5.7.4 crashes on it regardless of permission (reproduced twice on 32.2.2). Display UUIDs and labels come from macOS itself via `osascript -l JavaScript` (CoreGraphics), which returns exactly the `display_uuid` OBS stores. `input_create` for the display role picks the display matching OBS's primary monitor, else the macOS main display, else the first, and says which. Fallback is OBS's monitor list with a note.
- A macOS `screen_capture` source stays black until its scene has been program-live once, and keeps its picture afterwards. `screenshot` adds a note only when the capture is not active now, has not been seen live in this session with this OBS process, and a 160 px probe of the capture alone is effectively black (under 1,100 bytes of JPEG at quality 70; calibration in `src/tools/layout.ts`). The setup flow keeps Live current through the test recording.
- OBS lists the newest created scene at the top, so the setup flow creates scenes in reverse show order.
- Right after connecting, OBS answers 207 (not ready) for a few seconds while it loads the collection. The client retries 207 for up to 8 s.
- macOS: never call `GetInputPropertiesListPropertyItems` on `screen_capture` or `sck_audio_capture`; it crashes OBS inside obs-websocket 5.7.4 (see the display bullet below for why and for the replacement).
- Settings changes made over the websocket can sit unwritten on disk for over 12 s; new scenes land in about 250 ms. Creating and removing the scratch scene forces a full write. `snapshot_save` and the session backup do that and wait up to 5 s for the file to settle.
- Advanced-mode encoder settings load from the JSON files when outputs reset. Treat as file-write-with-OBS-closed.
- Screenshots: `GetSourceScreenshot` with `imageFormat` from `GetVersion.supportedImageFormats`, `imageWidth` 1280 max, JPEG quality 70. Return as MCP image content.
- Device enumeration: create or reuse an input of the right kind, then `GetInputPropertiesListPropertyItems` on its device list property (for example `video_device_id`, `device_id`). Enumeration must not leave a stray input behind: use a hidden scratch scene named `__ctrlstream_scratch` and remove it afterwards.
- Input kinds differ per OS. Query `GetInputKindList` at runtime and resolve roles through this candidate table, first match wins:

| Role | Windows | macOS | Linux |
|---|---|---|---|
| camera | `dshow_input` | `macos-avcapture`, `av_capture_input` | `v4l2_input` |
| microphone | `wasapi_input_capture` | `coreaudio_input_capture` | `pulse_input_capture`, `pipewire_audio_input_capture` |
| desktop audio | `wasapi_output_capture` | `sck_audio_capture`, `coreaudio_output_capture` | `pulse_output_capture` |
| display | `monitor_capture` | `screen_capture`, `display_capture` | `pipewire-desktop-capture-source`, `xshm_input` |
| window | `window_capture` | `screen_capture`, `window_capture` | `pipewire-window-capture-source`, `xcomposite_input` |
| game | `game_capture` | none | none |
| browser | `browser_source` | same | same |
| media file | `ffmpeg_source` | same | same |
| image | `image_source` | same | same |
| text | `text_gdiplus_v3`, `text_gdiplus_v2` | `text_ft2_source_v2` | `text_ft2_source_v2` |
| colour | `color_source_v3` | same | same |

### 3.4 What the websocket cannot do, and what we do instead

| Need | Websocket | v1 approach |
|---|---|---|
| Read logs | no | read `logs/` directly |
| Available encoders | no | parse `Available Encoders` from the newest log; cross-check GPU vendor from probes |
| Advanced encoder settings | no | edit JSON with OBS closed |
| Audio sample rate, channels | no | `SetProfileParameter` then restart OBS |
| Quit OBS | no | OS-level graceful quit (`osascript` on macOS, `taskkill` without `/F` then wait on Windows, `SIGTERM` on Linux) |
| Launch OBS | no | OS-level launch; detect binary per OS; support `--safe-mode`, `--collection`, `--profile` flags |
| Bind hotkeys | no | phase 2, native plugin |
| Install plugins | no | phase 2 |
| Import scene collection | no | write the JSON with OBS closed, then launch with `--collection` |

## 4. Tool catalogue

Naming: `snake_case`, noun first. Every tool returns `{ ok: true, ...data }` or `{ ok: false, error: { code, message, hint, suggestedTool? } }`. Mutating tools are marked **M** and trigger the session backup on first use. File tools are marked **F** and refuse while OBS runs.

### Session

- `obs_status` — running?, pid, version, websocket enabled and reachable, current profile and collection, config dir, platform, last start time, newest crash newer than last start?
- `obs_connect` — connect or reconnect; enables websocket config if OBS is closed and it is off (**F** in that branch).
- `obs_launch` — `{ safeMode?, profile?, collection? }`. Waits for websocket up to 30 s.
- `obs_quit` — graceful; waits for exit; returns whether it had to escalate.

### Probes

- `system_info` — OS, CPU, RAM, GPUs with vendor and driver where available, displays from `GetMonitorList` when connected, else OS.
- `obs_encoders` — video and audio encoder IDs from the newest log, with a hint per family (`nvenc`, `amf`, `qsv`, `videotoolbox`, `x264`, `av1`).
- `obs_devices` — cameras, microphones, speakers, displays, with ids and names, via the scratch-scene enumeration above. **M** transiently, but cleans up and does not count as a session mutation.
- `network_test` — optional. Posts random bytes to `https://speed.cloudflare.com/__up` for about 10 seconds and reports sustained upload Mbps. The description says exactly this so the skill can ask consent.

### Scenes and inputs

- `scene_list`, `scene_create` **M**, `scene_remove` **M**, `scene_set_current` **M**
- `input_kinds` — resolved role table for this machine
- `input_list` — with kind, scenes it appears in, audio state
- `input_create` **M** — `{ role | kind, name, scene, settings?, deviceId? }`
- `input_remove` **M**
- `input_settings_get`, `input_settings_set` **M**
- `input_properties` — property schema with list options, so Claude can see valid values
- `input_audio_set` **M** — volume dB, mute, monitoring type, sync offset

### Layout and look

- `scene_items` — items with transforms, bounds, visibility, lock
- `scene_item_transform_set` **M** — position, scale, bounds type and size, crop, alignment; accepts named anchors (`bottom-right`, `center`) with a margin
- `scene_item_visible_set` **M**, `scene_item_order_set` **M**
- `filter_list`, `filter_add` **M**, `filter_set` **M**, `filter_remove` **M**
- `screenshot` — `{ source?: scene or input name, width? }` returns image content plus the canvas size

### Settings

- `video_get`, `video_set` **M** — base and output resolution, fps
- `output_get` — mode, encoder, bitrate, preset, rate control, audio bitrate, record format and path, keyed by simple or advanced
- `output_set_simple` **M** — via `SetProfileParameter`; reports which changes take effect on next start
- `output_set_advanced` **M F** — writes encoder JSON
- `record_set` **M** — path, format, quality or encoder; path via `SetRecordDirectory`
- `audio_set` **M F** — sample rate, channels; requires restart; tool says so
- `stream_service_get` — type, service name, server; key redacted to `"<set>"` or `"<empty>"`
- `stream_service_set` **M** — `{ type, service?, server?, key? }`; description warns that passing `key` sends it through the conversation and recommends pasting it in OBS

### Outputs

- `stream_start` **M**, `stream_stop` **M**, `stream_status` — active, reconnecting, congestion 0..1, skipped and total frames, bytes, duration
- `record_start` **M**, `record_stop` **M**, `record_status`
- `replay_buffer_set` **M**, `virtual_camera_set` **M**
- `test_record` **M** — records for N seconds (default 30), stops, returns path, size, stats delta, and skipped-frame percentage during the test

### Snapshots and undo

- `snapshot_save` **F for a full copy**; when OBS is running it still works by copying files read-only (reads are safe) and tagging `takenWhileRunning: true`. `{ label, note?, pending? }` where `pending` lists steps the user still has to do (paste the stream key, pick a display); the manifest records `complete: false` until a later `known-good` save without pending. The troubleshoot skill prefers repair over restore while the newest known-good is incomplete.
- `snapshot_list`
- `snapshot_diff` — `{ snapshotId }` structured diff: video, output, audio, stream service (no key), scenes added or removed, inputs added or removed or changed settings, devices the snapshot's inputs used then vs now (`missingNow`), other vanished devices separately (`otherMissingNow`), encoders then vs now, plus `snapshotPending` and `snapshotComplete`
- `snapshot_restore` **M F** — restores profile dir and scene collection file; then suggests `obs_launch`
- `backup_list`, `undo_last` **M** — replays the inverse of the last websocket mutation from the session undo log; for file mutations requires OBS closed

### Diagnosis

- `diagnose` — one call that gathers everything and returns the report in section 6
- `logs_tail` — `{ lines?, file? }` plus extracted errors and warnings
- `stats` — `GetStats` plus stream and record status

### Orientation and knowledge

- `get_started` — short orientation and the list of prompts; can return a playbook's full text for clients that do not show MCP prompts
- `knowledge` — returns `knowledge/platforms.json` or `knowledge/encoders.json`, because a Claude Desktop model cannot read plugin files
- `filter_kinds` — the filter kind ids this OBS offers
- MCP prompts `setup`, `troubleshoot`, `platforms`, generated at build time from `skills/*/SKILL.md` by `scripts/gen-prompts.ts`; the skills are the single source of truth
- `input_create` takes `addExistingToScene` so one webcam input can sit in several scenes

## 5. Snapshot format

```
~/.ctrlstream/
  backups/<sessionId>/            automatic, pre-mutation copy; pruned to the last 10 sessions
  snapshots/<ISO8601>-<label>/
    manifest.json                 see below, no secrets
    profile/                      byte-exact copy of the profile dir, including service.json
    scenes/<collection>.json
  undo/<sessionId>.jsonl          one line per websocket mutation: tool, before, after
```

Directory mode 700. `manifest.json`:

```json
{
  "id": "2026-10-11T20-15-03Z-known-good",
  "label": "known-good",
  "note": "after first Twitch setup, test recording clean",
  "createdAt": "2026-10-11T20:15:03Z",
  "takenWhileRunning": false,
  "obsVersion": "32.2.2",
  "platform": "win32",
  "profile": "Untitled",
  "sceneCollection": "Streaming",
  "video": { "baseWidth": 2560, "baseHeight": 1440, "outputWidth": 1920, "outputHeight": 1080, "fpsNumerator": 60, "fpsDenominator": 1 },
  "output": { "mode": "Simple", "encoder": "nvenc", "videoBitrateKbps": 6000, "audioBitrateKbps": 160, "recFormat": "hybrid_mp4" },
  "streamService": { "type": "rtmp_common", "service": "Twitch", "server": "auto", "key": "<set>" },
  "encoders": ["jim_nvenc", "jim_hevc_nvenc", "obs_x264"],
  "devices": { "cameras": [{ "id": "...", "name": "Elgato Facecam" }], "microphones": [], "speakers": [], "displays": [] },
  "scenes": ["Starting Soon", "Live", "BRB", "Ending"],
  "inputs": [{ "name": "Webcam", "kind": "dshow_input", "scenes": ["Live"] }]
}
```

The label `known-good` is special: the troubleshoot skill compares against the newest snapshot with that label.

`snapshot_save` only reads OBS files and writes under `~/.ctrlstream`, so it works while OBS runs and tags `takenWhileRunning: true` after forcing OBS to flush. `obs_quit` refuses while streaming or recording unless `force` is set. Undo never restores an old stream key and does not restore filters on inputs that were deleted. The undo log on disk is redacted, so exact undo works within one server session only.

## 6. Diagnose report

```json
{
  "obs": { "running": true, "version": "32.2.2", "uptimeSeconds": 412, "safeMode": false, "crashSinceLastStart": false },
  "connection": { "ok": true },
  "stats": { "cpuUsage": 12.1, "memoryMb": 640, "activeFps": 60, "averageFrameRenderTimeMs": 1.2, "renderSkipped": 0, "renderTotal": 24000, "outputSkipped": 310, "outputTotal": 24000, "diskFreeMb": 120000 },
  "stream": { "active": true, "reconnecting": false, "congestion": 0.4, "skipped": 310, "total": 24000, "durationSeconds": 400 },
  "record": { "active": false },
  "video": {}, "output": {}, "audio": {},
  "devices": { "present": {}, "missingVsSnapshot": ["Elgato Facecam"] , "snapshotId": "..." },
  "log": { "file": "...", "encoders": [], "errors": [], "warnings": [] },
  "findings": [
    { "code": "DEVICE_MISSING", "severity": "high", "evidence": "Input 'Webcam' references device id ... which is not present; snapshot known-good had it", "suggestedTool": "input_settings_set", "suggestedAction": "Point 'Webcam' at the camera that is present, or ask the user to reconnect the Elgato" }
  ]
}
```

Finding codes, deterministic rules only. Interpretation beyond these belongs to the skill.

| Code | Rule |
|---|---|
| `OBS_NOT_RUNNING` | process absent |
| `WEBSOCKET_DISABLED` | config says disabled or port closed while OBS runs |
| `SAFE_MODE_ACTIVE` | OBS reports or log shows safe mode |
| `PLUGIN_CRASH_SUSPECTED` | crash report newer than last start, or the current log says "Crash or unclean shutdown detected" |
| `ENCODER_OVERLOAD` | log contains encoder overloaded, or `outputSkipped / outputTotal` > 2% with low congestion |
| `NETWORK_DROPS` | `congestion` > 0.3 or reconnecting, or dropped frames with high congestion |
| `RENDER_LAG` | `renderSkipped / renderTotal` > 1% |
| `DEVICE_MISSING` | an input's selected device appears as a disabled entry in that input's own device list, which is how OBS marks a device that is gone; on macOS a display capture whose UUID macOS no longer reports counts too |
| `AUDIO_DEVICE_MISSING` | same for microphone or desktop audio |
| `ENCODER_UNAVAILABLE` | configured encoder family not in log encoders; advice says "never available on this machine" when no kept log ever listed the family (always for NVENC, AMD and Intel on macOS) and "driver probably changed" when an older log did, and names the best available encoder from `knowledge/encoders.json` for the configured platform |
| `RESOLUTION_OR_FPS_DRIFT` | video differs from known-good snapshot |
| `OUTPUT_DRIFT` | encoder, bitrate, preset, or mode differs from known-good |
| `BITRATE_ABOVE_PLATFORM_CAP` | effective bitrate exceeds the cap for the configured service, from `knowledge/platforms.json` |
| `BITRATE_ABOVE_UPLOAD` | video plus audio bitrate > 70% of the last measured upload |
| `DISK_LOW` | free disk < 5 GB with recording configured |
| `SCENE_SOURCE_MISSING` | scene item references an input that no longer exists, or a file source whose file is gone |
| `LOG_ERRORS` | `error` lines from the current OBS run, each with its log timestamp; errors about an input this session changed after that timestamp move to `log.errorsAlreadyAddressed`; evidence lists the first five |

## 7. Flows the skills implement

**Setup.** `obs_status` → connect or launch → `system_info`, `obs_encoders`, `obs_devices`, optional `network_test` → ask platform, purpose (game, camera, desktop, mixed), record too? → choose canvas, output, fps, encoder, bitrate from `knowledge/` → `video_set`, `output_set_simple`, `record_set` → `stream_service_set` type and server only, user pastes key in OBS → scenes `Starting Soon`, `Live`, `BRB`, `Ending` with inputs by role → `screenshot`, adjust with `scene_item_transform_set` until right → `test_record` 30 s → `stats` check → `snapshot_save` label `known-good` → tell the user exactly what was set and what to do next time.

**Recovery.** `diagnose` → if `OBS_NOT_RUNNING` and crash suspected, `obs_launch` with `safeMode` to triage → act on findings in severity order using the suggested tools → if drift against known-good is broad or the user just wants it back, `obs_quit`, `snapshot_restore`, `obs_launch` → `test_record` 15 s → `stats` → report in plain words what was wrong and what changed.

## 8. Testing

- `test/mock/obs-ws-server.ts`: an obs-websocket v5 server over `ws`. Hello (op 0, with optional auth challenge and salt), Identify (op 1, validate the sha256 base64 chain), Identified (op 2), Request (op 6) and RequestResponse (op 7), Events (op 5). Backed by an in-memory OBS model: scenes, inputs with settings and property lists, scene items with transforms, video settings, profile parameters, stream and record state, a fake screenshot. Every tool gets unit tests against it, including failure paths and redaction.
- `test/fixtures/`: real `basic.ini`, `service.json` with a dummy key, a scene collection, two OBS logs (one clean, one with encoder overload and a missing device), a crash log. Collected from a real install.
- Integration (`OBS_INTEGRATION=1`): against a real OBS on this machine. Create a profile `ctrlstream-test` and a collection `ctrlstream-test`; never touch others; clean up.
- Redaction test: grep every tool's output in the suite for the dummy key; fail if found.

## 9. Packaging

- npm: package `ctrlstream`, bin `ctrlstream`, single-file ESM bundle from tsup, `engines.node >= 20` because Claude Desktop ships its own Node.
- `.mcpb`: `mcpb/manifest.json`, node server, `user_config` for `snapshots_dir` (default `~/.ctrlstream`), `obs_host`, `obs_port`, `obs_password` (sensitive, optional override). Built with `mcpb pack`, validated with `mcpb validate`.
- `knowledge/*.json` at the repo root is the single source: embedded in the bundle at build time, and copied to `plugin/knowledge/` by `scripts/sync-plugin-knowledge.ts` before every build so the skills can read it in Claude Code and Cowork; a test fails if the copies drift. `CTRLSTREAM_KNOWLEDGE_DIR` overrides it for development.
- Plugin: the `plugin/` subfolder. `plugin/.claude-plugin/plugin.json` with `icon.png`, `plugin/skills/`, `plugin/.mcp.json` running `node ${CLAUDE_PLUGIN_ROOT}/node_modules/ctrlstream/dist/index.js`, and `plugin/package.json` + `plugin/package-lock.json` whose only dependency is the published `ctrlstream` at an exact version. Claude Code installs that lockfile with `npm ci --ignore-scripts` (registry packages, exact versions, integrity hashes, 60 s limit), which is what Anthropic's directory requires for the Verified badge; an `npx` launcher is held for review and cannot be verified. The root `.claude-plugin/marketplace.json` points at `./plugin`. Validate with `claude plugin validate plugin`. Each release therefore has two steps: publish `ctrlstream@x.y.z` to npm, then bump `plugin/package.json`, regenerate the lockfile and bump the plugin version.
- Directory review notes: the server reads OBS's WebSocket password from OBS's own config file to connect on localhost; the plugin README discloses this, and we do not route it through `user_config` because Cowork ignores a server whose config references an option without a default.

## 10. Decisions

Decided 2026-10-11: name is CTRLStream, slug `ctrlstream`; tagline "CTRLStream for OBS Studio"; OBS appears in descriptions, keywords and README, never in a name field.

Open for Hicham:

0. Whether `snapshot_restore` should keep the stream key OBS currently has instead of the one in the snapshot (proposed after QA: a restore after setup would otherwise wipe a key the user pasted later).
1. Whether to auto-snapshot after every clean stream, which needs a tiny always-on component (phase 2).
2. Remote bridge for web and mobile (phase 2).
