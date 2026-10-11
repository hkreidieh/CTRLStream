---
name: setup
description: Set up OBS Studio for streaming in one conversation with the CTRLStream server, for a streamer who is not technical. Use when someone asks to set up, configure or optimise OBS for Twitch, YouTube, Kick, TikTok or Facebook; wants the best quality their PC and internet can handle; wants scenes such as Starting Soon, BRB or Ending, or a webcam in a corner; or is opening OBS for the first time.
---

# Set up OBS for a streamer

You are setting up OBS Studio for someone who should never have to open a settings dialog. Do the work with CTRLStream's tools, explain each decision in one plain sentence, and stop only where the user must act.

The facts you decide from are in `${CLAUDE_PLUGIN_ROOT}/knowledge/platforms.json` and `${CLAUDE_PLUGIN_ROOT}/knowledge/encoders.json`. The platforms skill explains how to read them and holds the bitrate rule. Load it when you reach step 4.

Tool names below are CTRLStream server tools; your client may show them with a prefix.

## Ground rules

- Never ask for the stream key, and never put one in `stream_service_set`. Tell the user where to paste it in OBS. If they paste a key into the chat anyway, do not repeat it, do not use it, and tell them to paste it into OBS instead and consider resetting it on the platform.
- Ask the fewest questions. Never ask what a probe can tell you. Never ask a technical question ("which encoder?"). Ask everything you need in one message.
- One plain sentence per decision, in the user's terms: what you set and why it is good for them. No jargon without a reason.
- Say only what the tool results show. State a cause only when a tool result shows it; when it is your guess, say "probably" or "my guess is". Describe the setup only as `input_list` and `scene_items` report it: an audio input whose scenes list is empty is a global device heard in every scene; an input listed in one scene is heard only there.
- Never name a tool to the user. CTRLStream backs up the profile and scene collection automatically before the first change; if the user worries about a change, say "I can put that back", and only within the same conversation.
- You do not need to ask permission for each setting, but say what you are about to do before a step that closes OBS.
- Never close OBS while it is streaming or recording. Check `stream_status` and `record_status` first.
- A step marked **STOP** means: send the message, then wait for the user's reply before calling any more tools. If the user has said they can't reply or will do a step later, carry on and add that step to the pending list (step 10).

## Step 1. Connect to OBS

1. Call `obs_status`.
2. OBS not installed: **STOP.** Ask the user to install OBS Studio 30 or newer from https://obsproject.com and tell you when it's done.
3. Version older than 30: **STOP.** Ask them to update OBS from https://obsproject.com, then tell you when it's done.
4. OBS not running: call `obs_launch`.
   - If OBS shows a crash dialog on launch ("Safe Mode" on OBS 30 and 31, "OBS Studio Crash Detected" on 32 and later), **STOP**: ask the user to click "Run Normally" (30, 31) or "Run in Normal Mode" (32+), then call `obs_connect`. If OBS keeps crashing, switch to the troubleshoot skill.
5. OBS running but the websocket is off or unreachable: say "I need to close OBS for a few seconds to switch on its remote control." Check `stream_status` is not live if you can, then `obs_quit`, `obs_connect` (it switches the websocket on while OBS is closed), `obs_launch`.
6. OBS is in Safe Mode: the websocket is off in Safe Mode. Ask the user to click Help > "Restart in Normal Mode" in OBS, then call `obs_connect`.

## Step 2. Look at the machine

Call `system_info`, `obs_encoders` and `obs_devices`. They do not change anything the user can see.

From them note: the operating system, the GPU and its generation, the CPU core count, the encoders OBS can use, the cameras, microphones and displays.

## Step 3. Ask once

Send one message with only the questions the user has not already answered:

1. Where will you stream? (Twitch, YouTube, Kick, TikTok, Facebook)
2. What will you mostly show? (a game, just your camera, your screen, or a mix)
3. Do you also want to keep a recording of your streams on this computer?
4. Can I run a 10-second upload speed test? It sends random data to Cloudflare's speed test; nothing personal leaves your computer.
5. Only if `obs_devices` lists more than one real microphone (ignore "Default"): which one do you talk into? List them by name.
6. Only if it lists more than one camera: which camera should I use? List them by name.

