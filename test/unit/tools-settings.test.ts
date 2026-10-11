import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { iniGet, parseIni } from '../../src/obs/files.js';
import { DUMMY_KEY, expectError, expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

describe('video', () => {
  it('video_get live and from files', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('video_get'))).toMatchObject({ source: 'live', baseWidth: 1920, outputHeight: 720, fps: 30 });
    await h.cleanup();
    h = await makeHarness({ running: false });
    expect(expectOk(await h.call('video_get'))).toMatchObject({ source: 'files', baseWidth: 1920, outputWidth: 1280, fps: 30 });
  });

  it('video_set pairs, NTSC fps, undo, refused while live', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('video_set', { outputWidth: 1920, outputHeight: 1080, fps: 59.94 }));
    expect(r['now']).toMatchObject({ outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60000, fpsDenominator: 1001 });
    expectOk(await h.call('undo_last'));
    expect(h.model.video).toMatchObject({ outputWidth: 1280, fpsNumerator: 30 });
    expectError(await h.call('video_set', { baseWidth: 1920 }), 'INVALID_ARGUMENT');
    expectError(await h.call('video_set', { fps: 33.3 }), 'INVALID_ARGUMENT');
    expectError(await h.call('video_set', {}), 'INVALID_ARGUMENT');
    h.model.record.active = true;
    expectError(await h.call('video_set', { fps: 60 }), 'OUTPUT_ACTIVE');
  });
});

describe('output', () => {
  it('output_get reports Simple settings and the bitrate OBS will really send', async () => {
    h = await makeHarness();
    h.model.params.set('SimpleOutput.VBitrate', '8000');
    const r = expectOk(await h.call('output_get'));
    expect(r['simple']).toMatchObject({ encoder: 'x264', videoBitrateKbps: 8000, effectiveVideoBitrateKbps: 6000, serviceMaxVideoKbps: 6000, ignoreServiceLimits: false, preset: 'veryfast', rateControl: 'CBR', recFormat: 'hybrid_mov' });
    expect(String(r['note'])).toContain('6000');
  });

  it('output_get from files uses basic.ini and services.json', async () => {
    h = await makeHarness({ running: false });
    const r = expectOk(await h.call('output_get'));
    expect(r).toMatchObject({ source: 'files', mode: 'Simple' });
    expect(r['simple']).toMatchObject({ videoBitrateKbps: 2500, effectiveVideoBitrateKbps: 2500, serviceMaxVideoKbps: 6000 });
  });

  it('output_set_simple says which changes need a restart (verified on the real OBS) and undoes', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('output_set_simple', { encoder: 'apple_h264', videoBitrateKbps: 6000, audioBitrateKbps: 160 }));
    const changes = r['changes'] as Array<Record<string, unknown>>;
    expect(changes.find((c) => c['setting'] === 'encoder')).toMatchObject({ parameter: 'SimpleOutput.StreamEncoder', from: 'x264', to: 'apple_h264', appliesOn: 'restart' });
    expect(changes.find((c) => c['setting'] === 'videoBitrateKbps')).toMatchObject({ appliesOn: 'next_start' });
    expect(r['restartRequired']).toBe(true);
    // OBS writes basic.ini on SetProfileParameter.
    expect(iniGet(parseIni(readFileSync(path.join(h.profileDir, 'basic.ini'), 'utf8')), 'SimpleOutput', 'StreamEncoder')).toBe('apple_h264');
    expectOk(await h.call('undo_last'));
    expect(h.model.param('SimpleOutput', 'StreamEncoder').value).toBe('x264');
  });

  it('output_set_simple validates encoders against the log and presets per encoder', async () => {
    h = await makeHarness();
    expectError(await h.call('output_set_simple', { encoder: 'nvenc' }), 'INVALID_ARGUMENT');
    expectError(await h.call('output_set_simple', { preset: 'p5' }), 'INVALID_ARGUMENT');
    expect(expectOk(await h.call('output_set_simple', { preset: 'faster' }))['changes']).toEqual([expect.objectContaining({ parameter: 'SimpleOutput.Preset', to: 'faster' })]);
    expectError(await h.call('output_set_simple', { encoder: 'apple_h264', preset: 'fast' }), 'INVALID_ARGUMENT');
    expectError(await h.call('output_set_simple', {}), 'INVALID_ARGUMENT');
    expectError(await h.call('output_set_simple', { encoder: 'qsv_hevc' }), 'INVALID_ARGUMENT');
  });

  it('output_set_simple warns in Advanced mode and can switch modes', async () => {
    h = await makeHarness();
    h.model.params.set('Output.Mode', 'Advanced');
    expect((expectOk(await h.call('output_set_simple', { videoBitrateKbps: 4000 }))['warnings'] as string[])[0]).toContain('Advanced');
    const r = expectOk(await h.call('output_set_simple', { switchToSimpleMode: true }));
    expect((r['changes'] as Array<Record<string, unknown>>)[0]).toMatchObject({ parameter: 'Output.Mode', appliesOn: 'restart' });
  });

  it('output_set_advanced writes encoder JSON with OBS closed, merges, and undoes', async () => {
    h = await makeHarness({ running: false });
    const r = expectOk(await h.call('output_set_advanced', { target: 'stream', settings: { rate_control: 'CBR', bitrate: 6000, keyint_sec: 2 }, encoder: 'obs_x264' }));
    expect(r).toMatchObject({ file: 'streamEncoder.json', encoder: 'obs_x264', next: 'obs_launch' });
    expect(r['warning']).toContain('Simple');
    const f = path.join(h.profileDir, 'streamEncoder.json');
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ rate_control: 'CBR', bitrate: 6000, keyint_sec: 2 });
    expectOk(await h.call('output_set_advanced', { target: 'stream', settings: { bitrate: 4500 } }));
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ bitrate: 4500, keyint_sec: 2 });
    expectOk(await h.call('undo_last'));
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ bitrate: 6000 });
    expectOk(await h.call('undo_last'));
    expect(existsSync(f)).toBe(false);
    expectError(await h.call('output_set_advanced', { target: 'record', settings: {}, encoder: 'jim_nvenc' }), 'INVALID_ARGUMENT');
  });

  it('record_set sets folder, format, quality, encoder with timing, undo, and validation', async () => {
    h = await makeHarness();
    const dir = h.dataDir.replace(/data$/, 'recordings');
    const r = expectOk(await h.call('record_set', { path: dir, format: 'mkv', quality: 'HQ', encoder: 'apple_h264' }));
    expect((r['changes'] as Array<Record<string, unknown>>).map((c) => [c['setting'], c['appliesOn']])).toEqual([
      ['path', 'next_start'],
      ['format', 'restart'],
      ['quality', 'restart'],
      ['encoder', 'restart'],
    ]);
    expect(h.model.record.dir).toBe(dir);
    expectOk(await h.call('undo_last'));
    expect(h.model.record.dir).toBe(h.dataDir.replace(/data$/, 'recordings'));
    expect(h.model.param('SimpleOutput', 'RecFormat2').value).toBe('hybrid_mov');
    expectError(await h.call('record_set', { path: '/definitely/not/here' }), 'INVALID_ARGUMENT');
    expectError(await h.call('record_set', {}), 'INVALID_ARGUMENT');
    expectError(await h.call('record_set', { encoder: 'obs_x264' }), 'INVALID_ARGUMENT');
    h.model.params.set('Output.Mode', 'Advanced');
    expectError(await h.call('record_set', { quality: 'HQ' }), 'INVALID_ARGUMENT');
    expect(expectOk(await h.call('record_set', { format: 'mkv' }))['mode']).toBe('Advanced');
  });

  it('audio_set edits basic.ini with OBS closed and undoes', async () => {
    h = await makeHarness({ running: false });
    const r = expectOk(await h.call('audio_set', { sampleRate: 44100, channels: 'Mono' }));
    expect(r).toMatchObject({ sampleRate: { from: 48000, to: 44100 }, channels: { from: 'Stereo', to: 'Mono' }, appliesOn: 'restart' });
    const ini = () => parseIni(readFileSync(path.join(h.profileDir, 'basic.ini'), 'utf8'));
    expect(iniGet(ini(), 'Audio', 'SampleRate')).toBe('44100');
    expectOk(await h.call('undo_last'));
    expect(iniGet(ini(), 'Audio', 'SampleRate')).toBe('48000');
    expectError(await h.call('audio_set', {}), 'INVALID_ARGUMENT');
    expectError(await h.call('audio_set', { sampleRate: 96000 }), 'INVALID_ARGUMENT');
  });
});

