import { afterEach, describe, expect, it } from 'vitest';
import { expectError, expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

describe('scenes', () => {
  it('scene_list in UI order with the live scene', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('scene_list'))).toMatchObject({ current: 'Scene', scenes: ['Scene', 'Live'] });
  });

  it('scene_create, duplicate refusal, undo removes it', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('scene_create', { name: 'BRB' }));
    expect(r['scenes']).toEqual(['Scene', 'Live', 'BRB']);
    expect(r['sessionBackup']).toMatchObject({ created: true });
    expectError(await h.call('scene_create', { name: 'BRB' }), 'ALREADY_EXISTS');
    expectOk(await h.call('undo_last'));
    expect(h.model.scenes.map((s) => s.name)).not.toContain('BRB');
  });

  it('scene_remove deletes its only-here sources; undo brings scene, items, transforms and sources back', async () => {
    h = await makeHarness();
    h.model.scene('Live')!.items[0]!.transform.positionX = 123;
    const r = expectOk(await h.call('scene_remove', { name: 'Live' }));
    expect(r['itemsRemoved']).toEqual(['Background', 'Webcam']);
    expect(h.model.inputs.has('Background')).toBe(false);
    expectOk(await h.call('undo_last'));
    const live = h.model.scene('Live')!;
    expect(live.items.map((i) => i.source)).toEqual(['Background', 'Webcam']);
    expect(live.items[0]!.transform.positionX).toBe(123);
    expect(h.model.inputs.get('Background')!.settings).toMatchObject({ color: 4281545523 });
  });

  it('scene_remove of an unknown scene and of the last scene fail', async () => {
    h = await makeHarness();
    expectError(await h.call('scene_remove', { name: 'Nope' }), 'NOT_FOUND');
    await h.call('scene_remove', { name: 'Live' });
    expect(expectError(await h.call('scene_remove', { name: 'Scene' })).code).toBe('OBS_REQUEST_FAILED');
  });

  it('scene_set_current and undo', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('scene_set_current', { name: 'Live' }))).toMatchObject({ current: 'Live', previous: 'Scene' });
    expectOk(await h.call('undo_last'));
    expect(h.model.program).toBe('Scene');
    expectError(await h.call('scene_set_current', { name: 'Nope' }), 'NOT_FOUND');
  });
});