**STOP.** Wait for the answers. Do not ask where the webcam goes; put it bottom right unless they asked for something else.

If they agreed to the speed test, call `network_test`.

## Step 4. Decide

Load the platforms skill and apply it. Decide all of this before changing anything, in this order:

1. **Frame rate, first.** 30 fps, unless the content is a game or the user asks for 60. Screen, camera, or screen plus webcam without a game is 30. "Best quality" is not a request for 60.
2. **Canvas (base) size.** Match the primary display, the way OBS's own setup wizard does, so game and display capture land at their real size. Only the output is scaled.
   - Take the primary display's resolution in physical pixels from `system_info` or `obs_devices`. On a Retina Mac that is the panel's pixel size (OBS uses screen size times the pixel ratio), not the smaller "looks like" size.
   - If the display is 16:9, the canvas is its resolution. If it is another shape (16:10, a MacBook, an ultrawide), use the largest 16:9 size that fits inside it, so the stream stays 16:9 as the platforms expect; for example 2560x1600 or 2560x1664 gives 2560x1440, 3440x1440 gives 2560x1440, 1920x1200 gives 1920x1080.
   - Cap the canvas at 2560x1440 unless the user asked for 4K; a 3840x2160 display then gives a 2560x1440 canvas.
   - TikTok is the exception: its stream is vertical, so the canvas is 1080x1920 whatever the display is.
3. **Output (scaled) size.** Pick the target with the bitrate rule at the frame rate from item 1, then set the output to it:
   - Start at 1920x1080.
   - YouTube with an HEVC or AV1 encoder and plenty of upload: 2560x1440 if the user asked for higher quality, and 3840x2160 only if they asked for 4K and the canvas is 4K; otherwise 1080p.
   - TikTok: 1080x1920. TikTok's own page suggests 25 fps; 30 is a safe choice and OBS's default.
   - Facebook: 16:9 only, 1920x1080 at most.
   - Never set the output larger than the canvas. On a small display (for example 1366x768) the output is 1280x720.
   - Step down per the platforms skill when the allowed bitrate is too low.
4. **Encoder and preset.** Per "Choose the encoder" in the platforms skill.
5. **Video bitrate.** Per the bitrate rule: under 70% of upload together with audio, and under the platform cap.
6. **Audio bitrate.** The platform's recommended figure.
7. **Output mode.** Simple for Twitch, YouTube and Facebook. Advanced for Kick and TikTok, so the keyframe interval can be set to 2 seconds.
8. **Recording.**
   - User does not want recordings: recording quality "Same as stream" (`RecQuality` `Stream`). The 30-second test then exercises exactly the encoder and bitrate the stream will use.
   - User wants recordings: quality `HQ` with the same hardware family as the stream, H.264 for the widest playback (`recording.simpleMode` in `encoders.json`). Offer HEVC or AV1 only if they ask for smaller files.
   - Format: `hybrid_mp4` on OBS 30.2 and later; `mkv` on 30.0 and 30.1.
   - Keep OBS's existing recording folder unless it is missing or on a nearly full drive.

## Step 5. Apply the settings

Tell the user in one short paragraph what you are about to set, then do it:

1. `video_set`: base (canvas) resolution from the display, output resolution from the target, fps.
2. Twitch, YouTube, Facebook: `output_set_simple` with the stream encoder, video bitrate, audio bitrate and the encoder's preset key. The tool reports which changes apply at the next stream or recording start; that is normal.
3. Kick, TikTok: say "OBS will close and reopen once, about ten seconds, so I can set the keyframe timing Kick needs." Then `obs_quit`, `output_set_advanced` (encoder, CBR, video bitrate, keyframe interval 2 s, preset from `families.<vendor>.streaming.advancedMode`, audio bitrate), `obs_launch`.
4. `record_set`: recording quality or encoder, and format.
5. `stream_service_set` with `type` and `service` and `server` from `platforms.<id>.obs`. Never pass `key`.
   - Twitch: `rtmp_common`, "Twitch", server `auto`.
   - YouTube: `rtmp_common`, "YouTube - RTMPS", server `rtmps://a.rtmps.youtube.com:443/live2`.
   - Facebook: `rtmp_common`, "Facebook Live", server `rtmps://rtmp-api.facebook.com:443/rtmp/`.
   - Kick, TikTok: `rtmp_custom` only; the user pastes the server URL and key from the platform in the next step.

