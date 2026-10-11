/** Layout and look: scene items, transforms, filters, screenshots. */
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ToolError } from '../errors.js';
import { mutate } from '../safety/mutate.js';
import { ALIGN, ALIGN_NAMES, assertScene, compactTransform, requireConnection, resolveItem, writableTransform } from './common.js';
import { defineTool, withImages } from './registry.js';

const BOUNDS = ['OBS_BOUNDS_NONE', 'OBS_BOUNDS_STRETCH', 'OBS_BOUNDS_SCALE_INNER', 'OBS_BOUNDS_SCALE_OUTER', 'OBS_BOUNDS_SCALE_TO_WIDTH', 'OBS_BOUNDS_SCALE_TO_HEIGHT', 'OBS_BOUNDS_MAX_ONLY'] as const;
const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;
type Anchor = (typeof ANCHORS)[number];

const itemRef = {
  scene: z.string().min(1),
  source: z.string().min(1).optional().describe('Source name in the scene'),
  itemId: z.number().int().min(0).optional().describe('Scene item id from scene_items'),
};

async function canvas(ctx: Ctx): Promise<{ width: number; height: number }> {
  const v = await ctx.obs.call('GetVideoSettings');
  return { width: v.baseWidth, height: v.baseHeight };
}

export const sceneItems = defineTool({
  name: 'scene_items',
  title: 'Items in a scene',
  description: 'The sources placed in a scene, top of the list first, with id, kind, visibility, lock, and transform (position, size in canvas pixels, scale, alignment, bounds, crop) plus the canvas size. Use before moving things with scene_item_transform_set. Changes nothing.',
  input: { scene: z.string().min(1) },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    await assertScene(ctx, args.scene);
    const { sceneItems: items } = await ctx.obs.call('GetSceneItemList', { sceneName: args.scene });
    return {
      scene: args.scene,
      canvas: await canvas(ctx),
      items: [...items]
        .sort((a, b) => Number(b['sceneItemIndex']) - Number(a['sceneItemIndex']))
        .map((i) => ({
          id: i['sceneItemId'],
          source: i['sourceName'],
          kind: i['inputKind'] ?? (i['isGroup'] ? 'group' : 'scene'),
          index: i['sceneItemIndex'],
          visible: i['sceneItemEnabled'],
          locked: i['sceneItemLocked'],
          transform: compactTransform((i['sceneItemTransform'] as Record<string, unknown>) ?? {}),
        })),
    };
  },
});

/** Where an anchor puts the item's reference point, and which alignment makes that point the item corner. */
export function anchorPlacement(anchor: Anchor, w: number, h: number, margin: number): { x: number; y: number; alignment: number } {
  const col = anchor.includes('left') ? 'left' : anchor.includes('right') ? 'right' : 'center';
  const row = anchor.startsWith('top') ? 'top' : anchor.startsWith('bottom') ? 'bottom' : 'center';
  const x = col === 'left' ? margin : col === 'right' ? w - margin : w / 2;
  const y = row === 'top' ? margin : row === 'bottom' ? h - margin : h / 2;
  const alignment = (col === 'left' ? ALIGN.left : col === 'right' ? ALIGN.right : 0) | (row === 'top' ? ALIGN.top : row === 'bottom' ? ALIGN.bottom : 0);
  return { x, y, alignment };
}

