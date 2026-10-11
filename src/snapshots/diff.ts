/** Structured diff between a snapshot manifest and the current setup (DESIGN 4, snapshot_diff). */
import path from 'node:path';
import type { Ctx } from '../context.js';
import { readJson } from '../obs/files.js';
import { redact } from '../safety/redact.js';
import type { Manifest } from './store.js';
import { scenesAndInputsFromCollection } from './state.js';

type Changes = Record<string, { then: unknown; now: unknown }>;

export function fieldChanges<T extends object>(then: T | null | undefined, now: T | null | undefined, fields?: Array<keyof T>): Changes {
  const out: Changes = {};
  if (!then || !now) return out;
  const keys = fields ?? (Array.from(new Set([...Object.keys(then), ...Object.keys(now)])) as Array<keyof T>);
  for (const k of keys) {
    const a = then[k];
    const b = now[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[String(k)] = { then: a ?? null, now: b ?? null };
  }
  return out;
}

const short = (v: unknown): unknown => (typeof v === 'string' && v.length > 120 ? `${v.slice(0, 117)}...` : v && typeof v === 'object' ? '[object]' : v);

function settingChanges(a: Record<string, unknown> = {}, b: Record<string, unknown> = {}): Changes {
  const out: Changes = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = { then: short(a[k]) ?? null, now: short(b[k]) ?? null };
    if (Object.keys(out).length >= 10) break;
  }
  return out;
}

/** Device ids that some input in the snapshot was bound to. */
export function referencedDeviceIds(snap: Pick<Manifest, 'inputs'>): Set<string> {
  return new Set(snap.inputs.map((i) => i.deviceId).filter((d): d is string => !!d && d !== 'default'));
}

export interface SnapshotDiff {
  snapshotId: string;
  snapshotLabel: string;
  comparedWith: 'live' | 'files';
  identical: boolean;
  profile: Changes;
  video: Changes;
  output: Changes;
  audio: Changes;
  streamService: Changes;
  scenes: { added: string[]; removed: string[] };
  inputs: { added: string[]; removed: string[]; changed: Array<{ name: string; kind?: Changes; scenes?: Changes; deviceId?: Changes; settings?: Changes }> };
  /** missingNow: devices an input in the snapshot used that are gone now; otherMissingNow: devices the snapshot saw but no input used (a phone not nearby). */
  devices: { compared: boolean; missingNow: Record<string, string[]>; otherMissingNow: Record<string, string[]>; newNow: Record<string, string[]> };
  snapshotPending: string[];
  snapshotComplete: boolean | null;
  encoders: { missingNow: string[]; newNow: string[] };
}

export async function diffAgainst(ctx: Ctx, snap: Manifest, snapDir: string, current: Manifest, currentInputSettings: Record<string, Record<string, unknown>>, source: 'live' | 'files'): Promise<SnapshotDiff> {
  const snapScenesFile = snap.sceneCollectionFile ? path.join(snapDir, 'scenes', snap.sceneCollectionFile) : null;
  const snapCollection = snapScenesFile ? scenesAndInputsFromCollection(await readJson(snapScenesFile)) : null;

  const thenInputs = new Map(snap.inputs.map((i) => [i.name, i]));
  const nowInputs = new Map(current.inputs.map((i) => [i.name, i]));
  const changed: SnapshotDiff['inputs']['changed'] = [];
  for (const [name, a] of thenInputs) {
    const b = nowInputs.get(name);
    if (!b) continue;
    const entry: SnapshotDiff['inputs']['changed'][number] = { name };
    if (a.kind !== b.kind) entry.kind = { kind: { then: a.kind, now: b.kind } };
    if (JSON.stringify(a.scenes) !== JSON.stringify(b.scenes)) entry.scenes = { scenes: { then: a.scenes, now: b.scenes } };
    if (a.deviceId !== b.deviceId) entry.deviceId = { deviceId: { then: a.deviceId, now: b.deviceId } };
    if (a.settingsDigest !== b.settingsDigest) {
      entry.settings = settingChanges(snapCollection?.inputSettings[name], currentInputSettings[name]);
      if (Object.keys(entry.settings).length === 0) entry.settings = { settings: { then: a.settingsDigest, now: b.settingsDigest } };
    }
    if (Object.keys(entry).length > 1) changed.push(entry);
  }

  const devices: SnapshotDiff['devices'] = { compared: false, missingNow: {}, otherMissingNow: {}, newNow: {} };
  if (snap.devices && current.devices) {
    devices.compared = true;
    const used = referencedDeviceIds(snap);
    for (const bucket of ['cameras', 'microphones', 'speakers', 'displays'] as const) {
      const thenIds = new Set(snap.devices[bucket].map((d) => d.id));
      const nowIds = new Set(current.devices[bucket].map((d) => d.id));
      const gone = snap.devices[bucket].filter((d) => !nowIds.has(d.id));
      const missing = gone.filter((d) => used.has(d.id)).map((d) => d.name);
      const other = gone.filter((d) => !used.has(d.id)).map((d) => d.name);
      const added = current.devices[bucket].filter((d) => !thenIds.has(d.id)).map((d) => d.name);
      if (missing.length) devices.missingNow[bucket] = missing;
      if (other.length) devices.otherMissingNow[bucket] = other;
      if (added.length) devices.newNow[bucket] = added;
    }
  }

  const diff: SnapshotDiff = {
    snapshotId: snap.id,
    snapshotLabel: snap.label,
    comparedWith: source,
    identical: false,
    profile: fieldChanges({ profile: snap.profile, sceneCollection: snap.sceneCollection }, { profile: current.profile, sceneCollection: current.sceneCollection }),
    video: fieldChanges(snap.video, current.video),
    output: fieldChanges(snap.output, current.output),
    audio: fieldChanges(snap.audio, current.audio),
    streamService: fieldChanges(snap.streamService ?? {}, current.streamService ?? {}),
    scenes: { added: current.scenes.filter((s) => !snap.scenes.includes(s)), removed: snap.scenes.filter((s) => !current.scenes.includes(s)) },
    inputs: {
      added: [...nowInputs.keys()].filter((n) => !thenInputs.has(n)),
      removed: [...thenInputs.keys()].filter((n) => !nowInputs.has(n)),
      changed,
    },
    devices,
    encoders: { missingNow: snap.encoders.filter((e) => !current.encoders.includes(e)), newNow: current.encoders.filter((e) => !snap.encoders.includes(e)) },
    snapshotPending: snap.pending ?? [],
    snapshotComplete: snap.complete ?? null,
  };
  diff.identical =
    !Object.keys(diff.video).length &&
    !Object.keys(diff.output).length &&
    !Object.keys(diff.audio).length &&
    !Object.keys(diff.streamService).length &&
    !diff.scenes.added.length &&
    !diff.scenes.removed.length &&
    !diff.inputs.added.length &&
    !diff.inputs.removed.length &&
    !diff.inputs.changed.length &&
    !Object.keys(diff.devices.missingNow).length;
  return redact(diff, ctx.secrets);
}
