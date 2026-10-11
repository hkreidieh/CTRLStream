/** QA round two: the black-capture note and platform-aware encoder advice. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { iniSet, parseIni, serializeIni } from '../../src/obs/files.js';
import { suggestEncoder } from '../../src/probes/encoders.js';
import { BLACK_PROBE } from '../../src/tools/layout.js';
import { expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('screenshot: the "black until shown" note only when it is really black and never shown', () => {
  it('calibrated threshold sits between measured black and measured content', () => {
    expect(BLACK_PROBE).toEqual({ width: 160, quality: 70, maxBytes: 1100 });
    expect(907).toBeLessThan(BLACK_PROBE.maxBytes); // never-shown display capture, real OBS
    expect(1388).toBeGreaterThan(BLACK_PROBE.maxBytes); // dark colour + text scene
    expect(3751).toBeGreaterThan(BLACK_PROBE.maxBytes); // desktop after switching away
  });

  it('never shown and black: note', async () => {
    h = await makeHarness();
    expectOk(await h.call('input_create', { name: 'Screen', scene: 'Live', role: 'display' }));
    expect(String(expectOk(await h.call('screenshot', { source: 'Screen' }))['note'])).toContain('scene_set_current');
  });

  it('shown live earlier in this session, now off-program: no note (no reason to switch scenes)', async () => {
    h = await makeHarness();
    expectOk(await h.call('input_create', { name: 'Screen', scene: 'Live', role: 'display' }));
    expectOk(await h.call('scene_set_current', { name: 'Live' }));
    expectOk(await h.call('scene_set_current', { name: 'Scene' }));
    expect(expectOk(await h.call('screenshot', { source: 'Screen' }))['note']).toBeUndefined();
    expect(expectOk(await h.call('screenshot', { source: 'Live' }))['note']).toBeUndefined();
  });

  it('never shown in this session but the image has content (shown before ctrlstream started): no note', async () => {
    h = await makeHarness();
    expectOk(await h.call('input_create', { name: 'Screen', scene: 'Live', role: 'display' }));
    h.model.forcePicture.add('Screen');
    expect(expectOk(await h.call('screenshot', { source: 'Screen' }))['note']).toBeUndefined();
  });

  it('a new OBS process forgets what was shown', async () => {
    h = await makeHarness();
    expectOk(await h.call('input_create', { name: 'Screen', scene: 'Live', role: 'display' }));
    expectOk(await h.call('scene_set_current', { name: 'Live' }));
    expectOk(await h.call('scene_set_current', { name: 'Scene' }));
    h.proc.pid = 5555; // OBS restarted
    h.model.everActive.clear();
    expect(String(expectOk(await h.call('screenshot', { source: 'Screen' }))['note'])).toContain("'Screen'");
  });

  it('Windows: never adds the note', async () => {
    h = await makeHarness({ platform: 'win32' });
    expect(expectOk(await h.call('screenshot', { source: 'Live' }))['note']).toBeUndefined();
  });
});

const encoderLog = (ids: string[]) => `10:00:00.000: OBS 32.2.2 (windows)\n10:00:00.001: Available Encoders:\n10:00:00.001:   Video Encoders:\n${ids.map((i) => `10:00:00.001: \t- ${i} (x)`).join('\n')}\n10:00:00.001:   Audio Encoders:\n10:00:00.001: \t- ffmpeg_aac (FFmpeg AAC)\n10:00:00.002: ==== Startup complete ===\n`;

function setStreamEncoder(h: Harness, value: string): void {
  const ini = path.join(h.profileDir, 'basic.ini');
  const doc = parseIni(readFileSync(ini, 'utf8'));
  iniSet(doc, 'SimpleOutput', 'StreamEncoder', value);
  writeFileSync(ini, serializeIni(doc));
}

const finding = (r: Record<string, unknown>, code: string) => (r['findings'] as Array<Record<string, unknown>>).find((f) => f['code'] === code)!;

describe('ENCODER_UNAVAILABLE advice is platform-aware', () => {
  it('nvenc on a Mac: never available here, use the Apple encoder (from knowledge), no driver talk', async () => {
    h = await makeHarness({ running: false });
    setStreamEncoder(h, 'nvenc');
    const f = finding(expectOk(await h.call('diagnose')), 'ENCODER_UNAVAILABLE');
    expect(String(f['suggestedAction'])).toContain('never been available on this machine');
    expect(String(f['suggestedAction'])).toContain("'apple_h264'");
    expect(String(f['suggestedAction'])).not.toMatch(/driver/i);
    expect(f['suggestedTool']).toBe('output_set_simple');
  });

  it('after OBS rewrote it at startup, the replacement finding carries the same advice', async () => {
    h = await makeHarness({ running: false });
    setStreamEncoder(h, 'nvenc');
    await h.call('obs_status');
    h.model.params.set('SimpleOutput.StreamEncoder', 'x264');
    expectOk(await h.call('obs_launch'));
    const f = finding(expectOk(await h.call('diagnose', { checkDevices: false })), 'ENCODER_UNAVAILABLE');
    expect(String(f['evidence'])).toContain("was 'nvenc' on disk");
    expect(String(f['suggestedAction'])).toContain('never been available on this machine');
  });

  it('Windows, NVENC seen in an older log but gone now: the driver probably changed', async () => {
    h = await makeHarness({ platform: 'win32', running: false });
    const logs = path.join(h.configDir, 'logs');
    rmSync(logs, { recursive: true, force: true });
    mkdirSync(logs, { recursive: true });
    writeFileSync(path.join(logs, '2026-10-01 10-00-00.txt'), encoderLog(['obs_nvenc_h264_tex', 'obs_x264']));
    writeFileSync(path.join(logs, '2026-10-11 10-00-00.txt'), encoderLog(['obs_x264']));
    setStreamEncoder(h, 'nvenc');
    const f = finding(expectOk(await h.call('diagnose')), 'ENCODER_UNAVAILABLE');
    expect(String(f['suggestedAction'])).toContain('worked on this machine before');
    expect(String(f['suggestedAction'])).toMatch(/driver/);
    expect(String(f['suggestedAction'])).toContain("'x264'");
  });

  it('Windows, NVENC never in any log: never available here', async () => {
    h = await makeHarness({ platform: 'win32', running: false });
    const logs = path.join(h.configDir, 'logs');
    rmSync(logs, { recursive: true, force: true });
    mkdirSync(logs, { recursive: true });
    writeFileSync(path.join(logs, '2026-10-11 10-00-00.txt'), encoderLog(['h264_texture_amf', 'obs_x264']));
    setStreamEncoder(h, 'nvenc');
    const f = finding(expectOk(await h.call('diagnose')), 'ENCODER_UNAVAILABLE');
    expect(String(f['suggestedAction'])).toContain('never been available on this machine');
    expect(String(f['suggestedAction'])).toContain("'amd'");
  });

  it('suggestEncoder follows the per-platform recommendation in knowledge/encoders.json', async () => {
    h = await makeHarness();
    expect(await suggestEncoder(h.ctx, ['x264', 'apple_h264', 'apple_hevc'], 'youtube')).toMatchObject({ encoder: 'apple_hevc' });
    expect(await suggestEncoder(h.ctx, ['x264', 'apple_h264', 'apple_hevc'], 'twitch')).toMatchObject({ encoder: 'apple_h264' });
    expect(await suggestEncoder(h.ctx, ['x264'], 'twitch')).toMatchObject({ encoder: 'x264' });
  });
});
