/**
 * Integration against a real OBS on this machine (DESIGN 8). Runs only with OBS_INTEGRATION=1
 * (`pnpm test:integration`). Needs OBS installed with its websocket enabled (obs_connect does that
 * with OBS closed). Uses only the profile and scene collection `ctrlstream-test`, creating them if
 * needed, never touches others, and removes them at the end. Recordings and ctrlstream's own data
 * go to test/integration/.scratch (git-ignored). No camera input is created, so no camera light.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../../src/context.js';
import type { Ctx } from '../../src/context.js';
import { toolByName } from '../../src/tools/index.js';
import { runTool } from '../../src/tools/registry.js';
import { ROOT, assertNoSecrets } from '../helpers.js';

const RUN = process.env['OBS_INTEGRATION'] === '1';
const NAME = 'ctrlstream-test';
const SCRATCH = path.join(ROOT, 'test', 'integration', '.scratch');
const REC = path.join(SCRATCH, 'recordings');
const T = 120_000;

let ctx: Ctx;
const log: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const out = await runTool(ctx, toolByName(name)!, args);
  const text = JSON.stringify(out.json);
  assertNoSecrets(text, name);
  log.push(`${name} ${JSON.stringify(args)} -> ${text.slice(0, 400)}`);
  return out.json;
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await call(name, args);
  if (r['ok'] !== true) throw new Error(`${name} failed: ${JSON.stringify(r)}`);
  return r;
}

/** Abort unless the test profile and collection are the active ones. */
async function guard(): Promise<void> {
  const [p, c] = await Promise.all([ctx.obs.call('GetProfileList'), ctx.obs.call('GetSceneCollectionList')]);
  if (p.currentProfileName !== NAME || c.currentSceneCollectionName !== NAME) throw new Error(`refusing to run: active profile/collection is ${p.currentProfileName}/${c.currentSceneCollectionName}`);
}

/** Wait until OBS reports the expected profile and/or collection as active. */
async function waitActive(profile: string | null, collection: string | null, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const [p, c] = await Promise.all([ctx.obs.tryCall('GetProfileList'), ctx.obs.tryCall('GetSceneCollectionList')]);
    last = `${p?.currentProfileName}/${c?.currentSceneCollectionName}`;
    if ((!profile || p?.currentProfileName === profile) && (!collection || c?.currentSceneCollectionName === collection)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`OBS did not switch to ${profile ?? '*'}/${collection ?? '*'} (still ${last})`);
}

async function newestLogText(): Promise<string> {
  const dir = ctx.paths.logsDir;
  const f = readdirSync(dir).filter((x) => x.endsWith('.txt')).map((x) => ({ x, m: statSync(path.join(dir, x)).mtimeMs })).sort((a, b) => b.m - a.m)[0]!;
  return readFileSync(path.join(dir, f.x), 'utf8');
}