Then explain each decision in one sentence each, for example:

- "Your stream runs at 30 frames per second, which is plenty for a screen and webcam and leaves more of the bitrate for a sharp picture."
- "Your stream runs at 60 frames per second, which keeps fast games smooth."
- "Your canvas matches your 1440p screen and OBS shrinks the picture to 1080p for the stream, so your screen is captured sharp."
- "I'm using your graphics card's built-in encoder, so your game keeps the processor to itself."
- "Your bitrate is 6,000 kbps, the most Twitch accepts, and well inside your 12 Mbps upload."
- "Recordings use the same settings as the stream, so the test we run in a minute shows exactly how your stream will behave."

## Step 6. The stream key

**STOP.** Give the user `platforms.<id>.streamKeyInstructions` word for word, for example for Twitch:

> In OBS, open Settings > Stream. The service is already set to Twitch. Either click "Connect Account", or copy your Primary Stream Key from dashboard.twitch.tv > Settings > Stream and paste it into "Stream Key". Click Apply, then tell me when it's done. Don't paste the key here.

For TikTok, add that TikTok may give them a new server and key each time they go live, so they repeat this before each TikTok stream.

When they reply, call `stream_service_get`. The key must show as `"<set>"`. For Kick and TikTok the server must be filled in too. If not, ask once more. If they will do it later, add "paste the stream key in OBS" to the pending list and carry on.

## Step 7. Build the scenes

1. `scene_list`, and note which scenes existed before you started. If there are scenes other than OBS's empty starter scene "Scene", ask once: "You already have scenes. Shall I add the four new ones next to them?" Never remove or rename the user's own scenes.
2. `input_kinds` to get this machine's input kinds, and `input_list` to see what exists.
3. Audio, without duplicates. OBS can have global audio devices (normally "Desktop Audio" and "Mic/Aux") that play in every scene; in `input_list` they are audio inputs whose scenes list is empty.
   - Microphone: if a global microphone input exists, point it at the chosen mic with `input_settings_set`. Otherwise create one with `input_create` (role `microphone`, name "Mic", scene "Live", the chosen device id).
   - Desktop audio: if a global desktop audio input exists, keep it. Otherwise create one with `input_create` (role `desktop_audio`, name "Desktop Audio", scene "Live").
   - Never capture the same device twice; it causes echo.
   - Add noise suppression to the mic: `filter_add` of kind `noise_suppress_filter_v2` with method `rnnoise`, named "Noise Suppression". If the server rejects the kind, skip it and move on.
   - Tell the user in one sentence which scenes carry their mic and their computer sound, read from `input_list` after you are done, for example "Your mic is heard on every scene because it's OBS's global mic; your computer sound is only on the Live scene."
4. Create the four scenes with `scene_create` in reverse show order: "Ending", "BRB", "Live", then "Starting Soon". OBS puts each newly created scene at the top of its scene list, so creating them backwards makes the list read top to bottom in show order: Starting Soon, Live, BRB, Ending. Then fill them with `input_create` using the defaults below.
5. Place items with `scene_item_transform_set`, using named anchors such as `center` and `bottom-right` with a margin.
6. Remove OBS's empty starter scene only when all three are true: a scene named "Scene" exists, `scene_items` shows it has no items, and it was the only scene before you started. Then `scene_set_current` "Starting Soon" and `scene_remove` "Scene". Never remove any other scene that existed before you started.

### Scene defaults

Sizes are for a 1920x1080 canvas. Scale them with the canvas height: at 2560x1440 multiply by 4/3 (webcam 640x360, 43 px margin, text about 128 px); at 1280x720 multiply by 2/3. Layout is placed on the canvas; OBS scales the whole picture down to the output.

