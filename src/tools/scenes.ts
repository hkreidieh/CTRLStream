/** Scenes and inputs. */
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ToolError } from '../errors.js';
import { ROLES, ROLE_SETTINGS, deviceProperty, listQueryIsSafe, matchKind, resolveRoles } from '../obs/input-roles.js';
import type { Role } from '../obs/input-roles.js';
import { SCRATCH_SCENE } from '../probes/devices.js';
import { pickDefaultDisplay } from '../probes/displays.js';
import { markScreenCapturesShown } from './layout.js';
import { mutate } from '../safety/mutate.js';
import { registerInverse } from '../safety/undo.js';
import { MONITOR_TYPES, assertInput, assertScene, monitorName, requireConnection, sceneNames, writableTransform } from './common.js';
import { defineTool } from './registry.js';

const OBS_SOURCE_AUDIO = 0x2; // libobs obs-source.h output flag

// ----- undo handlers that need ids from earlier steps -----------------------------------------

interface SavedItem {
  source: string;
  kind: string | null;
  settings: Record<string, unknown> | null;
  enabled: boolean;
  transform: Record<string, unknown>;
}

async function recreateItems(ctx: Ctx, scene: string, items: SavedItem[]): Promise<void> {
  const existing = new Set((await ctx.obs.call('GetInputList')).inputs.map((i) => String(i['inputName'])));
  for (const it of items) {
    let id: number;
    if (existing.has(it.source)) {
      id = (await ctx.obs.call('CreateSceneItem', { sceneName: scene, sourceName: it.source, sceneItemEnabled: it.enabled })).sceneItemId;
    } else if (it.kind) {
      id = (await ctx.obs.call('CreateInput', { sceneName: scene, inputName: it.source, inputKind: it.kind, inputSettings: (it.settings ?? {}) as never, sceneItemEnabled: it.enabled })).sceneItemId;
      existing.add(it.source);
    } else continue;
    await ctx.obs.tryCall('SetSceneItemTransform', { sceneName: scene, sceneItemId: id, sceneItemTransform: writableTransform(it.transform) as never });
  }
}

registerInverse('recreate_scene', async (ctx, data) => {
  const d = data as { scene: string; items: SavedItem[]; wasCurrent: boolean };
  await ctx.obs.call('CreateScene', { sceneName: d.scene });
  await recreateItems(ctx, d.scene, d.items);
  if (d.wasCurrent) await ctx.obs.tryCall('SetCurrentProgramScene', { sceneName: d.scene });
  return { recreatedScene: d.scene, items: d.items.length };
});

registerInverse('recreate_input', async (ctx, data) => {
  const d = data as { name: string; kind: string; settings: Record<string, unknown>; placements: Array<{ scene: string; enabled: boolean; transform: Record<string, unknown> }>; audio?: Record<string, unknown> };
  const [first, ...rest] = d.placements;
  if (first) {
    await recreateItems(ctx, first.scene, [{ source: d.name, kind: d.kind, settings: d.settings, enabled: first.enabled, transform: first.transform }]);
    for (const p of rest) await recreateItems(ctx, p.scene, [{ source: d.name, kind: d.kind, settings: d.settings, enabled: p.enabled, transform: p.transform }]);
  } else {
    // Global inputs (Desktop Audio and the like) live in no scene, but CreateInput needs one
    // (obs-websocket 5.7.4 RequestHandler_Inputs.cpp), so it comes back in the live scene.
    const { currentProgramSceneName } = await ctx.obs.call('GetCurrentProgramScene');
    await ctx.obs.call('CreateInput', { sceneName: currentProgramSceneName, inputName: d.name, inputKind: d.kind, inputSettings: d.settings as never });
  }
  if (d.audio?.['inputVolumeDb'] !== undefined) await ctx.obs.tryCall('SetInputVolume', { inputName: d.name, inputVolumeDb: d.audio['inputVolumeDb'] as number });
  if (d.audio?.['inputMuted'] !== undefined) await ctx.obs.tryCall('SetInputMute', { inputName: d.name, inputMuted: d.audio['inputMuted'] as boolean });
  return { recreatedInput: d.name };
});