describe('inputs', () => {
  it('input_kinds resolves roles for this machine', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('input_kinds'));
    const cam = (r['roles'] as Array<{ role: string; kind: string }>).find((x) => x.role === 'camera')!;
    expect(cam.kind).toBe('macos-avcapture');
  });

  it('input_list shows kinds, scenes and audio state', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('input_list'));
    const mic = (r['inputs'] as Array<Record<string, unknown>>).find((i) => i['name'] === 'Mic/Aux')!;
    expect(mic).toMatchObject({ kind: 'coreaudio_input_capture', scenes: [], audio: { muted: false, volumeDb: 0, monitoring: 'none' } });
    const bg = (r['inputs'] as Array<Record<string, unknown>>).find((i) => i['name'] === 'Background')!;
    expect(bg['audio']).toBeUndefined();
    expect((expectOk(await h.call('input_list', { scene: 'Live' }))['inputs'] as unknown[]).length).toBe(2);
    expectError(await h.call('input_list', { scene: 'Nope' }), 'NOT_FOUND');
  });

  it('input_create by role with a device id, then undo', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('input_create', { name: 'Cam 2', scene: 'Live', role: 'camera', deviceId: 'cam-elgato-uuid' }));
    expect(r).toMatchObject({ kind: 'macos-avcapture', deviceProperty: 'device', deviceId: 'cam-elgato-uuid' });
    expect(h.model.inputs.get('Cam 2')!.settings).toEqual({ device: 'cam-elgato-uuid' });
    expectOk(await h.call('undo_last'));
    expect(h.model.inputs.has('Cam 2')).toBe(false);
  });

  it('input_create by kind resolves the version; display role gets SCK type 0', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('input_create', { name: 'Card', scene: 'Live', kind: 'color_source', settings: { color: 1 } }))['kind']).toBe('color_source_v3');
    expectOk(await h.call('input_create', { name: 'Screen', scene: 'Live', role: 'display' }));
    // macOS: the display is chosen from the OS (OBS's primary monitor), so the capture is not black.
    expect(h.model.inputs.get('Screen')!.settings).toEqual({ type: 0, display_uuid: '37D8832A-2D66-02CA-B9F7-8F30A301B230' });
  });

  it('input_create failure paths', async () => {
    h = await makeHarness();
    expectError(await h.call('input_create', { name: 'X', scene: 'Live' }), 'INVALID_ARGUMENT');
    expectError(await h.call('input_create', { name: 'X', scene: 'Live', role: 'camera', kind: 'dshow_input' }), 'INVALID_ARGUMENT');
    expectError(await h.call('input_create', { name: 'X', scene: 'Live', role: 'game' }), 'UNSUPPORTED');
    expectError(await h.call('input_create', { name: 'X', scene: 'Live', kind: 'nope' }), 'NOT_FOUND');
    expectError(await h.call('input_create', { name: 'X', scene: 'Nope', role: 'color' }), 'NOT_FOUND');
    expectError(await h.call('input_create', { name: 'X', scene: 'Live', role: 'color', deviceId: 'd' }), 'INVALID_ARGUMENT');
    expectError(await h.call('input_create', { name: 'X', scene: 'Live', role: 'display', deviceId: 'monitor-0' }), 'INVALID_ARGUMENT');
    expectError(await h.call('input_create', { name: 'Webcam', scene: 'Scene', role: 'camera' }), 'ALREADY_EXISTS');
  });

  it('input_create addExistingToScene puts the same source in another scene; undo removes only that item', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('input_create', { name: 'Webcam', scene: 'Scene', addExistingToScene: true }));
    expect(r['reusedExisting']).toBe(true);
    expect(h.model.scene('Scene')!.items.map((i) => i.source)).toEqual(['Webcam']);
    expectOk(await h.call('undo_last'));
    expect(h.model.scene('Scene')!.items).toHaveLength(0);
    expect(h.model.scene('Live')!.items.map((i) => i.source)).toContain('Webcam');
  });

  it('input_remove removes everywhere; undo recreates with settings and audio', async () => {
    h = await makeHarness();
    h.model.inputs.get('Webcam')!.volumeDb = -6;
    expect(expectOk(await h.call('input_remove', { name: 'Webcam' }))).toMatchObject({ fromScenes: ['Live'] });
    expectOk(await h.call('undo_last'));
    const w = h.model.inputs.get('Webcam')!;
    expect(w.settings).toEqual({ device: 'cam-facetime-uuid' });
    expect(w.volumeDb).toBe(-6);
    expectError(await h.call('input_remove', { name: 'Nope' }), 'NOT_FOUND');
  });

  it('input_remove of a scene-less global input can be undone into the live scene', async () => {
    h = await makeHarness();
    expectOk(await h.call('input_remove', { name: 'Mic/Aux' }));
    expectOk(await h.call('undo_last'));
    expect(h.model.inputs.get('Mic/Aux')!.settings).toEqual({ device_id: 'default' });
  });

  it('input_settings_get / set (overlay and replace) with exact undo', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('input_settings_get', { name: 'Background', includeDefaults: true }))).toMatchObject({ kind: 'color_source_v3', settings: { color: 4281545523 }, defaults: { color: 4291940817 } });
    expect(expectOk(await h.call('input_settings_set', { name: 'Background', settings: { color: 1 } }))['settings']).toEqual({ color: 1, width: 1920, height: 1080 });
    expectOk(await h.call('input_settings_set', { name: 'Background', settings: { color: 2 }, replace: true }));
    expect(h.model.inputs.get('Background')!.settings).toEqual({ color: 2 });
    expectOk(await h.call('undo_last'));
    expectOk(await h.call('undo_last'));
    expect(h.model.inputs.get('Background')!.settings).toEqual({ color: 4281545523, width: 1920, height: 1080 });
    expectError(await h.call('input_settings_set', { name: 'Nope', settings: {} }), 'NOT_FOUND');
    expectError(await h.call('input_settings_get', { name: 'Nope' }), 'NOT_FOUND');
  });

  it('input_properties lists device options, and skips list queries that crash OBS', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('input_properties', { name: 'Webcam' }));
    const dev = (r['properties'] as Array<Record<string, unknown>>).find((p) => p['property'] === 'device')!;
    expect((dev['options'] as Array<{ name: string }>).map((o) => o.name)).toContain('Elgato Facecam');
    h.model.addInput('Live', 'Screen', 'screen_capture', { type: 0 });
    const s = expectOk(await h.call('input_properties', { name: 'Screen' }));
    expect(s['note']).toBeTruthy();
    expect(h.model.crashed).toBe(false);
  });

  it('input_audio_set changes only given fields, maps monitoring, undo restores', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('input_audio_set', { name: 'Mic/Aux', volumeDb: -3, muted: true, monitoring: 'monitor_only', syncOffsetMs: 120 }));
    expect(r['changed']).toMatchObject({ volumeDb: { from: 0, to: -3 }, muted: { from: false, to: true }, monitoring: { from: 'none', to: 'monitor_only' }, syncOffsetMs: { from: 0, to: 120 } });
    expect(h.model.inputs.get('Mic/Aux')!.monitorType).toBe('OBS_MONITORING_TYPE_MONITOR_ONLY');
    expectOk(await h.call('undo_last'));
    expect(h.model.inputs.get('Mic/Aux')).toMatchObject({ volumeDb: 0, muted: false, monitorType: 'OBS_MONITORING_TYPE_NONE', syncOffset: 0 });
    expectError(await h.call('input_audio_set', { name: 'Mic/Aux' }), 'INVALID_ARGUMENT');
    expectError(await h.call('input_audio_set', { name: 'Mic/Aux', volumeDb: 40 }), 'INVALID_ARGUMENT');
    expectError(await h.call('input_audio_set', { name: 'Background', muted: true }), 'OBS_REQUEST_FAILED');
  });
});
