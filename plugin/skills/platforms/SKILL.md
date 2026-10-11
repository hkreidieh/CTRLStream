---
name: platforms
description: Streaming platform and encoder rules for OBS Studio, read from CTRLStream's two data files. Use when choosing or checking an OBS bitrate, resolution, frame rate, encoder, preset, keyframe interval or audio bitrate for Twitch, YouTube Live, Kick, TikTok LIVE or Facebook Live; when a streamer asks what settings their PC or connection can handle; or when diagnose reports BITRATE_ABOVE_PLATFORM_CAP, BITRATE_ABOVE_UPLOAD, ENCODER_UNAVAILABLE or ENCODER_OVERLOAD.
---

# Platform and encoder rules

Two data files hold the facts. They are the authority. This page tells you how to read and apply them.

- `${CLAUDE_PLUGIN_ROOT}/knowledge/platforms.json`: ingest rules per platform.
- `${CLAUDE_PLUGIN_ROOT}/knowledge/encoders.json`: OBS encoder identifiers, what each GPU can encode, and recommended presets.

Read only the parts you need. Never paste the files to the user. If you read them through the `knowledge` tool, ask for exactly the part you need with a dotted path, for example `families.apple` or `platforms.twitch`. When you are unsure of the path, ask for the top-level section (for example `families`) and look inside it. Tool names below are CTRLStream server tools; your client may show them with a prefix.

## Read a figure

Every figure looks like `{ "value": ..., "confidence": "high" | "medium" | "low", "sources": [...], "note": "..." }`.

- `high`: read from the platform's or vendor's own page, or from the OBS source. Use it.
- `medium`: from the platform's own page, but seen through a search extract. Use it.
- `low`: a guess, or a dated or regional source. Use it as a starting point and tell the user in one sentence, for example "TikTok doesn't publish limits, so I'm starting from a safe 2,500 kbps."
- `"value": null` means the platform publishes no figure. Do not invent one.
- Always read the `note`. Notes carry the exceptions.

Where things live in `platforms.json`, under `platforms.<id>` (`twitch`, `youtube`, `kick`, `tiktok`, `facebook`):

- `obs`: the values for `stream_service_set` (`serviceType`, `serviceName`, `server`), whether OBS sets the keyframe interval for you (`keyframeIntervalSetByObs`), and the limits OBS enforces on its own (`obsEnforced`).
- `video.maxBitrateKbps`, `video.maxResolution`, `video.maxFps`, `video.codecs`, `video.recommended` (a list of resolution, fps, codec and bitrate; a two-number bitrate is `[minimum, recommended]`).
- `audio.recommendedBitrateKbps`, `audio.sampleRateHz`.
- `streamKeyInstructions`: the exact sentence to give the user about pasting their key.
- `rules`: the upload rule, the fallback when there is no measurement, and how to match a profile to a platform.

Where things live in `encoders.json`:

- `logIdToSimpleEncoder`: turns each encoder id from `obs_encoders` (the OBS log) into the Simple-mode name you pass to `output_set_simple`. A `null` means there is no Simple-mode name.
- `simpleModeEncoders.<name>`: codec, the preset key and allowed values, OBS's default preset.
- `families.<nvidia|amd|intel|apple|x264>`: which GPU generations encode which codec, `streaming.codecByPlatform`, `streaming.simpleMode`, `streaming.advancedMode`, `recording.simpleMode`, `bitrateRangesKbps`.
- `simpleModeFacts`: what Simple mode does on its own (CBR always, service limits, keyframes, recording formats).

## The bitrate rule

Never break this. Check it every time you set or change a bitrate.

1. Video bitrate plus audio bitrate must be at or under 70% of the measured upload from `network_test`.
2. Video bitrate must be at or under `video.maxBitrateKbps.value` for the platform, when that value is not null.

Work it out like this: `allowed = min(0.7 × uploadKbps − audioKbps, platformCap)`. Then use the platform's recommended bitrate for the chosen resolution and fps, lowered to `allowed` if it is higher.

Example: Twitch, upload measured at 12 Mbps. 0.7 × 12,000 = 8,400. Minus 160 audio = 8,240. Twitch cap 6,000. Allowed = 6,000. Twitch recommends 6,000 for 1080p60, so use 6,000.

If the allowed bitrate is below the bottom of the platform's range for that resolution and fps (or below the single figure the platform gives), step down and recompute:

- Game: 1080p60, then 720p60, then 720p30.
- Camera, desktop or mixed without a game: 1080p30, then 720p30.