async function savedItems(ctx: Ctx, scene: string): Promise<SavedItem[]> {
  const { sceneItems } = await ctx.obs.call('GetSceneItemList', { sceneName: scene });
  const out: SavedItem[] = [];
  for (const it of [...sceneItems].sort((a, b) => Number(a['sceneItemIndex']) - Number(b['sceneItemIndex']))) {
    const source = String(it['sourceName']);
    const kind = it['inputKind'] ? String(it['inputKind']) : null;
    const s = kind ? await ctx.obs.tryCall('GetInputSettings', { inputName: source }) : undefined;
    out.push({ source, kind, settings: (s?.inputSettings as Record<string, unknown>) ?? null, enabled: !!it['sceneItemEnabled'], transform: (it['sceneItemTransform'] as Record<string, unknown>) ?? {} });
  }
  return out;
}

// ----- scenes ------------------------------------------------------------------------------

export const sceneList = defineTool({
  name: 'scene_list',
  title: 'List scenes',
  description: 'Scenes in the current collection, in the order the OBS scene list shows them, plus which scene is live (program) and, in Studio Mode, which is in preview. Changes nothing.',
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    await requireConnection(ctx);
    const sl = await ctx.obs.call('GetSceneList');
    return { current: sl.currentProgramSceneName, preview: sl.currentPreviewSceneName ?? null, scenes: await sceneNames(ctx) };
  },
});

export const sceneCreate = defineTool({
  name: 'scene_create',
  title: 'Create scene',
  description: 'Create an empty scene (for example "Starting Soon", "Live", "BRB", "Ending"). It does not switch to it. Next: add sources with input_create, then check with screenshot. Undoable with undo_last.',
  input: { name: z.string().min(1).max(200) },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const existing = await sceneNames(ctx);
    if (existing.includes(args.name)) throw new ToolError('ALREADY_EXISTS', `Scene '${args.name}' already exists.`, 'Use it as it is, or pick another name.', 'scene_items');
    await mutate(ctx, {
      tool: 'scene_create',
      args,
      apply: () => ctx.obs.call('CreateScene', { sceneName: args.name }),
      inverse: () => ({ kind: 'ws', requests: [{ requestType: 'RemoveScene', requestData: { sceneName: args.name } }] }),
    });
    return { created: args.name, scenes: await sceneNames(ctx) };
  },
});

export const sceneRemove = defineTool({
  name: 'scene_remove',
  title: 'Remove scene',
  description:
    "Delete a scene. Sources used only by that scene are deleted with it by OBS. If it is the live scene and the user is streaming, viewers see OBS switch to another scene, so confirm with the user first. OBS refuses to remove the last scene. undo_last recreates the scene, its items, their positions and any deleted sources with their settings.",
  input: { name: z.string().min(1) },
  mutating: true,
  fileWriting: false,
  annotations: { destructiveHint: true },
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    await assertScene(ctx, args.name);
    const before = await mutate(ctx, {
      tool: 'scene_remove',
      args,
      before: async () => ({ items: await savedItems(ctx, args.name), wasCurrent: (await ctx.obs.call('GetCurrentProgramScene')).currentProgramSceneName === args.name }),
      apply: async (b) => {
        await ctx.obs.call('RemoveScene', { sceneName: args.name });
        return b;
      },
      inverse: (b) => ({ kind: 'custom', op: 'recreate_scene', data: { scene: args.name, items: b.items, wasCurrent: b.wasCurrent } }),
    });
    return { removed: args.name, itemsRemoved: before.items.map((i) => i.source), wasLive: before.wasCurrent, scenes: await sceneNames(ctx) };
  },
});

