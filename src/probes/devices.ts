/**
 * Device enumeration (DESIGN 3.3): reuse an existing input of the right kind when there is one,
 * otherwise create a hidden probe input in the scratch scene `__ctrlstream_scratch`, read its
 * device list property with GetInputPropertiesListPropertyItems, and remove everything again.
 * Not a session mutation: no backup, no undo entry.
 */
import type { Ctx } from '../context.js';
import { DEVICE_ROLES, ROLE_CANDIDATES, ROLE_SETTINGS, deviceProperty, listQueryIsSafe, matchKind, resolveRoles } from '../obs/input-roles.js';
import type { Role } from '../obs/input-roles.js';

export const SCRATCH_SCENE = '__ctrlstream_scratch';
const PROBE_PREFIX = '__ctrlstream_probe_';

export interface Device {
  id: string;
  name: string;
  available: boolean;
  /** macOS displays: the main display (menu bar). */
  main?: boolean;
}

export interface DeviceInventory {
  cameras: Device[];
  microphones: Device[];
  speakers: Device[];
  displays: Device[];
  kinds: Partial<Record<keyof typeof DEVICE_ROLES, string | null>>;
  notes: string[];
}

export function toDevices(items: Array<Record<string, unknown>>): Device[] {
  return items
    .map((i) => ({
      id: i['itemValue'] === null || i['itemValue'] === undefined ? '' : String(i['itemValue']),
      name: String(i['itemName'] ?? ''),
      available: i['itemEnabled'] !== false,
    }))
    .filter((d) => d.id !== '' || d.name !== '');
}

/** Remove leftovers from an interrupted enumeration. */
export async function cleanupScratch(ctx: Ctx): Promise<void> {
  const inputs = await ctx.obs.tryCall('GetInputList');
  for (const i of inputs?.inputs ?? []) {
    const name = String(i['inputName'] ?? '');
    if (name.startsWith(PROBE_PREFIX)) await ctx.obs.tryCall('RemoveInput', { inputName: name });
  }
  const scenes = await ctx.obs.tryCall('GetSceneList');
  if (scenes?.scenes.some((s) => s['sceneName'] === SCRATCH_SCENE)) await ctx.obs.tryCall('RemoveScene', { sceneName: SCRATCH_SCENE });
}

export async function enumerateDevices(ctx: Ctx): Promise<DeviceInventory> {
  const { inputKinds } = await ctx.obs.call('GetInputKindList', { unversioned: false });
  const roles = resolveRoles(ctx.paths.platform, inputKinds);
  const existing = (await ctx.obs.call('GetInputList')).inputs;
  const inv: DeviceInventory = { cameras: [], microphones: [], speakers: [], displays: [], kinds: {}, notes: [] };
  let scratchCreated = false;
  const created: string[] = [];
  try {
    for (const [bucket, role] of Object.entries(DEVICE_ROLES) as Array<[keyof typeof DEVICE_ROLES, Role]>) {
      const resolved = roles.find((x) => x.role === role)!;
      // Prefer a candidate kind that has a device list and is safe to query (macOS desktop audio:
      // sck_audio_capture has no device list, coreaudio_output_capture does).
      const listable = ROLE_CANDIDATES[role][ctx.paths.platform]
        .map((c) => matchKind(c, inputKinds))
        .find((k): k is string => !!k && !!deviceProperty(k) && listQueryIsSafe(k));
      // (On macOS the display bucket is handled below from GetMonitorList.)
      const r = listable ? { ...resolved, kind: listable, deviceProperty: deviceProperty(listable) } : resolved;
      inv.kinds[bucket] = r.kind;
      if (!r.kind || !r.deviceProperty) {
        inv.notes.push(`${bucket}: no input kind on this OBS lists devices (${r.candidates.join(', ') || 'none for this OS'}).`);
        continue;
      }
      // macOS displays always come from OBS's monitor list: screen_capture's list can crash OBS and
      // display_capture failed to even create on the real OBS 32.2.2 / macOS 26.2.
      if (!listQueryIsSafe(r.kind) || (bucket === 'displays' && ctx.paths.platform === 'darwin')) {
        // Asking OBS for this kind's list can crash it (see UNSAFE_LIST_KINDS). Displays come
        // from OBS's own monitor list instead; their ids are not display_uuid values.
        if (bucket === 'displays') {
          // Display ids (the display_uuid screen_capture stores) come from macOS itself.
          let mac: Awaited<ReturnType<Ctx['displays']['list']>> = [];
          try {
            mac = ctx.paths.platform === 'darwin' ? await ctx.displays.list() : [];
          } catch {
            mac = [];
          }
          if (mac.length > 0) {
            inv.displays = mac.map((d) => ({ id: d.uuid, name: d.label, available: true, main: d.main }));
          } else {
            const m = await ctx.obs.tryCall('GetMonitorList');
            inv.displays = (m?.monitors ?? []).map((x) => ({ id: `monitor-${x['monitorIndex']}`, name: `${String(x['monitorName'])} ${x['monitorWidth']}x${x['monitorHeight']}`, available: true }));
            inv.notes.push(
              `displays: macOS did not report display ids, so these come from OBS's monitor list and cannot be used as deviceId. Create the display capture without deviceId; ctrlstream then picks the main display if it can, otherwise ask the user to double-click it in OBS and pick the display.`,
            );
          }
        } else {
          inv.notes.push(`${bucket}: ${r.kind} cannot be listed safely over the websocket on this OBS.`);
        }
        continue;
      }
      const reuse = existing.find((i) => i['inputKind'] === r.kind && !String(i['inputName']).startsWith(PROBE_PREFIX));
      let inputName = reuse ? String(reuse['inputName']) : `${PROBE_PREFIX}${role}`;
      if (!reuse) {
        if (!scratchCreated) {
          await cleanupScratch(ctx);
          await ctx.obs.call('CreateScene', { sceneName: SCRATCH_SCENE });
          scratchCreated = true;
        }
        await ctx.obs.call('CreateInput', {
          sceneName: SCRATCH_SCENE,
          inputName,
          inputKind: r.kind,
          inputSettings: (ROLE_SETTINGS[role]?.[r.kind] ?? {}) as never,
          sceneItemEnabled: false,
        });
        created.push(inputName);
      }
      try {
        const { propertyItems } = await ctx.obs.call('GetInputPropertiesListPropertyItems', { inputName, propertyName: r.deviceProperty });
        inv[bucket] = toDevices(propertyItems as Array<Record<string, unknown>>);
      } catch (e) {
        inv.notes.push(`${bucket}: could not list devices (${(e as Error).message}).`);
      }
      inputName = '';
    }
  } finally {
    for (const name of created) await ctx.obs.tryCall('RemoveInput', { inputName: name });
    if (scratchCreated) await ctx.obs.tryCall('RemoveScene', { sceneName: SCRATCH_SCENE });
  }
  return inv;
}