No measurement: ask once for consent to run `network_test` (it uploads random data to Cloudflare's speed test for about 10 seconds; nothing personal). If the user declines, use `rules.noMeasurementFallback` (720p30 at 3,000 kbps) and tell them they can run the test later for better quality.

OBS also clamps the bitrate to `obs.obsEnforced` for Twitch, YouTube and Facebook unless "Ignore streaming service setting recommendations" is ticked. Never tick it, and never ask the user to.

## Choose the encoder

1. Find the codecs the platform takes: `video.codecs` entries whose value is `true`. Twitch takes H.264 only (HEVC only through Enhanced Broadcasting). YouTube takes H.264, HEVC and AV1. Kick and Facebook take H.264. Use H.264 for TikTok.
2. Find what this machine has: map every id from `obs_encoders` through `logIdToSimpleEncoder`.
3. Confirm with the GPU from `system_info` against `families.<vendor>.generations`. Known traps: RTX 20 and 30 have no AV1 encoder; Radeon RX 6000 has no AV1 encoder; RX 6300, 6400 and 6500 have no hardware encoder at all; 11th to 14th gen Intel graphics have no AV1 encoder; no Mac has an AV1 encoder in OBS.
4. Take `families.<vendor>.streaming.codecByPlatform.<platform>`. If that Simple-mode encoder is not available, step down AV1 to HEVC to H.264, then to `x264`.
5. Laptop with both integrated and discrete graphics: prefer the discrete card's encoder (NVENC or AMD) over Intel QSV.
6. Mac: Apple Silicon with macOS 13 or newer uses `apple_h264` or `apple_hevc`. An Intel Mac gets only `x264` in Simple mode.
7. Preset: `families.<vendor>.streaming.simpleMode`. NVIDIA `NVENCPreset2` p6, AMD `AMDPreset` quality, Intel `QSVPreset` balanced, x264 `Preset` from `families.x264.presetByCpuClass`.
8. If `test_record` or `diagnose` shows encoder overload, step one preset faster (NVIDIA p6 to p5 to p4; AMD quality to balanced to speed; Intel quality to balanced to speed; x264 one step toward superfast), then lower fps, then lower resolution.

Say the choice in one plain sentence, for example "I'm using your graphics card's NVIDIA encoder, so your games keep the processor to themselves."

## Simple or advanced output

- Twitch, YouTube, Facebook: use `output_set_simple`. OBS applies the 2-second keyframe interval and the platform's limits by itself.
- Kick, TikTok: these use OBS's Custom service, which sets no keyframe interval. In Simple mode OBS then falls back to 250 frames (about 4 seconds at 60 fps, 8 at 30). Kick requires 2 seconds. Use `output_set_advanced` with keyframe interval 2 s, CBR, and the chosen encoder and preset (`families.<vendor>.streaming.advancedMode`). It writes files, so OBS must be closed: `obs_quit`, `output_set_advanced`, `obs_launch`.

## Audio

Use `audio.recommendedBitrateKbps` for the platform: Twitch 160, YouTube 128, Facebook 128, Kick 160, TikTok 160. Keep OBS's sample rate at 48 kHz. Changing it needs a restart and buys nothing on these platforms.

## Quick reference

A summary of the JSON as checked on 2026-10-11. If this table and the JSON disagree, the JSON wins.

| Platform | OBS service | Video codecs | Max video kbps | 1080p60 kbps | Keyframes | Audio kbps |
|---|---|---|---|---|---|---|
| Twitch | `rtmp_common`, "Twitch", server `auto` | H.264 (HEVC only via Enhanced Broadcasting) | 6,000 | 6,000 | 2 s, set by OBS | 160 |
| YouTube | `rtmp_common`, "YouTube - RTMPS" | H.264, HEVC, AV1 | 51,000 (OBS cap) | H.264 6,000 to 17,000; HEVC or AV1 4,000 to 12,000 | 2 s, set by OBS | 128 |
| Kick | `rtmp_custom` | H.264 | 8,000 | 1,000 to 8,000 | 2 s, set it yourself | 160 (low) |
| TikTok | `rtmp_custom` | H.264 | not published | 2,500 at 1080x1920, 25 fps (low) | 2 s, set it yourself (low) | 160 (low) |
| Facebook | `rtmp_common`, "Facebook Live" | H.264 | 9,000 | 4,500 to 9,000 | 2 s, set by OBS | 128 |

## Twitch Enhanced Broadcasting

CTRLStream v1 does not switch it on. If the user asks for 1440p on Twitch, say that it needs Enhanced Broadcasting, that it is open to Partners and Affiliates, that Twitch then chooses the encoder settings itself, and that they tick it in OBS under Settings > Stream ("Enable Enhanced Broadcasting" in the Multitrack Video section). Twitch asks for about 20 Mbps of upload for 2K without server-side transcoding.

## When the platform disagrees with the file

If a platform rejects a setting the file allows, trust the platform. Lower the setting, tell the user, and mention that CTRLStream's platform data may be out of date.
