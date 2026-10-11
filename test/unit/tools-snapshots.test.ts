import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DUMMY_KEY, expectError, expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

describe('snapshot_save / snapshot_list', () => {
  it('saves profile, collection and a secret-free manifest while OBS runs, with devices', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('snapshot_save', { label: 'known-good', note: 'after setup' }));
    expect(r).toMatchObject({ label: 'known-good', takenWhileRunning: true, profile: 'Untitled', sceneCollection: 'Untitled', sceneFileFlushed: true });
    expect(String(r['id'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-known-good$/);
    const dir = path.join(h.dataDir, 'snapshots', String(r['id']));
    const manifest = readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    expect(manifest).not.toContain(DUMMY_KEY);
    const m = JSON.parse(manifest);
    expect(m).toMatchObject({ obsVersion: '32.2.2', platform: 'darwin', streamService: { type: 'rtmp_common', service: 'Twitch', key: '<set>' }, scenes: ['Scene', 'Live'] });
    expect(m.devices.cameras.map((d: { name: string }) => d.name)).toContain('Elgato Facecam');
    expect(m.encoders).toContain('obs_x264');
    expect(m.inputs.find((i: { name: string }) => i.name === 'Webcam')).toMatchObject({ kind: 'macos-avcapture', scenes: ['Live'], deviceId: 'cam-facetime-uuid' });
    // Byte-exact profile copy, so a restore brings the key back.
    expect(readFileSync(path.join(dir, 'profile', 'service.json'), 'utf8')).toContain(DUMMY_KEY);
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    const list = expectOk(await h.call('snapshot_list'));
    expect((list['snapshots'] as unknown[]).length).toBe(1);
    expect((expectOk(await h.call('snapshot_list', { label: 'other' }))['snapshots'] as unknown[]).length).toBe(0);
  });

  it('flushes OBS first so websocket-only setting changes reach the copied collection', async () => {
    h = await makeHarness();
    await h.ctx.obs.connect();
    await h.ctx.obs.call('SetInputSettings', { inputName: 'Background', inputSettings: { color: 42 } });
    const before = JSON.parse(readFileSync(h.collectionFile, 'utf8'));
    expect(before.sources.find((s: { name: string }) => s.name === 'Background').settings.color).not.toBe(42);
    const r = expectOk(await h.call('snapshot_save', { label: 'flush' }));
    const copied = JSON.parse(readFileSync(path.join(h.dataDir, 'snapshots', String(r['id']), 'scenes', 'Untitled.json'), 'utf8'));
    expect(copied.sources.find((s: { name: string }) => s.name === 'Background').settings.color).toBe(42);
    expect(copied.sources.some((s: { name: string }) => s.name === '__ctrlstream_scratch')).toBe(false);
  });

  it('saves from files when OBS is closed', async () => {
    h = await makeHarness({ running: false });
    const r = expectOk(await h.call('snapshot_save', { label: 'offline' }));
    expect(r['takenWhileRunning']).toBe(false);
    const m = JSON.parse(readFileSync(path.join(h.dataDir, 'snapshots', String(r['id']), 'manifest.json'), 'utf8'));
    expect(m.devices).toBeNull();
    expect(m.inputs.map((i: { name: string }) => i.name)).toEqual(expect.arrayContaining(['Background', 'cam-bogus', 'mic-bogus']));
    expect(m.output).toMatchObject({ videoBitrateKbps: 2500, encoder: 'x264' });
  });

  it('rejects bad labels', async () => {
    h = await makeHarness();
    expectError(await h.call('snapshot_save', { label: '' }), 'INVALID_ARGUMENT');
  });
});

