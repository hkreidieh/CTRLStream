/**
 * Role -> candidate input kinds, per OS (DESIGN 3.3), first match wins. Kinds are always
 * resolved against GetInputKindList at runtime; nothing here is used without that check.
 *
 * Device list property names verified in OBS 32.2.2 plugin sources (2026-10-11):
 *  dshow_input video_device_id (win-dshow.cpp); macos-avcapture / macos-avcapture-fast /
 *  av_capture_input "device" (mac-avcapture plugin-main.m, legacy/av-capture.mm);
 *  v4l2_input "device_id"; wasapi_* "device_id" (win-wasapi.cpp); coreaudio_* "device_id"
 *  (mac-audio.c); pulse_* "device_id"; monitor_capture "monitor_id" (duplicator-monitor-capture.c);
 *  screen_capture and display_capture "display_uuid" (mac-sck-video-capture.m,
 *  mac-display-capture.m); xshm_input "screen".
 */
import type { Platform } from './paths.js';

export const ROLES = ['camera', 'microphone', 'desktop_audio', 'display', 'window', 'game', 'browser', 'media', 'image', 'text', 'color'] as const;
export type Role = (typeof ROLES)[number];

const same = (kinds: string[]): Record<Platform, string[]> => ({ win32: kinds, darwin: kinds, linux: kinds });

export const ROLE_CANDIDATES: Record<Role, Record<Platform, string[]>> = {
  camera: { win32: ['dshow_input'], darwin: ['macos-avcapture', 'av_capture_input'], linux: ['v4l2_input'] },
  microphone: { win32: ['wasapi_input_capture'], darwin: ['coreaudio_input_capture'], linux: ['pulse_input_capture', 'pipewire_audio_input_capture'] },
  desktop_audio: { win32: ['wasapi_output_capture'], darwin: ['sck_audio_capture', 'coreaudio_output_capture'], linux: ['pulse_output_capture'] },
  display: { win32: ['monitor_capture'], darwin: ['screen_capture', 'display_capture'], linux: ['pipewire-desktop-capture-source', 'xshm_input'] },
  window: { win32: ['window_capture'], darwin: ['screen_capture', 'window_capture'], linux: ['pipewire-window-capture-source', 'xcomposite_input'] },
  game: { win32: ['game_capture'], darwin: [], linux: [] },
  browser: same(['browser_source']),
  media: same(['ffmpeg_source']),
  image: same(['image_source']),
  text: { win32: ['text_gdiplus_v3', 'text_gdiplus_v2'], darwin: ['text_ft2_source_v2'], linux: ['text_ft2_source_v2'] },
  color: same(['color_source_v3']),
};

/** The list property that names the device an input is bound to. */
export const DEVICE_PROPERTY: Record<string, string> = {
  dshow_input: 'video_device_id',
  'macos-avcapture': 'device',
  'macos-avcapture-fast': 'device',
  av_capture_input: 'device',
  v4l2_input: 'device_id',
  wasapi_input_capture: 'device_id',
  wasapi_output_capture: 'device_id',
  coreaudio_input_capture: 'device_id',
  coreaudio_output_capture: 'device_id',
  pulse_input_capture: 'device_id',
  pulse_output_capture: 'device_id',
  monitor_capture: 'monitor_id',
  screen_capture: 'display_uuid',
  display_capture: 'display_uuid',
  xshm_input: 'screen',
};

/**
 * Extra settings a role needs on top of the kind's defaults. macOS ScreenCaptureKit
 * (screen_capture) serves display and window roles through its "type" setting
 * (0 display, 1 window, 2 application; mac-sck-common).
 */
export const ROLE_SETTINGS: Partial<Record<Role, Record<string, Record<string, unknown>>>> = {
  display: { screen_capture: { type: 0 } },
  window: { screen_capture: { type: 1 } },
};

/** Device inventory buckets used by obs_devices, snapshots and diagnose. */
export const DEVICE_ROLES = {
  cameras: 'camera',
  microphones: 'microphone',
  speakers: 'desktop_audio',
  displays: 'display',
} as const satisfies Record<string, Role>;

/** Kinds whose device id refers to an audio device (AUDIO_DEVICE_MISSING vs DEVICE_MISSING). */
export const AUDIO_KINDS = new Set([
  'wasapi_input_capture',
  'wasapi_output_capture',
  'coreaudio_input_capture',
  'coreaudio_output_capture',
  'pulse_input_capture',
  'pulse_output_capture',
  'pipewire_audio_input_capture',
]);

export function unversioned(kind: string): string {
  return kind.replace(/_v\d+$/, '');
}

export function versionOf(kind: string): number {
  const m = /_v(\d+)$/.exec(kind);
  return m ? Number(m[1]) : 1;
}

/**
 * Pick the kind to use for a candidate: exact match first, otherwise the highest version of the
 * same unversioned kind (GetInputKindList returns versioned ids such as color_source_v3).
 */
export function matchKind(candidate: string, available: string[]): string | null {
  if (available.includes(candidate)) return candidate;
  const base = unversioned(candidate);
  const same = available.filter((k) => unversioned(k) === base).sort((a, b) => versionOf(b) - versionOf(a));
  return same[0] ?? null;
}

export interface ResolvedRole {
  role: Role;
  kind: string | null;
  candidates: string[];
  deviceProperty: string | null;
}

export function resolveRoles(platform: Platform, available: string[]): ResolvedRole[] {
  return ROLES.map((role) => {
    const candidates = ROLE_CANDIDATES[role][platform];
    let kind: string | null = null;
    for (const c of candidates) {
      kind = matchKind(c, available);
      if (kind) break;
    }
    const prop = kind ? (DEVICE_PROPERTY[kind] ?? DEVICE_PROPERTY[unversioned(kind)] ?? null) : null;
    return { role, kind, candidates, deviceProperty: role === 'window' ? null : prop };
  });
}

export function deviceProperty(kind: string): string | null {
  return DEVICE_PROPERTY[kind] ?? DEVICE_PROPERTY[unversioned(kind)] ?? null;
}

/**
 * Input kinds whose list properties must never be queried with GetInputPropertiesListPropertyItems.
 * Verified on the real OBS 32.2.2 / obs-websocket 5.7.4 on macOS 26.2 (2026-10-11): querying
 * screen_capture's display_uuid crashed OBS with SIGSEGV in obs-websocket (strlen on NULL), once
 * with Screen Recording permission denied (02:30) and once with it granted (06:52), same stack.
 * Root cause in the source: ScreenCaptureKit's display, window and application lists all start
 * with a placeholder entry whose value is NULL (plugins/mac-capture/mac-sck-common.m), which
 * obs-websocket turns into a std::string. So the guard does not depend on permission.
 * sck_audio_capture's application list is built the same way. Displays come from the OS instead
 * (probes/displays.ts).
 */
export const UNSAFE_LIST_KINDS = new Set(['screen_capture', 'sck_audio_capture']);

export function listQueryIsSafe(kind: string): boolean {
  return !UNSAFE_LIST_KINDS.has(unversioned(kind)) && !UNSAFE_LIST_KINDS.has(kind);
}
