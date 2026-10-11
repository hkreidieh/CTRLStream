/** Small helpers shared by tool files. */
import type { Ctx } from '../context.js';
import { ToolError } from '../errors.js';
import { SCRATCH_SCENE } from '../probes/devices.js';

export const MONITOR_TYPES = {
  none: 'OBS_MONITORING_TYPE_NONE',
  monitor_only: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
  monitor_and_output: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
} as const;

export function monitorName(t: string | undefined): string {
  const hit = Object.entries(MONITOR_TYPES).find(([, v]) => v === t);
  return hit ? hit[0] : (t ?? 'unknown');
}

/** OBS alignment bitmask: LEFT 1, RIGHT 2, TOP 4, BOTTOM 8, centre 0 (libobs obs-defs.h). */
export const ALIGN = {
  center: 0,
  left: 1,
  right: 2,
  top: 4,
  bottom: 8,
  'top-left': 5,
  'top-right': 6,
  'bottom-left': 9,
  'bottom-right': 10,
} as const;
export type AlignName = keyof typeof ALIGN;
export const ALIGN_NAMES = Object.keys(ALIGN) as AlignName[];

export function alignName(v: number): string {
  const hit = Object.entries(ALIGN).find(([, n]) => n === v);
  return hit ? hit[0] : String(v);
}

export async function requireConnection(ctx: Ctx): Promise<void> {
  await ctx.obs.ensure();
}

export async function sceneNames(ctx: Ctx): Promise<string[]> {
  const sl = await ctx.obs.call('GetSceneList');
  return [...sl.scenes]
    .sort((a, b) => Number(b['sceneIndex']) - Number(a['sceneIndex']))
    .map((s) => String(s['sceneName']))
    .filter((n) => n !== SCRATCH_SCENE);
}

export async function assertScene(ctx: Ctx, scene: string): Promise<void> {
  const names = await sceneNames(ctx);
  if (!names.includes(scene)) throw new ToolError('NOT_FOUND', `No scene named '${scene}'.`, `Scenes: ${names.join(', ') || 'none'}.`, 'scene_list');
}

export async function inputNames(ctx: Ctx): Promise<Array<{ name: string; kind: string; caps?: number }>> {
  const { inputs } = await ctx.obs.call('GetInputList');
  return inputs.map((i) => ({ name: String(i['inputName']), kind: String(i['inputKind']), ...(typeof i['inputKindCaps'] === 'number' ? { caps: i['inputKindCaps'] as number } : {}) }));
}

export async function assertInput(ctx: Ctx, name: string): Promise<{ name: string; kind: string; caps?: number }> {
  const list = await inputNames(ctx);
  const hit = list.find((i) => i.name === name);
  if (!hit) {
    throw new ToolError('NOT_FOUND', `No input named '${name}'.`, `Inputs: ${list.map((i) => i.name).filter((n) => !n.startsWith('__ctrlstream')).slice(0, 30).join(', ') || 'none'}.`, 'input_list');
  }
  return hit;
}

/** Resolve a scene item by source name or id. */
export async function resolveItem(ctx: Ctx, scene: string, source?: string, itemId?: number): Promise<{ id: number; source: string }> {
  if (itemId === undefined && !source) throw new ToolError('INVALID_ARGUMENT', 'Give source (the source name in the scene) or itemId.', 'scene_items lists both.', 'scene_items');
  const { sceneItems } = await ctx.obs.call('GetSceneItemList', { sceneName: scene });
  const hit = sceneItems.find((i) => (itemId !== undefined ? i['sceneItemId'] === itemId : i['sourceName'] === source));
  if (!hit) {
    throw new ToolError('NOT_FOUND', `No item ${itemId !== undefined ? `#${itemId}` : `'${source}'`} in scene '${scene}'.`, `Items: ${sceneItems.map((i) => `${i['sourceName']} (#${i['sceneItemId']})`).join(', ') || 'none'}.`, 'scene_items');
  }
  return { id: Number(hit['sceneItemId']), source: String(hit['sourceName']) };
}

/** The writable subset of a scene item transform (SetSceneItemTransform rejects bounds < 1). */
export function writableTransform(t: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['positionX', 'positionY', 'rotation', 'scaleX', 'scaleY', 'alignment', 'boundsType', 'boundsAlignment', 'cropLeft', 'cropRight', 'cropTop', 'cropBottom', 'cropToBounds']) {
    if (t[k] !== undefined) out[k] = t[k];
  }
  for (const k of ['boundsWidth', 'boundsHeight']) {
    if (typeof t[k] === 'number' && (t[k] as number) >= 1) out[k] = t[k];
  }
  return out;
}

export function compactTransform(t: Record<string, unknown>): Record<string, unknown> {
  const r = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  return {
    x: r(t['positionX']),
    y: r(t['positionY']),
    width: r(t['width']),
    height: r(t['height']),
    scaleX: r(t['scaleX']),
    scaleY: r(t['scaleY']),
    rotation: r(t['rotation']),
    alignment: alignName(Number(t['alignment'] ?? 5)),
    sourceWidth: t['sourceWidth'],
    sourceHeight: t['sourceHeight'],
    bounds: t['boundsType'] && t['boundsType'] !== 'OBS_BOUNDS_NONE' ? { type: t['boundsType'], width: r(t['boundsWidth']), height: r(t['boundsHeight']), alignment: alignName(Number(t['boundsAlignment'] ?? 0)) } : null,
    crop: { left: t['cropLeft'], right: t['cropRight'], top: t['cropTop'], bottom: t['cropBottom'] },
  };
}