describe.skipIf(!RUN)('real OBS', () => {
  beforeAll(async () => {
    mkdirSync(REC, { recursive: true });
    ctx = createContext({ dataDir: path.join(SCRATCH, 'data') });
    const st = await ok('obs_status');
    if (!st['running']) {
      await call('obs_connect'); // enables the websocket if it is off (OBS closed)
      await ok('obs_launch');
    }
    await ctx.obs.connect();
    // Collection first, then profile: OBS rescales every item of the loaded collection when the
    // canvas size changes, so the user's collection must never be loaded during a profile switch.
    const cl = await ctx.obs.call('GetSceneCollectionList');
    if (!cl.sceneCollections.includes(NAME)) await ctx.obs.call('CreateSceneCollection', { sceneCollectionName: NAME });
    else if (cl.currentSceneCollectionName !== NAME) await ctx.obs.call('SetCurrentSceneCollection', { sceneCollectionName: NAME });
    await waitActive(null, NAME);
    const pl = await ctx.obs.call('GetProfileList');
    if (!pl.profiles.includes(NAME)) await ctx.obs.call('CreateProfile', { profileName: NAME });
    else if (pl.currentProfileName !== NAME) await ctx.obs.call('SetCurrentProfile', { profileName: NAME });
    await waitActive(NAME, NAME);
    await guard();
    // Leftovers from earlier runs (never query their properties: one is a screen_capture).
    for (const i of (await ctx.obs.call('GetInputList')).inputs) await ctx.obs.call('RemoveInput', { inputName: String(i['inputName']) });
    for (const s of (await ctx.obs.call('GetSceneList')).scenes) if (s['sceneName'] !== 'Scene') await ctx.obs.tryCall('RemoveScene', { sceneName: String(s['sceneName']) });
    await ctx.obs.call('SetRecordDirectory', { recordDirectory: REC });
    for (const [n, v] of [['StreamEncoder', 'x264'], ['RecFormat2', 'hybrid_mov'], ['VBitrate', '2500'], ['RecQuality', 'Stream']]) await ctx.obs.call('SetProfileParameter', { parameterCategory: 'SimpleOutput', parameterName: n!, parameterValue: v! });
    await ctx.obs.call('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: 'rtmp://127.0.0.1:1935/live' } });
  }, T);

  afterAll(async () => {
    try {
      if (!(await ctx.proc.find())) await call('obs_launch');
      await ctx.obs.connect();
      // Profile first, then collection (see beforeAll): the user's collection is loaded only after
      // the canvas is back to its own size.
      await ctx.obs.call('SetCurrentProfile', { profileName: 'Untitled' });
      await waitActive('Untitled', null); // throws rather than load Untitled under the test canvas
      await ctx.obs.call('SetCurrentSceneCollection', { sceneCollectionName: 'Untitled' });
      await waitActive('Untitled', 'Untitled');
      await ctx.obs.call('RemoveProfile', { profileName: NAME });
      await call('obs_quit');
      // obs-websocket has no RemoveSceneCollection; delete our collection's files with OBS closed.
      for (const f of readdirSync(ctx.paths.scenesDir)) if (/^ctrlstreamtest\.json(\.bak)?$/.test(f)) rmSync(path.join(ctx.paths.scenesDir, f));
    } finally {
      mkdirSync(SCRATCH, { recursive: true });
      writeFileSync(path.join(SCRATCH, 'integration-transcript.txt'), log.join('\n'));
    }
  }, T);

  it('status, version, input kinds and encoders on the real machine', async () => {
    const st = await ok('obs_status');
    expect(st).toMatchObject({ running: true, obsVersion: '32.2.2', profile: NAME, sceneCollection: NAME });
    const kinds = await ok('input_kinds');
    const roles = Object.fromEntries((kinds['roles'] as Array<{ role: string; kind: string }>).map((r) => [r.role, r.kind]));
    expect(roles).toMatchObject({ camera: 'macos-avcapture', microphone: 'coreaudio_input_capture', display: 'screen_capture', color: 'color_source_v3', text: 'text_ft2_source_v2' });
    const enc = await ok('obs_encoders');
    expect(enc['simpleStreamEncoders']).toEqual(expect.arrayContaining(['x264', 'apple_h264']));
    expect((await ok('filter_kinds'))['kinds']).toContain('noise_suppress_filter_v2');
  }, T);

  it('device enumeration leaves nothing behind and does not crash OBS', async () => {
    const d = await ok('obs_devices');
    expect((d['cameras'] as unknown[]).length).toBeGreaterThan(0);
    expect((d['microphones'] as unknown[]).length).toBeGreaterThan(0);
    // macOS display ids now come from the OS (QA fix 1).
    expect((d['displays'] as Array<{ id: string }>)[0]!.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-/);
    expect(await ctx.proc.find()).not.toBeNull();
    const scenes = (await ctx.obs.call('GetSceneList')).scenes.map((s) => s['sceneName']);
    expect(scenes).not.toContain('__ctrlstream_scratch');
    expect((await ctx.obs.call('GetInputList')).inputs.some((i) => String(i['inputName']).startsWith('__ctrlstream'))).toBe(false);
  }, T);

  it('macOS display capture: display id from the OS, a real picture, and OBS stays up (QA fix 1)', async () => {
    await guard();
    const dev = await ok('obs_devices');
    const d0 = (dev['displays'] as Array<{ id: string; name: string }>)[0]!;
    expect(d0.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-/);
    await ok('scene_create', { name: 'Display test' });
    const r = await ok('input_create', { name: 'Display', scene: 'Display test', role: 'display' });
    expect(r['display']).toMatchObject({ uuid: d0.id });
    await new Promise((res) => setTimeout(res, 1500));
    const items = await ok('scene_items', { scene: 'Display test' });
    expect(((items['items'] as Array<{ transform: { sourceWidth: number } }>)[0]!.transform.sourceWidth)).toBeGreaterThan(0);
    // Never shown yet: black, and the tool says why.
    const before = await runTool(ctx, toolByName('screenshot')!, { source: 'Display', width: 640 });
    expect(String(before.json['note'])).toContain('scene_set_current');
    await ok('scene_set_current', { name: 'Display test' });
    await new Promise((res) => setTimeout(res, 1500));
    const shot = await runTool(ctx, toolByName('screenshot')!, { source: 'Display', width: 640 });
    const bytes = Buffer.from(shot.images[0]!.data, 'base64').length;
    log.push(`display screenshot bytes: never shown ${Buffer.from(before.images[0]!.data, 'base64').length}, after live ${bytes}`);
    expect(shot.json['note']).toBeUndefined();
    // A black 640px JPEG is about 4.8 kB; the desktop is far larger.
    expect(bytes).toBeGreaterThan(10_000);
    await ok('scene_set_current', { name: 'Scene' });
    expect(await ctx.proc.find()).not.toBeNull();
    await ok('input_properties', { name: 'Display' }); // must not crash OBS (never lists screen_capture)
    expect(await ctx.proc.find()).not.toBeNull();
    await ok('scene_remove', { name: 'Display test' });
  }, T);

  it('setup flow: scenes, sources, webcam-corner layout, screenshot', async () => {
    await guard();
    for (const s of ['Starting Soon', 'Live', 'BRB', 'Ending']) await ok('scene_create', { name: s });
    await ok('input_create', { name: 'Background', scene: 'Live', role: 'color', settings: { color: 4281545523, width: 1920, height: 1080 } });
    await ok('input_create', { name: 'Cam stand-in', scene: 'Live', role: 'color', settings: { color: 4278255360, width: 1280, height: 720 } });
    await ok('input_create', { name: 'BRB text', scene: 'BRB', role: 'text', settings: { text: 'Be right back' } });
    await ok('input_create', { name: 'Background', scene: 'BRB', addExistingToScene: true });
    const t = await ok('scene_item_transform_set', { scene: 'Live', source: 'Cam stand-in', anchor: 'bottom-right', margin: 40, widthFraction: 0.25 });
    expect(t['transform']).toMatchObject({ x: 1880, y: 1040, alignment: 'bottom-right', width: 480, height: 270 });
    await ok('scene_item_order_set', { scene: 'Live', source: 'Cam stand-in', position: 'top' });
    const items = await ok('scene_items', { scene: 'Live' });
    expect((items['items'] as Array<{ source: string }>)[0]!.source).toBe('Cam stand-in');
    const shot = await runTool(ctx, toolByName('screenshot')!, { source: 'Live', width: 640 });
    expect(shot.json['ok']).toBe(true);
    expect(shot.images[0]!.mimeType).toBe('image/jpeg');
    expect(Buffer.from(shot.images[0]!.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
    await ok('filter_add', { source: 'Cam stand-in', name: 'Colour', kind: 'color_filter_v2', settings: { saturation: 0.2 } });
    await ok('filter_set', { source: 'Cam stand-in', name: 'Colour', enabled: false });
    await ok('filter_remove', { source: 'Cam stand-in', name: 'Colour' });
    await ok('undo_last'); // filter comes back
    expect(((await ok('filter_list', { source: 'Cam stand-in' }))['filters'] as unknown[]).length).toBe(1);
  }, T);

  it('settings: video undo, output timing, recording health via test_record', async () => {
    await guard();
    await ok('video_set', { fps: 60 });
    expect((await ctx.obs.call('GetVideoSettings')).fpsNumerator).toBe(60);
    await ok('undo_last');
    expect((await ctx.obs.call('GetVideoSettings')).fpsNumerator).toBe(30);
    const o = await ok('output_set_simple', { videoBitrateKbps: 4000 });
    expect((o['changes'] as Array<{ appliesOn: string }>)[0]!.appliesOn).toBe('next_start');
    const tr = await ok('test_record', { seconds: 5 });
    expect(tr['sizeBytes'] as number).toBeGreaterThan(10_000);
    expect(String(tr['path']).startsWith(REC)).toBe(true);
    expect(await newestLogText()).toMatch(/bitrate:\s+4000/);
    const out = await ok('output_get');
    expect(out['simple']).toMatchObject({ encoder: 'x264', videoBitrateKbps: 4000, recPath: REC });
  }, T);

  it('stream service: never shows a key; Twitch default server; undo', async () => {
    await guard();
    expect(await ok('stream_service_get')).toMatchObject({ type: 'rtmp_custom', key: '<empty>' });
    const r = await ok('stream_service_set', { type: 'rtmp_common', service: 'Twitch' });
    expect(r['now']).toMatchObject({ service: 'Twitch', server: 'auto', key: '<empty>' });
    await ok('undo_last');
    expect(await ok('stream_service_get')).toMatchObject({ type: 'rtmp_custom' });
    expect(await ok('stream_status')).toMatchObject({ active: false });
    await ok('stats');
    await ok('logs_tail', { lines: 20 });
  }, T);

  it('snapshot while running flushes OBS; diff shows later changes; diagnose runs', async () => {
    await guard();
    await ok('input_settings_set', { name: 'Background', settings: { color: 4294901760 } });
    const s = await ok('snapshot_save', { label: 'known-good', note: 'integration' });
    expect(s).toMatchObject({ takenWhileRunning: true, sceneFileFlushed: true });
    const copy = JSON.parse(readFileSync(path.join(ctx.dataDir, 'snapshots', String(s['id']), 'scenes', 'ctrlstreamtest.json'), 'utf8'));
    expect(copy.sources.find((x: { name: string }) => x.name === 'Background').settings.color).toBe(4294901760);
    expect((await ok('snapshot_diff'))['identical']).toBe(true);
    await ok('scene_create', { name: 'Extra' });
    expect((await ok('snapshot_diff'))['scenes']).toEqual({ added: ['Extra'], removed: [] });
    await ok('undo_last');
    const d = await ok('diagnose');
    expect(d['obs']).toMatchObject({ running: true, version: '32.2.2' });
    expect(d['connection']).toEqual({ ok: true });
    log.push(`diagnose findings: ${JSON.stringify(d['findings'])}`);
  }, T);

  it('apply timing through the tools: StreamEncoder needs an OBS restart (DESIGN 3.3 / item 6)', async () => {
    await guard();
    const r = await ok('output_set_simple', { encoder: 'apple_h264' });
    expect((r['changes'] as Array<{ appliesOn: string }>)[0]!.appliesOn).toBe('restart');
    await ok('test_record', { seconds: 3 });
    const before = await newestLogText();
    expect(before.slice(before.lastIndexOf('==== Recording Start') - 2000)).toMatch(/x264 encoder: 'simple_video_stream'/);
    await ok('obs_quit');
    await ok('obs_launch', { profile: NAME, collection: NAME });
    await guard();
    await ok('test_record', { seconds: 3 });
    const after = await newestLogText();
    expect(after.slice(after.lastIndexOf('==== Recording Start') - 2000)).toMatch(/VideoToolbox simple_video_stream/);
    await ok('output_set_simple', { encoder: 'x264' });
  }, T);

  it('encoder OBS cannot load: evidence survives its startup rewrite to x264 (QA fix 2)', async () => {
    await guard();
    await ok('obs_quit');
    // Our own test profile: make the Simple encoder one this Mac cannot load.
    const ini = path.join(ctx.paths.profilesDir, 'ctrlstreamtest', 'basic.ini');
    writeFileSync(ini, readFileSync(ini, 'utf8').replace(/^StreamEncoder=.*$/m, 'StreamEncoder=nvenc'));
    const closed = await ok('diagnose');
    expect((closed['findings'] as Array<{ code: string }>).map((f) => f.code)).toContain('ENCODER_UNAVAILABLE');
    await ok('obs_launch', { profile: NAME, collection: NAME });
    await guard();
    // OBS rewrote it to x264 and saved it (CheckForSimpleModeX264Fallback).
    expect(readFileSync(ini, 'utf8')).toMatch(/^StreamEncoder=x264$/m);
    const live = await ok('diagnose', { checkDevices: false });
    const f = (live['findings'] as Array<{ code: string; evidence: string }>).find((x) => x.code === 'ENCODER_UNAVAILABLE');
    expect(f?.evidence).toContain("was 'nvenc' on disk while OBS was closed");
  }, T);

  it('file tools with OBS closed: audio_set, output_set_advanced, snapshot_restore, undo; then relaunch', async () => {
    const snap = (await ok('snapshot_list', { label: 'known-good' }))['snapshots'] as Array<{ id: string }>;
    await ok('scene_create', { name: 'After snapshot' });
    await ok('obs_quit');
    expect(await call('audio_set', { sampleRate: 44100 })).toMatchObject({ ok: true, sampleRate: { from: 48000, to: 44100 } });
    await ok('undo_last');
    await ok('output_set_advanced', { target: 'stream', settings: { rate_control: 'CBR', bitrate: 6000, keyint_sec: 2 } });
    await ok('undo_last');
    const ini = readFileSync(path.join(ctx.paths.profilesDir, 'ctrlstreamtest', 'basic.ini'), 'utf8');
    expect(ini).toMatch(/SampleRate=48000/);
    expect(existsSync(path.join(ctx.paths.profilesDir, 'ctrlstreamtest', 'streamEncoder.json'))).toBe(false);
    const rs = await ok('snapshot_restore', { snapshotId: snap[0]!.id });
    expect(rs['launchWith']).toEqual({ profile: NAME, collection: NAME });
    await ok('obs_launch', rs['launchWith'] as Record<string, unknown>);
    await guard();
    const scenes = (await ok('scene_list'))['scenes'] as string[];
    expect(scenes).not.toContain('After snapshot');
    expect(scenes).toEqual(expect.arrayContaining(['Live', 'BRB']));
  }, T);
});