export const sceneSetCurrent = defineTool({
  name: 'scene_set_current',
  title: 'Switch live scene',
  description: 'Make a scene the live (program) scene. While streaming or recording this is what viewers see immediately. Undoable with undo_last.',
  input: { name: z.string().min(1) },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    await assertScene(ctx, args.name);
    const before = await mutate(ctx, {
      tool: 'scene_set_current',
      args,
      before: async () => (await ctx.obs.call('GetCurrentProgramScene')).currentProgramSceneName,
      apply: async (prev) => {
        await ctx.obs.call('SetCurrentProgramScene', { sceneName: args.name });
        await markScreenCapturesShown(ctx, args.name);
        return prev;
      },
      inverse: (prev) => ({ kind: 'ws', requests: [{ requestType: 'SetCurrentProgramScene', requestData: { sceneName: prev } }] }),
    });
    return { current: args.name, previous: before };
  },
});

// ----- inputs ------------------------------------------------------------------------------

export const inputKinds = defineTool({
  name: 'input_kinds',
  title: 'Input kinds for this machine',
  description:
    'Which OBS input kind serves each role on this machine (camera, microphone, desktop_audio, display, window, game, browser, media, image, text, color), resolved against what this OBS actually offers, plus the property that holds the device id. Use the role names with input_create. Changes nothing.',
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    await requireConnection(ctx);
    const { inputKinds: kinds } = await ctx.obs.call('GetInputKindList', { unversioned: false });
    return { platform: ctx.paths.platform, roles: resolveRoles(ctx.paths.platform, kinds), availableKinds: kinds };
  },
});

export const inputList = defineTool({
  name: 'input_list',
  title: 'List inputs',
  description: 'Every input (source) in the current collection with its kind, the scenes it appears in, and for audio inputs: muted, volume in dB and monitoring. Optional scene filter. Changes nothing.',
  input: { scene: z.string().min(1).optional() },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const scenes = await sceneNames(ctx);
    if (args.scene && !scenes.includes(args.scene)) throw new ToolError('NOT_FOUND', `No scene named '${args.scene}'.`, `Scenes: ${scenes.join(', ')}.`, 'scene_list');
    const membership = new Map<string, string[]>();
    for (const s of scenes) {
      const { sceneItems } = await ctx.obs.call('GetSceneItemList', { sceneName: s });
      for (const it of sceneItems) membership.set(String(it['sourceName']), [...(membership.get(String(it['sourceName'])) ?? []), s]);
    }
    const { inputs } = await ctx.obs.call('GetInputList');
    const out = [];
    for (const i of inputs) {
      const name = String(i['inputName']);
      if (name.startsWith('__ctrlstream')) continue;
      const inScenes = membership.get(name) ?? [];
      if (args.scene && !inScenes.includes(args.scene)) continue;
      const caps = typeof i['inputKindCaps'] === 'number' ? (i['inputKindCaps'] as number) : null;
      let audio: Record<string, unknown> | null = null;
      if (caps === null || (caps & OBS_SOURCE_AUDIO) !== 0) {
        const [mute, vol, mon] = await Promise.all([
          ctx.obs.tryCall('GetInputMute', { inputName: name }),
          ctx.obs.tryCall('GetInputVolume', { inputName: name }),
          ctx.obs.tryCall('GetInputAudioMonitorType', { inputName: name }),
        ]);
        if (mute || vol) audio = { muted: mute?.inputMuted ?? null, volumeDb: vol ? Math.round(vol.inputVolumeDb * 10) / 10 : null, monitoring: monitorName(mon?.monitorType) };
      }
      out.push({ name, kind: String(i['inputKind']), scenes: inScenes, ...(audio ? { audio } : {}) });
    }
    return { inputs: out };
  },
});

async function resolveKind(ctx: Ctx, role?: Role, kind?: string): Promise<{ kind: string; role: Role | null }> {
  const { inputKinds: kinds } = await ctx.obs.call('GetInputKindList', { unversioned: false });
  if (role) {
    const r = resolveRoles(ctx.paths.platform, kinds).find((x) => x.role === role)!;
    if (!r.kind) throw new ToolError('UNSUPPORTED', `No input kind for role '${role}' on this OBS (looked for ${r.candidates.join(', ') || 'nothing on this OS'}).`, 'Call input_kinds to see what this machine offers.', 'input_kinds');
    return { kind: r.kind, role };
  }
  const k = matchKind(kind!, kinds);
  if (!k) throw new ToolError('NOT_FOUND', `This OBS has no input kind '${kind}'.`, 'Use a role instead, or a kind from input_kinds.', 'input_kinds');
  return { kind: k, role: null };
}

