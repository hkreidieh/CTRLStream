import { describe, expect, it } from 'vitest';
import { isObsCommand, launchArgs } from '../../src/obs/discovery.js';
import { matchKind, resolveRoles, listQueryIsSafe } from '../../src/obs/input-roles.js';
import { MAC_INPUT_KINDS, WIN_INPUT_KINDS } from '../mock/obs-model.js';

describe('process detection and launch flags', () => {
  it('recognises the OBS binary per OS', () => {
    expect(isObsCommand('darwin', '/Applications/OBS.app/Contents/MacOS/OBS')).toBe(true);
    expect(isObsCommand('darwin', '/Applications/OBS.app/Contents/MacOS/OBS --profile x')).toBe(true);
    expect(isObsCommand('darwin', '/Applications/OBS.app/Contents/Frameworks/obs-ffmpeg-mux')).toBe(false);
    expect(isObsCommand('linux', '/usr/bin/obs --startstreaming')).toBe(true);
    expect(isObsCommand('linux', '/usr/bin/obsidian')).toBe(false);
    expect(isObsCommand('win32', 'obs64.exe')).toBe(true);
  });

  it('builds OBS command-line flags', () => {
    expect(launchArgs({ safeMode: true, profile: 'P', collection: 'C' })).toEqual(['--safe-mode', '--profile', 'P', '--collection', 'C']);
    expect(launchArgs({ onlyBundledPlugins: true })).toEqual(['--only-bundled-plugins']);
    expect(launchArgs({})).toEqual([]);
  });
});

describe('input kind roles (DESIGN 3.3)', () => {
  it('resolves against the real macOS kind list, versions included', () => {
    const roles = Object.fromEntries(resolveRoles('darwin', MAC_INPUT_KINDS).map((r) => [r.role, r]));
    expect(roles['camera']!.kind).toBe('macos-avcapture');
    expect(roles['camera']!.deviceProperty).toBe('device');
    expect(roles['microphone']!.kind).toBe('coreaudio_input_capture');
    expect(roles['display']!.kind).toBe('screen_capture');
    expect(roles['text']!.kind).toBe('text_ft2_source_v2');
    expect(roles['color']!.kind).toBe('color_source_v3');
    expect(roles['game']!.kind).toBeNull();
    expect(roles['window']!.deviceProperty).toBeNull();
  });

  it('resolves Windows roles', () => {
    const roles = Object.fromEntries(resolveRoles('win32', WIN_INPUT_KINDS).map((r) => [r.role, r]));
    expect(roles['camera']!.kind).toBe('dshow_input');
    expect(roles['camera']!.deviceProperty).toBe('video_device_id');
    expect(roles['display']!.deviceProperty).toBe('monitor_id');
    expect(roles['game']!.kind).toBe('game_capture');
    expect(roles['text']!.kind).toBe('text_gdiplus_v3');
  });

  it('matches unversioned candidates to the highest version', () => {
    expect(matchKind('av_capture_input', MAC_INPUT_KINDS)).toBe('av_capture_input_v2');
    expect(matchKind('color_source', ['color_source_v2', 'color_source_v3'])).toBe('color_source_v3');
    expect(matchKind('nope', MAC_INPUT_KINDS)).toBeNull();
  });

  it('never lists properties of kinds that crash OBS', () => {
    expect(listQueryIsSafe('screen_capture')).toBe(false);
    expect(listQueryIsSafe('sck_audio_capture')).toBe(false);
    expect(listQueryIsSafe('macos-avcapture')).toBe(true);
  });
});