export const sceneItemTransformSet = defineTool({
  name: 'scene_item_transform_set',
  title: 'Move, resize or crop an item',
  description:
    'Place a source in a scene. Easiest: anchor (top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right) with margin in canvas pixels and widthFraction (share of canvas width, e.g. 0.25 for a webcam in the corner), or fitCanvas: true to fill the canvas keeping aspect (for game or display capture). Raw fields (position, scale, bounds, crop, alignment, rotation) are also accepted and override the helpers. Coordinates are canvas pixels (scene_items shows the canvas size). Check with screenshot afterwards. Undoable.',
  input: {
    ...itemRef,
    anchor: z.enum(ANCHORS).optional(),
    margin: z.number().min(0).max(2000).optional().describe('Canvas pixels from the anchored edges, default 0'),
    widthFraction: z.number().min(0.02).max(1).optional(),
    fitCanvas: z.boolean().optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    scale: z.object({ x: z.number().positive(), y: z.number().positive() }).optional(),
    alignment: z.enum(ALIGN_NAMES as [string, ...string[]]).optional(),
    rotation: z.number().min(-360).max(360).optional(),
    bounds: z.object({ type: z.enum(BOUNDS), width: z.number().min(1).optional(), height: z.number().min(1).optional(), alignment: z.enum(ALIGN_NAMES as [string, ...string[]]).optional() }).optional(),
    crop: z.object({ left: z.number().int().min(0).optional(), right: z.number().int().min(0).optional(), top: z.number().int().min(0).optional(), bottom: z.number().int().min(0).optional() }).optional(),
  },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    await assertScene(ctx, args.scene);
    const item = await resolveItem(ctx, args.scene, args.source, args.itemId);
    const cv = await canvas(ctx);
    const cur = (await ctx.obs.call('GetSceneItemTransform', { sceneName: args.scene, sceneItemId: item.id })).sceneItemTransform as Record<string, unknown>;
    const t: Record<string, unknown> = {};
    const cropL = args.crop?.left ?? Number(cur['cropLeft'] ?? 0);
    const cropR = args.crop?.right ?? Number(cur['cropRight'] ?? 0);
    const cropT = args.crop?.top ?? Number(cur['cropTop'] ?? 0);
    const cropB = args.crop?.bottom ?? Number(cur['cropBottom'] ?? 0);
    const srcW = Number(cur['sourceWidth'] ?? 0) - cropL - cropR;
    const srcH = Number(cur['sourceHeight'] ?? 0) - cropT - cropB;
    if (args.fitCanvas) {
      Object.assign(t, { positionX: cv.width / 2, positionY: cv.height / 2, alignment: ALIGN.center, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: cv.width, boundsHeight: cv.height, boundsAlignment: ALIGN.center });
    }
    if (args.widthFraction !== undefined) {
      if (srcW <= 0) throw new ToolError('INVALID_ARGUMENT', `'${item.source}' reports no size yet (a camera may still be starting), so widthFraction cannot be computed.`, 'Wait a moment and retry, or use bounds with a width and height instead.');
      const s = (cv.width * args.widthFraction) / srcW;
      Object.assign(t, { scaleX: s, scaleY: s, boundsType: 'OBS_BOUNDS_NONE' });
    }
    if (args.anchor) {
      const p = anchorPlacement(args.anchor, cv.width, cv.height, args.margin ?? 0);
      Object.assign(t, { positionX: p.x, positionY: p.y, alignment: p.alignment });
      if (args.fitCanvas) t['boundsAlignment'] = p.alignment;
    }
    if (args.position) Object.assign(t, { positionX: args.position.x, positionY: args.position.y });
    if (args.scale) Object.assign(t, { scaleX: args.scale.x, scaleY: args.scale.y });
    if (args.alignment) t['alignment'] = ALIGN[args.alignment as keyof typeof ALIGN];
    if (args.rotation !== undefined) t['rotation'] = args.rotation;
    if (args.bounds) {
      t['boundsType'] = args.bounds.type;
      if (args.bounds.width !== undefined) t['boundsWidth'] = args.bounds.width;
      if (args.bounds.height !== undefined) t['boundsHeight'] = args.bounds.height;
      if (args.bounds.alignment) t['boundsAlignment'] = ALIGN[args.bounds.alignment as keyof typeof ALIGN];
    }
    if (args.crop) Object.assign(t, { cropLeft: cropL, cropRight: cropR, cropTop: cropT, cropBottom: cropB });
    if (Object.keys(t).length === 0) throw new ToolError('INVALID_ARGUMENT', 'Nothing to change.', 'Give anchor, widthFraction, fitCanvas, position, scale, alignment, rotation, bounds or crop.');
    const after = await mutate(ctx, {
      tool: 'scene_item_transform_set',
      args,
      before: async () => cur,
      apply: async () => {
        await ctx.obs.call('SetSceneItemTransform', { sceneName: args.scene, sceneItemId: item.id, sceneItemTransform: t as never });
        return (await ctx.obs.call('GetSceneItemTransform', { sceneName: args.scene, sceneItemId: item.id })).sceneItemTransform as Record<string, unknown>;
      },
      after: async (r) => r,
      inverse: (b) => ({ kind: 'ws', requests: [{ requestType: 'SetSceneItemTransform', requestData: { sceneName: args.scene, sceneItemId: item.id, sceneItemTransform: writableTransform(b) } }] }),
    });
    const ct = compactTransform(after);
    const offCanvas = typeof after['positionX'] === 'number' && (Number(after['positionX']) < 0 || Number(after['positionX']) > cv.width || Number(after['positionY']) < 0 || Number(after['positionY']) > cv.height);
    return { scene: args.scene, source: item.source, itemId: item.id, canvas: cv, transform: ct, ...(offCanvas ? { warning: 'The reference point is outside the canvas; the item may be invisible.' } : {}), next: 'screenshot' };
  },
});