export const inputCreate = defineTool({
  name: 'input_create',
  title: 'Create input',
  description:
    'Add a source to a scene. Give a role (camera, microphone, desktop_audio, display, window, game, browser, media, image, text, color) and the right kind for this OS is picked, or an explicit kind. deviceId (from obs_devices) binds cameras, microphones and displays to a device; on macOS a display without deviceId gets the primary display automatically (the result says which). settings are passed to OBS as-is (input_properties shows valid values). If an input with that name already exists, set addExistingToScene to put the same source into another scene instead of failing (for example the webcam in both Live and BRB). Next: screenshot, then scene_item_transform_set to place it. Undoable.',
  input: {
    name: z.string().min(1).max(200),
    scene: z.string().min(1),
    role: z.enum(ROLES).optional(),
    kind: z.string().min(1).optional(),
    deviceId: z.string().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    visible: z.boolean().optional().describe('Default true'),
    addExistingToScene: z.boolean().optional(),
  },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    await assertScene(ctx, args.scene);
    if (args.scene === SCRATCH_SCENE) throw new ToolError('INVALID_ARGUMENT', 'That scene is internal to ctrlstream.', 'Pick a real scene.');
    const existing = (await ctx.obs.call('GetInputList')).inputs.find((i) => i['inputName'] === args.name);
    if (existing) {
      if (!args.addExistingToScene) throw new ToolError('ALREADY_EXISTS', `An input named '${args.name}' already exists (${existing['inputKind']}).`, 'Pass addExistingToScene: true to show the same source in this scene too, or choose another name.', 'input_list');
      const r = await mutate(ctx, {
        tool: 'input_create',
        args,
        apply: () => ctx.obs.call('CreateSceneItem', { sceneName: args.scene, sourceName: args.name, sceneItemEnabled: args.visible ?? true }),
        inverse: (_b, res) => ({ kind: 'ws', requests: [{ requestType: 'RemoveSceneItem', requestData: { sceneName: args.scene, sceneItemId: res.sceneItemId } }] }),
      });
      return { name: args.name, scene: args.scene, kind: String(existing['inputKind']), sceneItemId: r.sceneItemId, reusedExisting: true };
    }
    if (!!args.role === !!args.kind) throw new ToolError('INVALID_ARGUMENT', 'Give exactly one of role or kind.', 'Roles are portable across Windows and macOS; prefer role.');
    const { kind, role } = await resolveKind(ctx, args.role, args.kind);
    const settings: Record<string, unknown> = { ...((role && ROLE_SETTINGS[role]?.[kind]) ?? {}), ...(args.settings ?? {}) };
    const prop = deviceProperty(kind);
    if (args.deviceId !== undefined) {
      if (!prop) throw new ToolError('INVALID_ARGUMENT', `Inputs of kind ${kind} do not take a device id.`, 'Drop deviceId, or use a camera, microphone, desktop_audio or display role.');
      if (/^monitor-\d+$/.test(args.deviceId)) throw new ToolError('INVALID_ARGUMENT', `'${args.deviceId}' is a monitor index from OBS's monitor list, not a ${prop} value ${kind} accepts.`, 'Create the display capture without deviceId, then ask the user to double-click the source in OBS and pick the display (and grant Screen Recording permission if macOS asks). Check with screenshot.');
      settings[prop] = args.deviceId;
    }
    // macOS display capture: OBS leaves display_uuid empty (a black source) and its own list cannot
    // be read safely, so pick the display from macOS: OBS's primary monitor, else the main display.
    let display: { uuid: string; label: string; chosenBy: string } | null = null;
    if (prop === 'display_uuid' && args.deviceId === undefined && settings['display_uuid'] === undefined && ctx.paths.platform === 'darwin') {
      try {
        const monitors = ((await ctx.obs.tryCall('GetMonitorList'))?.monitors ?? []) as Array<Record<string, unknown>>;
        const pick = pickDefaultDisplay(await ctx.displays.list(), monitors);
        if (pick) {
          settings['display_uuid'] = pick.display.uuid;
          display = { uuid: pick.display.uuid, label: pick.display.label, chosenBy: pick.chosenBy };
        }
      } catch {
        display = null;
      }
    }
    const r = await mutate(ctx, {
      tool: 'input_create',
      args,
      apply: () => ctx.obs.call('CreateInput', { sceneName: args.scene, inputName: args.name, inputKind: kind, inputSettings: settings as never, sceneItemEnabled: args.visible ?? true }),
      inverse: () => ({ kind: 'ws', requests: [{ requestType: 'RemoveInput', requestData: { inputName: args.name } }] }),
    });
    return {
      name: args.name,
      scene: args.scene,
      kind,
      role,
      sceneItemId: r.sceneItemId,
      deviceProperty: prop,
      deviceId: prop ? (settings[prop] ?? null) : null,
      ...(display ? { display } : {}),
      ...(prop === 'display_uuid' && !settings['display_uuid'] ? { warning: 'No display could be chosen, so this capture is black until the user double-clicks it in OBS and picks a display.' } : {}),
      ...(kind === 'screen_capture' && settings['display_uuid'] ? { note: "macOS screen capture shows black until its scene has been live once; screenshot after scene_set_current on this scene." } : {}),
      next: 'screenshot, then scene_item_transform_set',
    };
  },
});

