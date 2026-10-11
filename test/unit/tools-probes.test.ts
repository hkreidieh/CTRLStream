import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinEncoderMap, loadEncoderMap } from '../../src/probes/encoders.js';
import { expectError, expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

describe('system_info', () => {
  it('returns OS, CPU, RAM, GPUs and OBS monitors when connected', async () => {
    h = await makeHarness();
    await h.ctx.obs.connect();
    const r = expectOk(await h.call('system_info'));
    expect(r['cpu']).toMatchObject({ brand: 'Apple M2 Pro' });
    expect(r['displaysFrom']).toBe('obs');
    expect((r['displays'] as unknown[])[0]).toMatchObject({ width: 1800, height: 1169 });
  });

  it('falls back to OS displays when not connected', async () => {
    h = await makeHarness({ running: false });
    expect(expectOk(await h.call('system_info'))['displaysFrom']).toBe('os');
  });
});

describe('obs_encoders', () => {
  it('lists encoders from the real log with family hints and simple ids', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('obs_encoders'));
    expect(r['logFile']).toBe('2026-10-11 01-50-57.txt');
    expect(r['simpleStreamEncoders']).toEqual(['x264', 'apple_h264', 'apple_hevc']);
    const fams = (r['families'] as Array<{ family: string }>).map((f) => f.family);
    expect(fams).toEqual(expect.arrayContaining(['x264', 'videotoolbox', 'av1']));
  });

  it('notes a GPU whose encoder is missing (driver problem)', async () => {
    h = await makeHarness({ system: { gpus: [{ vendor: 'NVIDIA', model: 'GeForce RTX 3060', vramMb: 12288, driverVersion: '560.1' }] } });
    const r = expectOk(await h.call('obs_encoders'));
    expect((r['notes'] as string[]).join(' ')).toContain('NVIDIA');
  });

  it('says what to do when no log exists yet', async () => {
    h = await makeHarness();
    rmSync(path.join(h.configDir, 'logs'), { recursive: true });
    const r = expectOk(await h.call('obs_encoders'));
    expect(r['logFile']).toBeNull();
    expect((r['notes'] as string[])[0]).toContain('obs_launch');
  });

  it('the built-in encoder table agrees with knowledge/encoders.json', async () => {
    h = await makeHarness();
    const { map, from } = await loadEncoderMap(h.ctx);
    expect(from).toBe('knowledge');
    const builtin = builtinEncoderMap();
    for (const [id, ids] of Object.entries(map)) {
      expect(builtin[id], id).toBeDefined();
      for (const l of ids) expect(builtin[id], `${id} -> ${l}`).toContain(l);
    }
    expect(Object.keys(builtin)).not.toContain('qsv_hevc');
  });
});

describe('obs_devices', () => {
  it('lists devices, cleans up the scratch scene, and never queries screen_capture lists', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('obs_devices'));
    expect((r['cameras'] as Array<{ name: string }>).map((d) => d.name)).toContain('Elgato Facecam');
    expect((r['microphones'] as Array<{ id: string }>).map((d) => d.id)).toContain('BuiltInMicrophoneDevice');
    expect((r['speakers'] as Array<{ id: string }>).map((d) => d.id)).toContain('BlackHole2ch_UID');
    // macOS displays come from the OS with the display_uuid OBS stores, never from OBS's list.
    expect((r['displays'] as Array<Record<string, unknown>>)[0]).toMatchObject({ id: '37D8832A-2D66-02CA-B9F7-8F30A301B230', name: 'Built-in Retina Display: 1800x1169 @ 0,0', main: true });
    expect(h.model.requests.some((q) => q.requestType === 'GetInputPropertiesListPropertyItems' && String(q.requestData?.['inputName']).includes('display'))).toBe(false);
    expect(h.model.crashed).toBe(false);
    expect(h.model.scenes.map((s) => s.name)).not.toContain('__ctrlstream_scratch');
    expect([...h.model.inputs.keys()].some((n) => n.startsWith('__ctrlstream'))).toBe(false);
    // Not a session mutation: no backup taken.
    expect(existsSync(path.join(h.dataDir, 'backups'))).toBe(false);
  });

  it('macOS display ids fall back to OBS monitors when the OS probe fails', async () => {
    h = await makeHarness({ displays: { list: async () => { throw new Error('osascript failed'); } } });
    const r = expectOk(await h.call('obs_devices'));
    expect((r['displays'] as Array<{ id: string }>)[0]!.id).toBe('monitor-0');
    expect((r['notes'] as string[]).join(' ')).toContain('monitor list');
    expect(h.model.crashed).toBe(false);
  });

  it('reuses an existing camera input instead of creating a probe', async () => {
    h = await makeHarness();
    await h.call('obs_devices');
    const creates = h.model.requests.filter((r) => r.requestType === 'CreateInput').map((r) => r.requestData?.['inputKind']);
    expect(creates).not.toContain('macos-avcapture');
  });

  it('cleans up even when a probe fails', async () => {
    h = await makeHarness();
    h.model.failNext('GetInputPropertiesListPropertyItems', 702, 'boom', 2);
    const r = expectOk(await h.call('obs_devices'));
    expect((r['notes'] as string[]).join(' ')).toContain('could not list');
    expect(h.model.scenes.map((s) => s.name)).not.toContain('__ctrlstream_scratch');
  });

  it('Windows lists dshow and monitor ids', async () => {
    h = await makeHarness({ platform: 'win32' });
    const r = expectOk(await h.call('obs_devices'));
    expect((r['cameras'] as Array<{ name: string }>)[0]!.name).toBe('Logitech C920');
    expect((r['displays'] as Array<{ id: string }>)[0]!.id).toContain('DISPLAY');
  });

  it('needs a connection', async () => {
    h = await makeHarness({ running: false });
    expectError(await h.call('obs_devices'), 'WEBSOCKET_UNREACHABLE');
  });
});

describe('network_test', () => {
  it('measures upload, stores it privately, and reports the 70% figure', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('network_test', { durationSeconds: 5 }));
    expect(r).toMatchObject({ uploadMbps: 20, seventyPercentKbps: 14000, endpoint: 'https://speed.cloudflare.com/__up' });
    expect(JSON.parse(readFileSync(path.join(h.dataDir, 'network.json'), 'utf8')).uploadMbps).toBe(20);
  });

  it('fails cleanly with no connectivity', async () => {
    h = await makeHarness({ network: { uploadTest: async () => ({ bytes: 0, seconds: 10, requests: 0, errors: 6 }) } });
    expectError(await h.call('network_test'), 'NETWORK_ERROR');
  });

  it('rejects out-of-range durations', async () => {
    h = await makeHarness();
    expectError(await h.call('network_test', { durationSeconds: 60 }), 'INVALID_ARGUMENT');
  });
});