export const sceneItemVisibleSet = defineTool({
  name: 'scene_item_visible_set',
  title: 'Show or hide an item',
  description: 'Show or hide a source in one scene (the eye icon in OBS), for example hide the webcam on the BRB scene. Hidden sources stay in the scene and keep their position. Affects viewers at once if the scene is live. Check with screenshot. Undoable.',
  input: { ...itemRef, visible: z.boolean() },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    await assertScene(ctx, args.scene);
    const item = await resolveItem(ctx, args.scene, args.source, args.itemId);
    const before = await mutate(ctx, {
      tool: 'scene_item_visible_set',
      args,
      before: async () => (await ctx.obs.call('GetSceneItemEnabled', { sceneName: args.scene, sceneItemId: item.id })).sceneItemEnabled,
      apply: async (b) => {
        await ctx.obs.call('SetSceneItemEnabled', { sceneName: args.scene, sceneItemId: item.id, sceneItemEnabled: args.visible });
        return b;
      },
      inverse: (b) => ({ kind: 'ws', requests: [{ requestType: 'SetSceneItemEnabled', requestData: { sceneName: args.scene, sceneItemId: item.id, sceneItemEnabled: b } }] }),
    });
    return { scene: args.scene, source: item.source, visible: args.visible, wasVisible: before };
  },
});

export const sceneItemOrderSet = defineTool({
  name: 'scene_item_order_set',
  title: 'Bring forward or send back',
  description: "Change stacking order: top (in front of everything), bottom (behind everything), up or down one step, or an exact index (0 = bottom). For example put the webcam on top of the game capture. Undoable.",
  input: { ...itemRef, position: z.enum(['top', 'bottom', 'up', 'down']).optional(), index: z.number().int().min(0).optional() },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    await assertScene(ctx, args.scene);
    if (!!args.position === (args.index !== undefined)) throw new ToolError('INVALID_ARGUMENT', 'Give exactly one of position or index.', 'position: top | bottom | up | down.');
    const item = await resolveItem(ctx, args.scene, args.source, args.itemId);
    const { sceneItems: items } = await ctx.obs.call('GetSceneItemList', { sceneName: args.scene });
    const max = items.length - 1;
    const cur = (await ctx.obs.call('GetSceneItemIndex', { sceneName: args.scene, sceneItemId: item.id })).sceneItemIndex;
    const target = args.index !== undefined ? Math.min(args.index, max) : args.position === 'top' ? max : args.position === 'bottom' ? 0 : args.position === 'up' ? Math.min(cur + 1, max) : Math.max(cur - 1, 0);
    await mutate(ctx, {
      tool: 'scene_item_order_set',
      args,
      apply: () => ctx.obs.call('SetSceneItemIndex', { sceneName: args.scene, sceneItemId: item.id, sceneItemIndex: target }),
      inverse: () => ({ kind: 'ws', requests: [{ requestType: 'SetSceneItemIndex', requestData: { sceneName: args.scene, sceneItemId: item.id, sceneItemIndex: cur } }] }),
    });
    return { scene: args.scene, source: item.source, fromIndex: cur, toIndex: target, topIndex: max };
  },
});

// ----- filters -------------------------------------------------------------------------------

export const filterList = defineTool({
  name: 'filter_list',
  title: 'List filters',
  description: 'Filters on a source or scene (noise suppression, compressor, color correction, chroma key...), in order, with kind, enabled and settings. Changes nothing.',
  input: { source: z.string().min(1) },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const { filters } = await ctx.obs.call('GetSourceFilterList', { sourceName: args.source });
    return { source: args.source, filters: filters.map((f) => ({ name: f['filterName'], kind: f['filterKind'], enabled: f['filterEnabled'], index: f['filterIndex'], settings: f['filterSettings'] })) };
  },
});