export const inputRemove = defineTool({
  name: 'input_remove',
  title: 'Remove input',
  description: 'Delete a source everywhere it appears (all scenes). Confirm with the user if it is on the live scene. undo_last recreates it with its settings, positions and audio levels.',
  input: { name: z.string().min(1) },
  mutating: true,
  fileWriting: false,
  annotations: { destructiveHint: true },
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const input = await assertInput(ctx, args.name);
    const res = await mutate(ctx, {
      tool: 'input_remove',
      args,
      before: async () => {
        const s = await ctx.obs.call('GetInputSettings', { inputName: args.name });
        const placements: Array<{ scene: string; enabled: boolean; transform: Record<string, unknown> }> = [];
        for (const scene of await sceneNames(ctx)) {
          const { sceneItems } = await ctx.obs.call('GetSceneItemList', { sceneName: scene });
          for (const it of sceneItems) if (it['sourceName'] === args.name) placements.push({ scene, enabled: !!it['sceneItemEnabled'], transform: (it['sceneItemTransform'] as Record<string, unknown>) ?? {} });
        }
        const [vol, mute] = await Promise.all([ctx.obs.tryCall('GetInputVolume', { inputName: args.name }), ctx.obs.tryCall('GetInputMute', { inputName: args.name })]);
        return { name: args.name, kind: input.kind, settings: s.inputSettings as Record<string, unknown>, placements, audio: { ...(vol ? { inputVolumeDb: vol.inputVolumeDb } : {}), ...(mute ? { inputMuted: mute.inputMuted } : {}) } };
      },
      apply: async (b) => {
        await ctx.obs.call('RemoveInput', { inputName: args.name });
        return b;
      },
      inverse: (b) => ({ kind: 'custom', op: 'recreate_input', data: b }),
    });
    return { removed: args.name, kind: input.kind, fromScenes: res.placements.map((p) => p.scene) };
  },
});

export const inputSettingsGet = defineTool({
  name: 'input_settings_get',
  title: 'Get input settings',
  description: "An input's kind and the settings it has changed from its defaults (secrets such as keys or passwords show as <set>). includeDefaults adds the kind's default values. Changes nothing.",
  input: { name: z.string().min(1), includeDefaults: z.boolean().optional() },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const s = await ctx.obs.call('GetInputSettings', { inputName: args.name });
    const defaults = args.includeDefaults ? (await ctx.obs.tryCall('GetInputDefaultSettings', { inputKind: s.inputKind }))?.defaultInputSettings : undefined;
    return { name: args.name, kind: s.inputKind, settings: s.inputSettings, ...(defaults ? { defaults } : {}) };
  },
});