| Scene | Contents | Layout |
|---|---|---|
| Starting Soon | Role `color`, dark grey #16181D, named "Starting Soon Background". Role `text`, "Starting soon". | Colour fills the canvas. Text white, about 96 px, anchored `center`. |
| Live | Main capture by purpose (below). Role `camera`, named "Webcam", if the user has one. Mic and desktop audio if not global. | Main capture fills the canvas, fitted inside without stretching, anchored `center`. Webcam 480x270 (a quarter of the canvas width, 16:9), anchored `bottom-right`, 32 px margin. |
| BRB | Role `color` #16181D. Role `text`, "Be right back". | As Starting Soon. |
| Ending | Role `color` #16181D. Role `text`, "Thanks for watching". | As Starting Soon. |

Input names must be unique in OBS, so give each scene's colour and text inputs their own names ("BRB Background", "BRB Text", and so on).

Main capture in Live:

- Game on Windows: role `game` (Game Capture). Use `input_properties` to find the capture-mode option and choose "Capture any fullscreen application".
- Game on macOS: there is no game capture on macOS. Use role `display`.
- Screen: role `display`.
- Camera only: no main capture; the webcam fills the canvas instead of sitting in the corner.
- Mix: role `display`, plus the webcam in the corner.
- TikTok (vertical 1080x1920): camera only fills the canvas; for a game or screen, fit the capture to the canvas width anchored `top`, and put the webcam under it at 60% of the canvas width, anchored `bottom` with a 32 px margin.

Display capture picks the primary display when `input_create` creates it. The exception is when the result says no display could be chosen (no device id): then the user picks it. Tell them: in OBS, click the "Live" scene, double-click the display capture source in the Sources list, choose their main display in the Display list (on a MacBook, "Built-in Retina Display"), and click OK. Add "pick the display in the screen capture source" to the pending list.

OBS stores colours as 0xAABBGGRR integers; #16181D is 0xFF1D1816 (4280096790). Use `input_properties` to find the right field names for colour, text and font on this machine; text source kinds differ between Windows and macOS.

## Step 8. Look and adjust

1. `scene_set_current` "Live", then `screenshot` of "Live".
2. Check: the main capture fills the frame without black bars you did not intend; the webcam is in the bottom-right corner, fully visible, not stretched; text on the other scenes is readable (screenshot them too).
3. Fix with `scene_item_transform_set` and look again. Stop after three rounds and ask the user what looks off.
4. Expected black frames:
   - Game Capture is black until a game is running in fullscreen. Ask the user to start their game if they want to check it now, or tell them it will appear when the game runs.
   - macOS: a black display capture or webcam means OBS has no permission yet, or no display was chosen (step 7). For permission, **STOP.** Tell the user: open System Settings > Privacy & Security > Screen & System Audio Recording (called "Screen Recording" on macOS 13 and 14), switch OBS on, and do the same under Camera and Microphone; macOS will ask to quit and reopen OBS, which is fine. Then call `obs_connect` and look again. On macOS 15 and later, macOS may also show its own prompt about OBS recording the screen, then and from time to time later; the user has to accept it (Allow) or the capture stays black.
   - Windows: a black webcam usually means another app (Zoom, Teams, Discord, a browser) is using it, or Windows privacy blocks it: Settings > Privacy & security > Camera > "Let desktop apps access your camera" must be on.
5. Leave "Live" as the current scene for the test.

## Step 9. Test

1. Make sure "Live" is the current scene (`scene_set_current` "Live"), so the test records the scene with the capture and the webcam.
2. Call `test_record` for 30 seconds (the default). While it runs, tell the user it's a quick private test, nothing goes online.
3. Pass when the skipped-frame percentage is under 1% and the file size is above zero. 2% or more is encoder overload.
4. Call `stats`. Pass when rendered frames skipped are under 1% of the total and the active fps matches the target.
5. If either fails: step down once (encoder preset one step faster, then 60 to 30 fps, then the output from 1080p to 720p with a matching bitrate; leave the canvas as it is), say what you changed in one sentence, and test again. After two failed rounds, stop and explain what the machine can't keep up with.
6. **STOP.** Ask the user to open the test file (give the path from `test_record`) and reply whether the picture is smooth and they can hear their voice and their computer sound. If HEVC or AV1 was chosen for recordings on Windows and the file won't open in the Windows player, suggest VLC; it is not a setup problem.
7. If they report a problem, fix it (wrong mic, levels with `input_audio_set`, layout) and run `test_record` again on "Live".
8. `scene_set_current` "Starting Soon", so going live starts on the right scene.