const FILTER_HINTS: Record<string, string> = {
  noise_suppress_filter_v2: 'Microphone: removes background noise (RNNoise or NVIDIA).',
  noise_gate_filter: 'Microphone: silences the mic below a threshold.',
  compressor_filter: 'Microphone: evens out loud and quiet speech.',
  limiter_filter: 'Microphone: hard ceiling against clipping.',
  gain_filter: 'Audio: louder or quieter in dB.',
  color_filter_v2: 'Video: brightness, contrast, saturation.',
  chroma_key_filter_v2: 'Camera: green screen removal.',
  crop_filter: 'Video: crop or pad edges.',
  sharpness_filter_v2: 'Video: sharpen a soft camera.',
  scale_filter: 'Video: scaling method and resolution.',
  mask_filter_v2: 'Video: image mask or blend.',
  async_delay_filter: 'Video: delay a camera to match audio.',
};

export const filterKinds = defineTool({
  name: 'filter_kinds',
  title: 'Filter kinds',
  description: 'The filter kinds this OBS offers (exact ids for filter_add), with a one-line hint for the common ones. On OBS 32 noise suppression is noise_suppress_filter_v2. Changes nothing.',
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    await requireConnection(ctx);
    const { sourceFilterKinds } = await ctx.obs.call('GetSourceFilterKindList');
    return { kinds: sourceFilterKinds, common: Object.fromEntries(Object.entries(FILTER_HINTS).filter(([k]) => sourceFilterKinds.includes(k))) };
  },
});

export const filterAdd = defineTool({
  name: 'filter_add',
  title: 'Add filter',
  description:
    'Add a filter to a source or scene, e.g. noise_suppress_filter_v2 or compressor_filter on a microphone, color_filter_v2 or chroma_key_filter_v2 on a camera. kind must be one OBS offers (filter_kinds lists them). Settings are optional; defaults apply otherwise. Check with screenshot (video) or ask the user to listen (audio). Undoable.',
  input: { source: z.string().min(1), name: z.string().min(1), kind: z.string().min(1), settings: z.record(z.string(), z.unknown()).optional() },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const { sourceFilterKinds } = await ctx.obs.call('GetSourceFilterKindList');
    if (!sourceFilterKinds.includes(args.kind)) throw new ToolError('NOT_FOUND', `This OBS has no filter kind '${args.kind}'.`, `Available: ${sourceFilterKinds.join(', ')}.`);
    await mutate(ctx, {
      tool: 'filter_add',
      args,
      apply: () => ctx.obs.call('CreateSourceFilter', { sourceName: args.source, filterName: args.name, filterKind: args.kind, ...(args.settings ? { filterSettings: args.settings as never } : {}) }),
      inverse: () => ({ kind: 'ws', requests: [{ requestType: 'RemoveSourceFilter', requestData: { sourceName: args.source, filterName: args.name } }] }),
    });
    const f = await ctx.obs.call('GetSourceFilter', { sourceName: args.source, filterName: args.name });
    return { source: args.source, filter: args.name, kind: args.kind, index: f.filterIndex, settings: f.filterSettings };
  },
});

