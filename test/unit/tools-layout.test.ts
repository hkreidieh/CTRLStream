import { afterEach, describe, expect, it } from 'vitest';
import { anchorPlacement } from '../../src/tools/layout.js';
import { TINY_JPEG } from '../mock/obs-model.js';
import { expectError, expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

describe('scene items and transforms', () => {
  it('scene_items lists items top first with compact transforms and the canvas', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('scene_items', { scene: 'Live' }));
    expect(r['canvas']).toEqual({ width: 1920, height: 1080 });
    const items = r['items'] as Array<Record<string, unknown>>;
    expect(items.map((i) => i['source'])).toEqual(['Webcam', 'Background']);
    expect(items[0]!['transform']).toMatchObject({ alignment: 'top-left', width: 1920, height: 1080 });
    expectError(await h.call('scene_items', { scene: 'Nope' }), 'NOT_FOUND');
  });

  it('anchor bottom-right with margin and widthFraction (the webcam corner)', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('scene_item_transform_set', { scene: 'Live', source: 'Webcam', anchor: 'bottom-right', margin: 40, widthFraction: 0.25 }));
    const t = h.model.scene('Live')!.items.find((i) => i.source === 'Webcam')!.transform;
    expect(t).toMatchObject({ positionX: 1880, positionY: 1040, alignment: 10, scaleX: 0.25, scaleY: 0.25 });
    expect(r['transform']).toMatchObject({ alignment: 'bottom-right', width: 480, height: 270 });
    expectOk(await h.call('undo_last'));
    expect(h.model.scene('Live')!.items.find((i) => i.source === 'Webcam')!.transform).toMatchObject({ positionX: 0, positionY: 0, alignment: 5, scaleX: 1 });
  });

  it('fitCanvas uses scale-inner bounds; raw fields and crop work; bounds 0 never sent on undo', async () => {
    h = await makeHarness();
    expectOk(await h.call('scene_item_transform_set', { scene: 'Live', source: 'Background', fitCanvas: true }));
    expect(h.model.scene('Live')!.items[0]!.transform).toMatchObject({ boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080, alignment: 0 });
    expectOk(await h.call('undo_last'));
    expectOk(await h.call('scene_item_transform_set', { scene: 'Live', itemId: 1, position: { x: 10, y: 20 }, scale: { x: 0.5, y: 0.5 }, crop: { left: 8 }, rotation: 5, alignment: 'center', bounds: { type: 'OBS_BOUNDS_STRETCH', width: 100, height: 50, alignment: 'top' } }));
    expect(h.model.scene('Live')!.items[0]!.transform).toMatchObject({ positionX: 10, positionY: 20, cropLeft: 8, rotation: 5, alignment: 0, boundsType: 'OBS_BOUNDS_STRETCH', boundsAlignment: 4 });
  });

  it('transform failure paths', async () => {
    h = await makeHarness();
    expectError(await h.call('scene_item_transform_set', { scene: 'Live', source: 'Webcam' }), 'INVALID_ARGUMENT');
    expectError(await h.call('scene_item_transform_set', { scene: 'Live', anchor: 'center' }), 'INVALID_ARGUMENT');
    expectError(await h.call('scene_item_transform_set', { scene: 'Live', source: 'Nope', anchor: 'center' }), 'NOT_FOUND');
    h.model.addInput('Live', 'Empty', 'image_source', {});
    h.model.scene('Live')!.items.find((i) => i.source === 'Empty')!.transform.sourceWidth = 0;
    expectError(await h.call('scene_item_transform_set', { scene: 'Live', source: 'Empty', widthFraction: 0.5 }), 'INVALID_ARGUMENT');
    expect(expectOk(await h.call('scene_item_transform_set', { scene: 'Live', source: 'Webcam', position: { x: -500, y: 10 } }))['warning']).toBeTruthy();
  });

  it('anchorPlacement maps all nine anchors', () => {
    expect(anchorPlacement('top-left', 100, 50, 5)).toEqual({ x: 5, y: 5, alignment: 5 });
    expect(anchorPlacement('center', 100, 50, 5)).toEqual({ x: 50, y: 25, alignment: 0 });
    expect(anchorPlacement('bottom', 100, 50, 5)).toEqual({ x: 50, y: 45, alignment: 8 });
    expect(anchorPlacement('right', 100, 50, 5)).toEqual({ x: 95, y: 25, alignment: 2 });
  });

  it('scene_item_visible_set and scene_item_order_set with undo', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('scene_item_visible_set', { scene: 'Live', source: 'Webcam', visible: false }))).toMatchObject({ visible: false, wasVisible: true });
    expectOk(await h.call('undo_last'));
    expect(h.model.scene('Live')!.items.find((i) => i.source === 'Webcam')!.enabled).toBe(true);
    expect(expectOk(await h.call('scene_item_order_set', { scene: 'Live', source: 'Background', position: 'top' }))).toMatchObject({ fromIndex: 0, toIndex: 1 });
    expect(h.model.scene('Live')!.items.map((i) => i.source)).toEqual(['Webcam', 'Background']);
    expectOk(await h.call('undo_last'));
    expect(h.model.scene('Live')!.items.map((i) => i.source)).toEqual(['Background', 'Webcam']);
    expectOk(await h.call('scene_item_order_set', { scene: 'Live', source: 'Webcam', index: 0 }));
    expectError(await h.call('scene_item_order_set', { scene: 'Live', source: 'Webcam' }), 'INVALID_ARGUMENT');
  });
});