describe('snapshot_diff', () => {
  it('reports drift in video, output, scenes, inputs and devices against known-good', async () => {
    h = await makeHarness();
    expectOk(await h.call('snapshot_save', { label: 'known-good' }));
    h.model.video.outputWidth = 1920;
    h.model.video.outputHeight = 1080;
    h.model.params.set('SimpleOutput.VBitrate', '9000');
    h.model.addScene('BRB');
    h.model.inputs.get('Background')!.settings['color'] = 7;
    h.model.inputs.get('Webcam')!.settings['device'] = 'cam-elgato-uuid';
    h.model.listItems['macos-avcapture']!['device'] = h.model.listItems['macos-avcapture']!['device']!.filter((d) => d.itemName !== 'FaceTime HD Camera');
    const d = expectOk(await h.call('snapshot_diff'));
    expect(d['identical']).toBe(false);
    expect(d['video']).toMatchObject({ outputWidth: { then: 1280, now: 1920 } });
    expect(d['output']).toMatchObject({ videoBitrateKbps: { then: 6000, now: 9000 } });
    expect(d['scenes']).toEqual({ added: ['BRB'], removed: [] });
    const changed = (d['inputs'] as { changed: Array<Record<string, unknown>> }).changed;
    expect(changed.find((c) => c['name'] === 'Background')!['settings']).toMatchObject({ color: { then: 4281545523, now: 7 } });
    expect(changed.find((c) => c['name'] === 'Webcam')!['deviceId']).toMatchObject({ deviceId: { then: 'cam-facetime-uuid', now: 'cam-elgato-uuid' } });
    expect((d['devices'] as Record<string, unknown>)['missingNow']).toEqual({ cameras: ['FaceTime HD Camera'] });
  });

  it('identical right after saving; errors without known-good or with a bad id', async () => {
    h = await makeHarness();
    expectError(await h.call('snapshot_diff'), 'NOT_FOUND');
    const s = expectOk(await h.call('snapshot_save', { label: 'x' }));
    expect(expectOk(await h.call('snapshot_diff', { snapshotId: s['id'] as string }))['identical']).toBe(true);
    expectError(await h.call('snapshot_diff', { snapshotId: '../../etc' }), 'INVALID_ARGUMENT');
    expectError(await h.call('snapshot_diff', { snapshotId: 'nope' }), 'NOT_FOUND');
  });
});

describe('snapshot_restore', () => {
  it('restores profile and collection with OBS closed, suggests obs_launch, and undo puts the current state back', async () => {
    h = await makeHarness({ running: false });
    const s = expectOk(await h.call('snapshot_save', { label: 'known-good' }));
    const ini = path.join(h.profileDir, 'basic.ini');
    const original = readFileSync(ini, 'utf8');
    writeFileSync(ini, original.replace('VBitrate=2500', 'VBitrate=9999'));
    writeFileSync(h.collectionFile, '{"name":"Untitled","sources":[]}');
    const r = expectOk(await h.call('snapshot_restore', { snapshotId: s['id'] as string }));
    expect(r).toMatchObject({ next: 'obs_launch', launchWith: { profile: 'Untitled', collection: 'Untitled' } });
    expect(readFileSync(ini, 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(h.collectionFile, 'utf8')).sources.length).toBeGreaterThan(0);
    expect(readFileSync(path.join(h.profileDir, 'service.json'), 'utf8')).toContain(DUMMY_KEY);
    expectOk(await h.call('undo_last'));
    expect(readFileSync(ini, 'utf8')).toContain('VBitrate=9999');
    expect(readFileSync(h.collectionFile, 'utf8')).toBe('{"name":"Untitled","sources":[]}');
  });

  it('refuses while OBS runs and for unknown ids', async () => {
    h = await makeHarness();
    const s = expectOk(await h.call('snapshot_save', { label: 'a' }));
    expect(expectError(await h.call('snapshot_restore', { snapshotId: s['id'] as string }), 'OBS_RUNNING').suggestedTool).toBe('obs_quit');
    expectError(await h.call('snapshot_restore', { snapshotId: 'nope' }), 'NOT_FOUND');
  });
});

describe('backup_list and undo_last', () => {
  it('lists the session backup and history; undo walks back one change at a time', async () => {
    h = await makeHarness();
    expectOk(await h.call('scene_create', { name: 'A' }));
    expectOk(await h.call('scene_create', { name: 'B' }));
    const b = expectOk(await h.call('backup_list'));
    expect((b['backups'] as Array<Record<string, unknown>>)[0]).toMatchObject({ current: true, profile: 'Untitled', collection: 'Untitled' });
    expect(b['nextUndo']).toMatchObject({ tool: 'scene_create', seq: 2 });
    expect(expectOk(await h.call('undo_last'))['undid']).toMatchObject({ seq: 2 });
    expect(h.model.scene('B')).toBeUndefined();
    expect(h.model.scene('A')).toBeDefined();
    expectOk(await h.call('undo_last'));
    expectError(await h.call('undo_last'), 'NOTHING_TO_UNDO');
    expect(existsSync(path.join(h.dataDir, 'undo', `${h.ctx.session.id}.jsonl`))).toBe(true);
  });

  it('file undo needs OBS closed', async () => {
    h = await makeHarness({ running: false });
    expectOk(await h.call('audio_set', { sampleRate: 44100 }));
    h.proc.running = true;
    expectError(await h.call('undo_last'), 'OBS_RUNNING');
  });
});