export const inputSettingsSet = defineTool({
  name: 'input_settings_set',
  title: 'Change input settings',
  description:
    "Change an input's settings, for example point a camera at another device id, change a browser source URL, or set an image file. By default only the given keys change; replace: true resets everything else to defaults first. Check valid keys and values with input_properties, and the result with screenshot. Undoable exactly (the previous settings are restored).",
  input: { name: z.string().min(1), settings: z.record(z.string(), z.unknown()), replace: z.boolean().optional() },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    await assertInput(ctx, args.name);
    const after = await mutate(ctx, {
      tool: 'input_settings_set',
      args,
      before: async () => (await ctx.obs.call('GetInputSettings', { inputName: args.name })).inputSettings as Record<string, unknown>,
      apply: async () => {
        await ctx.obs.call('SetInputSettings', { inputName: args.name, inputSettings: args.settings as never, overlay: !args.replace });
        return (await ctx.obs.call('GetInputSettings', { inputName: args.name })).inputSettings as Record<string, unknown>;
      },
      after: async (r) => r,
      inverse: (b) => ({ kind: 'ws', requests: [{ requestType: 'SetInputSettings', requestData: { inputName: args.name, inputSettings: b, overlay: false } }] }),
    });
    return { name: args.name, settings: after };
  },
});

export const inputProperties = defineTool({
  name: 'input_properties',
  title: 'Input properties and valid values',
  description:
    "What can be set on an input: each settings key with its default and current value and, for list properties (devices, displays, windows, formats, resolutions), the valid options with their values. obs-websocket only exposes list options, so ranges and descriptions of other properties are not available. Pass properties to ask about specific keys. Changes nothing; may briefly query hardware for device lists.",
  input: { name: z.string().min(1), properties: z.array(z.string().min(1)).max(30).optional() },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const s = await ctx.obs.call('GetInputSettings', { inputName: args.name });
    const defaults = ((await ctx.obs.tryCall('GetInputDefaultSettings', { inputKind: s.inputKind }))?.defaultInputSettings ?? {}) as Record<string, unknown>;
    const current = s.inputSettings as Record<string, unknown>;
    const dev = deviceProperty(s.inputKind);
    const keys = args.properties ?? Array.from(new Set([...(dev ? [dev] : []), ...Object.keys(defaults), ...Object.keys(current)])).slice(0, 30);
    const props = [];
    const safe = listQueryIsSafe(s.inputKind);
    for (const key of keys) {
      const items = safe ? await ctx.obs.tryCall('GetInputPropertiesListPropertyItems', { inputName: args.name, propertyName: key }) : undefined;
      const def = defaults[key];
      props.push({
        property: key,
        type: def === undefined ? (current[key] === undefined ? 'unknown' : typeof current[key]) : typeof def,
        default: def ?? null,
        current: current[key] ?? null,
        ...(items ? { options: (items.propertyItems as Array<Record<string, unknown>>).slice(0, 60).map((i) => ({ value: i['itemValue'], name: i['itemName'], enabled: i['itemEnabled'] !== false })) } : {}),
      });
    }
    return {
      name: args.name,
      kind: s.inputKind,
      deviceProperty: dev,
      properties: props,
      ...(safe
        ? {}
        : { note: `List options are not read for ${s.inputKind}: asking OBS for them crashes OBS 32.2. For the display, use a display id from obs_devices (set display_uuid with input_settings_set); for windows or apps, ask the user to choose in the source's properties.` }),
    };
  },
});

