---
name: troubleshoot
description: Diagnose and repair OBS Studio when it breaks, using the CTRLStream server, for a streamer who is not technical. Use when someone says OBS or their stream looks, sounds or behaves wrong; it is stuttering, lagging, dropping frames, black, silent or blurry; a camera, mic or game is missing; OBS won't open, crashed or opened in Safe Mode; or something changed since the last time it worked ("since I restarted", "since the update", "I touched a setting last night").
---

# Fix a broken OBS

The user wants OBS Studio back the way it worked. Find what changed, repair it or restore the last known-good snapshot, prove it with a short test, and explain in plain words what was wrong.

Tool names below are CTRLStream server tools; your client may show them with a prefix. Bitrate and encoder decisions follow the platforms skill and the files in `${CLAUDE_PLUGIN_ROOT}/knowledge/`.

## Ground rules

- Never close OBS, restore a snapshot or change output settings while the user is live or recording. Check `stream_status` and `record_status` first. If they are live, ask whether to wait or end the stream.
- Before any step that closes OBS, say so in one sentence.
- CTRLStream backs up the current profile and scene collection before its first change in a session, so every repair is reversible. If the user worries, say "I can put that back", and only within the same conversation.
- Never ask for or repeat a stream key.
- One plain sentence per finding when you explain it. No codes, no jargon, and never name a tool to the user.
- Say only what the tool results show. State a cause only when a tool result shows it (a finding's evidence, a `snapshot_diff` entry, a log line, a stat); when it is your guess, say "probably" or "my guess is". "The bitrate was 25,000 kbps and Twitch takes 6,000" is shown; "that cost you CPU" is not, unless `stats` showed it. Describe the setup only as `input_list` and `scene_items` report it: an audio input whose scenes list is empty is heard in every scene; one listed in a scene is heard only there.
- A step marked **STOP** means: send the message, then wait for the user's reply.

## The flow

1. Call `diagnose`. It returns OBS state, stats, devices, the log summary and a list of `findings`, each with a `code`, `severity`, `evidence`, `suggestedTool` and `suggestedAction`. Call `snapshot_list` for the `known-good` label too, and note whether the newest one has `pending` items or `complete: false`.
2. If there are no findings but the user still sees a problem, ask one question about what they see (picture, sound, or connection), then use `screenshot`, `logs_tail`, `snapshot_diff` against the newest `known-good` snapshot from `snapshot_list`, and `stats` to look for it.
3. Act on findings in severity order as the server ranks them. When two have the same severity, use the order of the sections below: OBS can't run, then OBS can't be reached, then can't encode, then missing inputs, then drift, then performance, then housekeeping.
4. Decide early whether to restore instead of repairing piece by piece (see "Restore or repair").
5. After repairs, verify on the scene the user streams from, not on whatever scene is current:
   - `scene_set_current` "Live" (or the scene that holds the inputs you repaired, if there is no "Live"). Note which scene was current so you can switch back.
   - After fixing any input (camera, display, file, audio device), `screenshot` of that scene and confirm the repaired input shows. A screenshot of the source alone does not prove it appears in the scene.
   - `test_record` for 15 seconds, then `stats`. Pass when the test's skipped-frame percentage is under 1% and rendered frames skipped are under 1%.
   - `scene_set_current` back to the scene that was current before.
6. Call `diagnose` once more and confirm the findings you acted on are gone.
7. Tell the user in plain words what was wrong, what you changed, and anything they must do themselves. If the result is now good, save a new `known-good` snapshot with `snapshot_save`; if the user still has steps to do (paste a key, pick a display, allow a permission), pass them as `pending` and tell them to say "done" when finished so you can save the final one.

If a repair made things worse, call `undo_last` and tell the user you put it back.

## Restore or repair

First check the newest `known-good` snapshot. If it has `pending` items or `complete: false`, prefer repair over restore, even if the user just wants it back. That snapshot was saved before the user finished their own steps (for example before they pasted their stream key or picked their display), so restoring it would undo those steps and they would have to do them again. Tell them in one sentence, for example: "I'm fixing the settings one by one instead of restoring your saved setup, because that one was saved before you pasted your stream key and restoring it would remove the key." Restore such a snapshot only if repair fails and the user agrees to redo their steps.

Otherwise, prefer `snapshot_restore` of the newest `known-good` snapshot when any of these is true:

- The user just wants it back the way it was.
- `snapshot_diff` shows broad drift: changes in two or more of video, output, scenes and inputs, or scenes or sources removed.
- Three or more drift or missing-source findings at once (`RESOLUTION_OR_FPS_DRIFT`, `OUTPUT_DRIFT`, `SCENE_SOURCE_MISSING`).
- One round of piecemeal repair did not pass the test.
- OBS crashes in Safe Mode too (see the triage path).

Do not restore when:

- No `known-good` snapshot exists. Repair piece by piece.
- The newest `known-good` has `pending` items or `complete: false` (above).
- The only problems are a missing device or the network. A snapshot cannot bring back a camera or fix a connection.
- The user made changes since the snapshot that they want to keep (new scenes, overlays). Ask first; tell them their current setup stays in the backup.

How to restore:

1. Confirm they are not live or recording.
2. Say "I'm going to close OBS, put back your settings from <snapshot date>, and reopen it."
3. `snapshot_list` to get the newest `known-good` id, then `obs_quit`, `snapshot_restore` with that id, `obs_launch`.
4. `stream_service_get`. If the user reset their stream key on the platform since the snapshot, the restored key is the old one: **STOP** and ask them to paste the current key in OBS under Settings > Stream.
5. Verify as in the flow, step 5, on the "Live" scene.

## Findings

Each entry: what to tell the user, then what to do.

### OBS can't run

**`OBS_NOT_RUNNING`**
Tell: "OBS isn't open right now."
Do: if `PLUGIN_CRASH_SUSPECTED` is also present, or the user says OBS won't open or closes by itself, go to the safe-mode triage path. Otherwise `obs_launch` and `diagnose` again. If the launch times out, OBS is probably showing a dialog: **STOP** and ask the user what window they see (see "Crash dialog" below), then `obs_connect`.

**`PLUGIN_CRASH_SUSPECTED`**
Tell: "OBS crashed since it was last started. That's most often caused by an add-on."
Do: the safe-mode triage path.

**`SAFE_MODE_ACTIVE`**
Tell: "OBS is running in Safe Mode, which switches off add-ons and the remote control I use."
Do: if there was a crash, finish the safe-mode triage path first. Otherwise **STOP** and ask the user to click Help > "Restart in Normal Mode" in OBS, then `obs_connect` and `diagnose` again. While OBS is in Safe Mode only the file and log tools work; the websocket is off on OBS 30 to 33.

### OBS can't be reached

**`WEBSOCKET_DISABLED`**
Tell: "OBS's remote-control switch is off, so I can't talk to it."
Do: ask whether they are live or recording (you can't check without the websocket). If not: "I'll close OBS for a few seconds to switch it back on." `obs_quit`, `obs_connect` (it re-enables the websocket while OBS is closed), `obs_launch`, `diagnose`. If Safe Mode is active, handle that first; Safe Mode is the usual reason.

### OBS can't encode

**`ENCODER_UNAVAILABLE`**
Tell: "The video encoder your settings use isn't available any more. That usually happens after a graphics driver update or a graphics card change."
Do:
1. `system_info` for the GPU and driver. On OBS 32.2 and later NVIDIA needs driver 570 or newer; NVIDIA Kepler cards (GTX 600, 700) lost NVENC in OBS 31.
2. If the driver is old or broken: **STOP** and ask the user to update it from the GPU maker's site (nvidia.com, amd.com, intel.com), restart the computer, and tell you when done. Then `obs_launch` and `diagnose`.
3. If they can't or won't update now, or the card changed: pick an encoder that `obs_encoders` lists, per the platforms skill, and set it with `output_set_simple` (or `output_set_advanced` with OBS closed for Kick and TikTok). Say which one and why in one sentence.
OBS 33 also shows its own "Missing Encoders" pop-up for this; tell the user they can close it.

### Missing inputs

**`DEVICE_MISSING`**
Tell: "OBS can't find your <camera name>. It's unplugged, busy in another app, or blocked by a privacy setting."
Do:
1. **STOP.** Ask the user to check that the camera is plugged in, and to close any app that might be using it (Zoom, Teams, Discord, a browser tab with video). On Windows: Settings > Privacy & security > Camera, "Let desktop apps access your camera" on. On macOS: System Settings > Privacy & Security > Camera, OBS on, then reopen OBS.
2. `obs_devices`. If the camera is back but with a different id (Windows gives a new id when it moves to another USB port), point the input at it with `input_settings_set`.
3. If the user wants to use a different camera that is present, point the input at that one.
   A display capture on macOS is the same idea: point it at the primary display. If the tool can't set the display, the user picks it: in OBS, click the "Live" scene, double-click the screen capture source, choose their main display (on a MacBook, "Built-in Retina Display") and click OK. On macOS 15 and later, macOS may also show its own prompt about OBS recording the screen; the user has to accept it (Allow) or the capture stays black.
4. `screenshot` of the scene to confirm.

**`AUDIO_DEVICE_MISSING`**
Tell: "OBS can't find your <microphone or audio device name>."
Do: as `DEVICE_MISSING`, with Microphone instead of Camera in the privacy settings. Re-point the input with `input_settings_set`. For desktop audio, check the user's chosen speakers or headset are connected and selected in the system sound settings. Then verify as in the flow, step 5, and ask the user if they can hear themselves in the test file.

**`SCENE_SOURCE_MISSING`**
Tell: "A scene uses something that isn't there any more: a deleted source or a file that moved."
Do: for a missing file (image, video, overlay), ask where the file is now and set the new path with `input_settings_set`, or remove the input with `input_remove` if they don't need it. For a deleted source, offer to recreate it. If several are missing, restore instead.

### Drift from the known-good setup

For both, call `snapshot_diff` with the newest `known-good` id first and tell the user in one sentence what changed, in their terms ("Your stream size changed from 1080p to 1440p"). If they changed it on purpose, ask before reverting.

**`RESOLUTION_OR_FPS_DRIFT`**
Tell: "Your picture size or frame rate changed since it last worked well."
Do: `video_set` back to the snapshot's values.

**`OUTPUT_DRIFT`**
Tell: "Your stream quality settings (encoder, bitrate, preset or mode) changed since it last worked well."
Do: put back the snapshot's values with `output_set_simple`, or with `output_set_advanced` while OBS is closed if the snapshot used advanced output. Check the bitrate rule still holds.

### Connection and bitrate

**`BITRATE_ABOVE_PLATFORM_CAP`**
Tell: "Your quality setting is higher than <platform> accepts."
Do: set the video bitrate to the platform cap or lower, within the bitrate rule, with `output_set_simple` (or `output_set_advanced` with OBS closed). If `output_get` shows OBS is ignoring the platform's recommendations, that is why OBS didn't limit it; leave that box for the user to untick in Settings > Stream, and say so.

**`BITRATE_ABOVE_UPLOAD`**
Tell: "Your stream needs more upload speed than your internet has."
Do: ask consent and run `network_test` again (speeds change). Set video bitrate so video plus audio is at or under 70% of the new measurement. If that is below the range for the current resolution, step down the resolution or fps per the platforms skill, with `video_set` and `output_set_simple`.

**`NETWORK_DROPS`**
Tell: "Your connection to <platform> is dropping video, so viewers see stutters or buffering."
Do:
1. If `BITRATE_ABOVE_UPLOAD` is present, fix that first.
2. Otherwise run `network_test` with consent and apply the bitrate rule; lower the bitrate if it is above 70% of upload.
3. Tell the user the things only they can change: use a cable instead of Wi-Fi if possible, pause big uploads and downloads (cloud backup, game updates, torrents) while live.
4. Twitch: keep the server on `auto`. Check with `stream_service_get`; set it back with `stream_service_set` if it changed.
5. You can only confirm this one while live: next time they stream, `stream_status` should show congestion under 0.3 and no reconnects.
6. On OBS 32 or older with an AMD encoder and repeated disconnects, OBS 33 fixed an AMD B-frame bug that caused them; suggest updating OBS.

### Performance

**`ENCODER_OVERLOAD`**
Tell: "Your computer can't encode the video fast enough, so frames get skipped."
Do, one step at a time, testing with `test_record` (15 s) on the "Live" scene after each:
1. Hardware encoder: one preset faster (NVIDIA p6 to p5 to p4; AMD quality to balanced to speed; Intel quality to balanced to speed). x264: one preset faster, or switch to a hardware encoder if `obs_encoders` has one.
2. Lower fps from 60 to 30 (`video_set`), unless they stream fast games; then lower resolution first.
3. Lower the output resolution, 1080p to 720p, with a matching bitrate.
If `RENDER_LAG` is also present, fix that first; a maxed-out GPU makes the encoder look slow.

**`RENDER_LAG`**
Tell: "OBS can't draw the picture fast enough, usually because the game is using all of the graphics card."
Do:
1. Ask the user to cap the game's frame rate a little below what it reaches now (in the game's settings, or the NVIDIA or AMD control panel). This is the most effective fix and only they can do it.
2. Look for heavy sources with `scene_items` and `filter_list`: many browser sources or stacked filters. Offer to hide unused ones with `scene_item_visible_set`.
3. If the canvas fps is higher than they need, lower it with `video_set`.
4. On Windows, running OBS as administrator lets it claim graphics time ahead of the game; the user can try it (right-click OBS > Run as administrator).
Then verify as in the flow, step 5.

### Housekeeping

**`DISK_LOW`**
Tell: "The drive your recordings go to is almost full, so recordings may stop."
Do: ask the user to free space, or move recordings to a drive with more room with `record_set` (ask which folder). Disk space never affects the live stream itself.

**`LOG_ERRORS`**
Tell only if it matters: "OBS logged some errors; I'm checking whether they explain the problem."
Do: read the evidence and `logs_tail`. Act only on errors that match what the user sees or another finding. Many log errors are harmless. Never present raw log lines to the user unless they ask.

## Safe-mode triage path

Use this when OBS won't start, closes by itself, or `PLUGIN_CRASH_SUSPECTED` is present.

1. `logs_tail` of the newest log, the one from the session that crashed. Note the last lines and any third-party plugin names, together with the crash evidence `diagnose` gave.
2. Say: "I'll open OBS in Safe Mode. That starts it without add-ons, scripts or remote control, to see if an add-on is the problem."
3. `obs_launch` with `safeMode`. In Safe Mode the websocket is off (OBS 30 to 33), so the launch returns without a connection. That is expected; don't try to connect. `obs_status` still shows whether the process is running.
4. **STOP.** Ask: "Did OBS open and stay open for about a minute?"
5. If it stays open in Safe Mode, an add-on or script is the likely cause.
   - Name the likely add-on from the log and crash evidence, if one stands out. If none does, say so.
   - OBS 32 and later: **STOP.** Ask the user to open Tools > Plugin Manager in the Safe Mode window, untick that add-on, then click Help > "Restart in Normal Mode", and tell you what happened. If the Plugin Manager won't let them untick it in Safe Mode, use the OBS 30 and 31 route below.
   - OBS 30 and 31: there is no plugin manager. **STOP.** Ask them to uninstall or update that add-on (from Windows' Installed apps or the add-on's own uninstaller; on macOS by removing it from ~/Library/Application Support/obs-studio/plugins), then tell you when done.
   - A script: Tools > Scripts in OBS, select it, click the minus button.
   - Then `obs_quit` if OBS is still in Safe Mode, `obs_launch` normally, and `diagnose`.
6. If it crashes in Safe Mode too, an add-on isn't the cause. Likely a broken scene or source, or the graphics driver.
   - If a `known-good` snapshot exists: `obs_quit` if needed, `snapshot_restore`, `obs_launch`, `diagnose`.
   - If it still crashes, or there is no snapshot: `system_info` for the GPU and driver. **STOP.** Ask the user to update the graphics driver and restart the computer. If that doesn't help, ask them to reinstall OBS from https://obsproject.com; reinstalling keeps their settings.
7. Finish with the verification in the flow, step 5 (on the "Live" scene).

### Crash dialog

After a crash, launching OBS normally shows a dialog that blocks startup until someone clicks. `obs_launch` waits up to 30 seconds and can time out because of it.

| OBS version | Dialog title | Buttons |
|---|---|---|
| 30, 31 | "Safe Mode" | "Run in Safe Mode", "Run Normally" |
| 32 and later | "OBS Studio Crash Detected" | "Run in Safe Mode", "Run in Normal Mode" |

While triaging, the user clicks "Run in Safe Mode". After the fix, "Run Normally" or "Run in Normal Mode". Then call `obs_connect`.

## Report to the user

End with three short parts, in plain words:

1. What was wrong, as the tool results showed it. Mark anything you inferred as a guess.
2. What you changed (or restored). If they seem worried, add that you can put it back while this conversation lasts.
3. What they should do, if anything (update a driver, plug in a cable, cap a game's frame rate), and that next time they can just say "Fix my OBS".