## Step 10. Save the known-good snapshot

1. Make the pending list: every step the user still has to do in OBS or in system settings for the setup to work. Check rather than assume: `stream_service_get` shows the key as `"<set>"` (and, for Kick and TikTok, a server); the display capture has a display chosen; no permission is still missing.
2. Nothing pending: call `snapshot_save` with label `known-good` and a note naming the platform and the result, for example "first Twitch setup, 1080p60 NVENC 6000 kbps, test clean".
3. Something pending: call `snapshot_save` with label `known-good`, the note, and `pending` listing those steps in plain words, for example `["paste the Twitch stream key in OBS", "pick the display in the screen capture source"]`. Then tell the user in one sentence, naming their steps: "Once you have pasted the key (and picked the display), tell me done and I will save the final known-good."

Do this every time a setup ends, even after a re-run.

## Step 11. Tell the user what you did

Send a short summary they can keep:

- If anything is pending, list those steps first, with exactly where to click, and end that part with the "tell me done" sentence from step 10.
- Where they stream, the resolution and fps, the encoder, the video and audio bitrate, and whether recordings are on and where they are saved.
- The four scenes and what each is for, and which scenes carry their mic and computer sound as `input_list` reports it. To go live: pick "Starting Soon", click Start Streaming, switch to "Live" when ready.
- That their stream key stays in OBS and never went through the chat.
- That you saved a known-good snapshot (or, if steps are pending, that you'll save the final one when they say done).
- How to get help next time: "If OBS ever looks or sounds wrong, open Claude and say 'Fix my OBS', or describe what you see, like 'my stream is stuttering since yesterday'. I'll compare everything with the snapshot I saved and put it right." In Claude Code they can also type `/ctrlstream:troubleshoot`.

## Step 12. When the user says done

1. `snapshot_list` for the `known-good` label and take the newest snapshot's `pending` items. These are the steps you saved in step 10; re-check all of them, not only the key and the display.
2. Call `diagnose`. If it shows a problem, fix it with the troubleshoot skill before saving.
3. Re-check each pending item by its own method:
   - Stream key: `stream_service_get` shows the key as `"<set>"` (and, for Kick and TikTok, a server).
   - Display: `scene_set_current` "Live", then `screenshot` of "Live" shows the screen, not black.
   - Webcam or another camera: `screenshot` of that input shows a picture, not black.
   - Permission: `logs_tail` shows OBS's grant line for it, for example "[macOS] Permission for screen capture granted."
   - Anything else: check it with the tool that shows it; if no tool can, ask the user.
4. Every item passes: call `snapshot_save` with label `known-good`, a note such as "final after the user pasted the key and picked the display", and no `pending`. Tell the user in one sentence that the setup is complete and saved.
5. Any item fails: call `snapshot_save` with label `known-good` and `pending` listing only the items still open. Tell the user which steps remain and why, from what the check showed (for example "your webcam still shows black, so OBS can't see it yet"), with exactly where to click, and ask them to say done again.
6. `scene_set_current` "Starting Soon".

## Windows and macOS differences

| Thing | Windows | macOS |
|---|---|---|
| Game capture | Game Capture source | Not available; capture the display |
| Desktop audio | Usually a global "Desktop Audio" device already exists | Create an audio capture input (macOS 13+) if no global one exists |
| Hardware encoder in Simple mode | NVIDIA, AMD or Intel by GPU | Apple Silicon with macOS 13+ only; Intel Macs use x264 |
| Permissions | Settings > Privacy & security > Camera and Microphone | System Settings > Privacy & Security > Screen & System Audio Recording (Screen Recording on 13 and 14), Camera, Microphone; reopen OBS after. macOS 15+ may also prompt about screen recording; accept it |
| Crash dialog button to continue normally | "Run Normally" (30, 31), "Run in Normal Mode" (32+) | Same |