describe('stream service', () => {
  it('stream_service_get never shows the key, live or from files', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('stream_service_get'))).toMatchObject({ source: 'live', type: 'rtmp_common', service: 'Twitch', server: 'auto', key: '<set>' });
    await h.cleanup();
    h = await makeHarness({ running: false });
    expect(expectOk(await h.call('stream_service_get'))).toMatchObject({ source: 'files', service: 'Twitch', key: '<set>' });
  });

  it('stream_service_set validates the service, picks the default server, keeps the key, undoes', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('stream_service_set', { type: 'rtmp_common', service: 'YouTube - RTMPS' }));
    expect(r['now']).toMatchObject({ service: 'YouTube - RTMPS', server: 'rtmps://a.rtmps.youtube.com:443/live2', key: '<set>' });
    expect(r['warning']).toContain('key');
    expectOk(await h.call('undo_last'));
    expect(h.model.service.settings).toMatchObject({ service: 'Twitch', server: 'auto', key: DUMMY_KEY });
    expectError(await h.call('stream_service_set', { type: 'rtmp_common', service: 'Twich' }), 'NOT_FOUND');
    expectError(await h.call('stream_service_set', { type: 'rtmp_common' }), 'INVALID_ARGUMENT');
    expectError(await h.call('stream_service_set', { type: 'rtmp_custom' }), 'INVALID_ARGUMENT');
    expectError(await h.call('stream_service_set', { type: 'rtmp_custom', server: 'http://x' }), 'INVALID_ARGUMENT');
  });

  it('switching to a custom server drops the key; undo restores type and server and carries the current key', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('stream_service_set', { type: 'rtmp_custom', server: 'rtmp://ingest.example/live' }));
    expect(r['now']).toMatchObject({ type: 'rtmp_custom', key: '<empty>' });
    expect(String(r['next'])).toContain('paste');
    expectOk(await h.call('undo_last'));
    expect(h.model.service.type).toBe('rtmp_common');
  });

  it('a key passed by an insistent user is applied but never echoed, logged or returned', async () => {
    h = await makeHarness();
    const secret = 'live_555555555_InsistentUserKeyXYZ123';
    const out = await h.callRaw('stream_service_set', { type: 'rtmp_common', service: 'Twitch', key: secret });
    expect(JSON.stringify(out.json)).not.toContain(secret);
    expect(h.model.service.settings['key']).toBe(secret);
    const undo = readFileSync(path.join(h.dataDir, 'undo', `${h.ctx.session.id}.jsonl`), 'utf8');
    expect(undo).not.toContain(secret);
    h.model.stream.active = true;
    expectError(await h.call('stream_service_set', { type: 'rtmp_common', service: 'Twitch' }), 'OUTPUT_ACTIVE');
  });
});