export const filterSet = defineTool({
  name: 'filter_set',
  title: 'Change filter',
  description: "Change a filter's settings (only the given keys unless replace: true) and/or enable or disable it, for example lower a noise suppression level or switch a chroma key off. filter_list shows current values. Check by screenshot for video or by asking the user to listen for audio. Undoable.",
  input: { source: z.string().min(1), name: z.string().min(1), settings: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional(), replace: z.boolean().optional() },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    if (!args.settings && args.enabled === undefined) throw new ToolError('INVALID_ARGUMENT', 'Nothing to change.', 'Give settings and/or enabled.');
    const result = await mutate(ctx, {
      tool: 'filter_set',
      args,
      before: () => ctx.obs.call('GetSourceFilter', { sourceName: args.source, filterName: args.name }),
      apply: async () => {
        if (args.settings) await ctx.obs.call('SetSourceFilterSettings', { sourceName: args.source, filterName: args.name, filterSettings: args.settings as never, overlay: !args.replace });
        if (args.enabled !== undefined) await ctx.obs.call('SetSourceFilterEnabled', { sourceName: args.source, filterName: args.name, filterEnabled: args.enabled });
        return ctx.obs.call('GetSourceFilter', { sourceName: args.source, filterName: args.name });
      },
      after: async (r) => r,
      inverse: (b) => ({
        kind: 'ws',
        requests: [
          { requestType: 'SetSourceFilterSettings', requestData: { sourceName: args.source, filterName: args.name, filterSettings: b.filterSettings, overlay: false } },
          { requestType: 'SetSourceFilterEnabled', requestData: { sourceName: args.source, filterName: args.name, filterEnabled: b.filterEnabled } },
        ],
      }),
    });
    return { source: args.source, filter: args.name, enabled: result.filterEnabled, settings: result.filterSettings };
  },
});

export const filterRemove = defineTool({
  name: 'filter_remove',
  title: 'Remove filter',
  description: 'Remove a filter from a source or scene, for example a colour filter that made the camera look wrong. Use filter_set enabled: false instead to just switch it off. undo_last puts it back with the same settings and position in the filter chain.',
  input: { source: z.string().min(1), name: z.string().min(1) },
  mutating: true,
  fileWriting: false,
  annotations: { destructiveHint: true },
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const before = await mutate(ctx, {
      tool: 'filter_remove',
      args,
      before: () => ctx.obs.call('GetSourceFilter', { sourceName: args.source, filterName: args.name }),
      apply: async (b) => {
        await ctx.obs.call('RemoveSourceFilter', { sourceName: args.source, filterName: args.name });
        return b;
      },
      inverse: (b) => ({
        kind: 'ws',
        requests: [
          { requestType: 'CreateSourceFilter', requestData: { sourceName: args.source, filterName: args.name, filterKind: b.filterKind, filterSettings: b.filterSettings } },
          { requestType: 'SetSourceFilterIndex', requestData: { sourceName: args.source, filterName: args.name, filterIndex: b.filterIndex } },
          { requestType: 'SetSourceFilterEnabled', requestData: { sourceName: args.source, filterName: args.name, filterEnabled: b.filterEnabled } },
        ],
      }),
    });
    return { source: args.source, removed: args.name, kind: before.filterKind };
  },
});

// ----- screenshot ----------------------------------------------------------------------------

export const screenshot = defineTool({
  name: 'screenshot',
  title: 'Screenshot',
  description:
    'A picture of what a scene or source looks like right now, returned as an image (JPEG, at most 1280 px wide) plus the canvas size. Default: the live scene. Use after every layout change to check placement, and to confirm a camera or capture shows something (black usually means a missing device or, on macOS, missing Screen Recording permission). Changes nothing.',
  input: { source: z.string().min(1).optional().describe('Scene or input name; default the live scene'), width: z.number().int().min(64).max(1280).optional() },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const source = args.source ?? (await ctx.obs.call('GetCurrentProgramScene')).currentProgramSceneName;
    const formats = (await ctx.obs.version()).supportedImageFormats;
    const fmt = ['jpg', 'jpeg', 'png'].find((f) => formats.includes(f)) ?? formats[0];
    if (!fmt) throw new ToolError('UNSUPPORTED', 'OBS reports no screenshot formats.', 'Screenshots are unavailable on this OBS build.');
    const width = Math.min(args.width ?? 1280, 1280);
    const r = await ctx.obs.call('GetSourceScreenshot', { sourceName: source, imageFormat: fmt, imageWidth: width, imageCompressionQuality: fmt === 'png' ? -1 : 70 });
    const m = /^data:image\/([a-z]+);base64,(.*)$/s.exec(r.imageData);
    const data = m ? m[2]! : r.imageData;
    const mimeType = fmt === 'png' ? 'image/png' : 'image/jpeg';
    const notShown = await screenCapturesNeverShown(ctx, source);
    return withImages(
      {
        source,
        format: mimeType,
        width,
        canvas: await canvas(ctx),
        bytes: Math.round((data.length * 3) / 4),
        ...(notShown.length
          ? { note: `${notShown.join(', ')} ${notShown.length === 1 ? 'is' : 'are'} black here because macOS screen capture only delivers frames once the source has been shown in the live scene. Switch to its scene with scene_set_current (warn the user if they are live), then screenshot again.` }
          : {}),
      },
      [{ data, mimeType }],
    );
  },
});