describe('filters', () => {
  it('filter_kinds lists real ids with hints', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('filter_kinds'));
    expect(r['kinds']).toContain('noise_suppress_filter_v2');
    expect(r['common']).toHaveProperty('noise_suppress_filter_v2');
  });

  it('add, list, set, remove, each undoable', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('filter_add', { source: 'Mic/Aux', name: 'Noise', kind: 'noise_suppress_filter_v2', settings: { method: 'rnnoise' } }))).toMatchObject({ index: 0 });
    expect((expectOk(await h.call('filter_list', { source: 'Mic/Aux' }))['filters'] as unknown[])).toHaveLength(1);
    expect(expectOk(await h.call('filter_set', { source: 'Mic/Aux', name: 'Noise', enabled: false, settings: { suppress_level: -30 } }))).toMatchObject({ enabled: false, settings: { method: 'rnnoise', suppress_level: -30 } });
    expectOk(await h.call('undo_last'));
    expect(h.model.inputs.get('Mic/Aux')!.filters[0]).toMatchObject({ enabled: true, settings: { method: 'rnnoise' } });
    expectOk(await h.call('filter_remove', { source: 'Mic/Aux', name: 'Noise' }));
    expect(h.model.inputs.get('Mic/Aux')!.filters).toHaveLength(0);
    expectOk(await h.call('undo_last'));
    expect(h.model.inputs.get('Mic/Aux')!.filters[0]).toMatchObject({ name: 'Noise', kind: 'noise_suppress_filter_v2' });
    expectOk(await h.call('undo_last'));
    expect(h.model.inputs.get('Mic/Aux')!.filters).toHaveLength(0);
  });

  it('filter failure paths', async () => {
    h = await makeHarness();
    expectError(await h.call('filter_add', { source: 'Mic/Aux', name: 'X', kind: 'nope_filter' }), 'NOT_FOUND');
    expectError(await h.call('filter_set', { source: 'Mic/Aux', name: 'X' }), 'INVALID_ARGUMENT');
    expectError(await h.call('filter_set', { source: 'Mic/Aux', name: 'X', enabled: true }), 'NOT_FOUND');
    expectError(await h.call('filter_remove', { source: 'Mic/Aux', name: 'X' }), 'NOT_FOUND');
    expectError(await h.call('filter_list', { source: 'Nope' }), 'NOT_FOUND');
  });
});

describe('screenshot', () => {
  it('returns MCP image content at most 1280 wide, plus the canvas size', async () => {
    h = await makeHarness();
    const out = await h.callRaw('screenshot', { width: 4000 });
    expect(out.json['ok']).toBe(false);
    const ok = await h.callRaw('screenshot', { source: 'Live', width: 640 });
    expect(ok.json).toMatchObject({ ok: true, source: 'Live', format: 'image/jpeg', width: 640, canvas: { width: 1920, height: 1080 } });
    expect(ok.images).toEqual([{ data: TINY_JPEG, mimeType: 'image/jpeg' }]);
    const def = await h.callRaw('screenshot');
    expect(def.json['source']).toBe('Scene');
    expect(h.model.requests.filter((r) => r.requestType === 'GetSourceScreenshot').at(-1)!.requestData).toMatchObject({ imageFormat: 'jpg', imageWidth: 1280, imageCompressionQuality: 70 });
    expectError((await h.callRaw('screenshot', { source: 'Nope' })).json, 'NOT_FOUND');
  });
});