export const inputAudioSet = defineTool({
  name: 'input_audio_set',
  title: 'Set input audio',
  description:
    "Audio controls for one input: volume in dB (0 = unchanged level, -100 silent, up to +26), mute, monitoring (none, monitor_only = hear it yourself but viewers do not, monitor_and_output), and sync offset in ms (delay this audio to line it up with video). Only given fields change. Undoable.",
  input: {
    name: z.string().min(1),
    volumeDb: z.number().min(-100).max(26).optional(),
    muted: z.boolean().optional(),
    monitoring: z.enum(['none', 'monitor_only', 'monitor_and_output']).optional(),
    syncOffsetMs: z.number().int().min(-950).max(20000).optional(),
  },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    await assertInput(ctx, args.name);
    if (args.volumeDb === undefined && args.muted === undefined && args.monitoring === undefined && args.syncOffsetMs === undefined) {
      throw new ToolError('INVALID_ARGUMENT', 'Nothing to change.', 'Give at least one of volumeDb, muted, monitoring, syncOffsetMs.');
    }
    const n = args.name;
    const before = await mutate(ctx, {
      tool: 'input_audio_set',
      args,
      before: async () => ({
        volumeDb: args.volumeDb !== undefined ? (await ctx.obs.call('GetInputVolume', { inputName: n })).inputVolumeDb : undefined,
        muted: args.muted !== undefined ? (await ctx.obs.call('GetInputMute', { inputName: n })).inputMuted : undefined,
        monitorType: args.monitoring !== undefined ? (await ctx.obs.call('GetInputAudioMonitorType', { inputName: n })).monitorType : undefined,
        syncOffsetMs: args.syncOffsetMs !== undefined ? (await ctx.obs.call('GetInputAudioSyncOffset', { inputName: n })).inputAudioSyncOffset : undefined,
      }),
      apply: async (b) => {
        if (args.volumeDb !== undefined) await ctx.obs.call('SetInputVolume', { inputName: n, inputVolumeDb: args.volumeDb });
        if (args.muted !== undefined) await ctx.obs.call('SetInputMute', { inputName: n, inputMuted: args.muted });
        if (args.monitoring !== undefined) await ctx.obs.call('SetInputAudioMonitorType', { inputName: n, monitorType: MONITOR_TYPES[args.monitoring] });
        if (args.syncOffsetMs !== undefined) await ctx.obs.call('SetInputAudioSyncOffset', { inputName: n, inputAudioSyncOffset: args.syncOffsetMs });
        return b;
      },
      inverse: (b) => ({
        kind: 'ws',
        requests: [
          ...(b.volumeDb !== undefined ? [{ requestType: 'SetInputVolume' as const, requestData: { inputName: n, inputVolumeDb: Math.max(-100, b.volumeDb) } }] : []),
          ...(b.muted !== undefined ? [{ requestType: 'SetInputMute' as const, requestData: { inputName: n, inputMuted: b.muted } }] : []),
          ...(b.monitorType !== undefined ? [{ requestType: 'SetInputAudioMonitorType' as const, requestData: { inputName: n, monitorType: b.monitorType } }] : []),
          ...(b.syncOffsetMs !== undefined ? [{ requestType: 'SetInputAudioSyncOffset' as const, requestData: { inputName: n, inputAudioSyncOffset: b.syncOffsetMs } }] : []),
        ],
      }),
    });
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    if (args.volumeDb !== undefined) changed['volumeDb'] = { from: before.volumeDb !== undefined ? Math.round(before.volumeDb * 10) / 10 : null, to: args.volumeDb };
    if (args.muted !== undefined) changed['muted'] = { from: before.muted, to: args.muted };
    if (args.monitoring !== undefined) changed['monitoring'] = { from: monitorName(before.monitorType), to: args.monitoring };
    if (args.syncOffsetMs !== undefined) changed['syncOffsetMs'] = { from: before.syncOffsetMs, to: args.syncOffsetMs };
    return { name: n, changed };
  },
});

export const sceneTools = [sceneList, sceneCreate, sceneRemove, sceneSetCurrent, inputKinds, inputList, inputCreate, inputRemove, inputSettingsGet, inputSettingsSet, inputProperties, inputAudioSet];