/**
 * Black-image probe for macOS screen captures: a JPEG (quality 70) of the capture source alone,
 * 160 px wide. Calibrated on the real OBS 32.2.2 / macOS 26.2 (2026-10-11), bytes at 160 / 1280 px:
 *   display capture never shown (black) 907 / 17,267   empty scene (black) 867 / 15,027
 *   dark colour + text scene          1,388 / 21,939   display showing the desktop 3,751-4,669 / 85-114 kB
 * At 1280 px black and a dark text scene are only 1.27x apart, so the probe uses 160 px of the
 * capture source itself, where black (<= 907) and content (>= 3,751) are 4x apart. 1,100 bytes sits
 * above black with about 20% headroom and below the dark text scene.
 */
export const BLACK_PROBE = { width: 160, quality: 70, maxBytes: 1100 } as const;

/** Mark the screen captures of a scene as shown (it just went live; they keep their picture). */
export async function markScreenCapturesShown(ctx: Ctx, scene: string): Promise<void> {
  if (ctx.paths.platform !== 'darwin') return;
  const pid = (await ctx.proc.find())?.pid ?? 0;
  const items = (await ctx.obs.tryCall('GetSceneItemList', { sceneName: scene }))?.sceneItems ?? [];
  for (const i of items) if (i['inputKind'] === 'screen_capture') ctx.session.shownScreenCaptures.add(`${pid}:${String(i['sourceName'])}`);
}

/**
 * macOS ScreenCaptureKit captures (screen_capture) render black until they have been active (shown
 * in the program) once. Verified on the real OBS: 4.8 kB black JPEG while never shown, 47 kB picture
 * once its scene had been live, and still a picture after switching away. So a capture counts as
 * "black because never shown" only when all hold: not active now, not seen live in this session
 * (for this OBS process), and a small probe image of it is effectively black (BLACK_PROBE).
 */
async function screenCapturesNeverShown(ctx: Ctx, source: string): Promise<string[]> {
  if (ctx.paths.platform !== 'darwin') return [];
  const inputs = (await ctx.obs.tryCall('GetInputList'))?.inputs ?? [];
  const kindOf = new Map(inputs.map((i) => [String(i['inputName']), String(i['inputKind'])]));
  let names: string[] = [];
  if (kindOf.get(source) === 'screen_capture') names = [source];
  else {
    const items = (await ctx.obs.tryCall('GetSceneItemList', { sceneName: source }))?.sceneItems ?? [];
    names = items.filter((i) => i['inputKind'] === 'screen_capture' && i['sceneItemEnabled']).map((i) => String(i['sourceName']));
  }
  if (names.length === 0) return [];
  const pid = (await ctx.proc.find())?.pid ?? 0;
  const formats = (await ctx.obs.version()).supportedImageFormats;
  const fmt = ['jpg', 'jpeg'].find((f) => formats.includes(f));
  const out: string[] = [];
  for (const n of names) {
    const key = `${pid}:${n}`;
    const a = await ctx.obs.tryCall('GetSourceActive', { sourceName: n });
    if (a?.videoActive) {
      ctx.session.shownScreenCaptures.add(key);
      continue;
    }
    if (ctx.session.shownScreenCaptures.has(key) || !fmt) continue;
    const probe = await ctx.obs.tryCall('GetSourceScreenshot', { sourceName: n, imageFormat: fmt, imageWidth: BLACK_PROBE.width, imageCompressionQuality: BLACK_PROBE.quality });
    const b64 = probe?.imageData.replace(/^data:image\/[a-z]+;base64,/, '') ?? '';
    const bytes = Math.floor((b64.length * 3) / 4);
    if (probe && bytes < BLACK_PROBE.maxBytes) out.push(`'${n}'`);
  }
  return out;
}

export const layoutTools = [sceneItems, sceneItemTransformSet, sceneItemVisibleSet, sceneItemOrderSet, filterKinds, filterList, filterAdd, filterSet, filterRemove, screenshot];
