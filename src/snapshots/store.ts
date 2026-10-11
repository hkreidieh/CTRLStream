/**
 * Snapshots (DESIGN 5): ~/.ctrlstream/snapshots/<ISO8601>-<label>/ with manifest.json (no
 * secrets), profile/ (byte-exact copy, service.json included so a restore brings the key back)
 * and scenes/<collection>.json. Saving only reads OBS files, so it works while OBS runs and is
 * then tagged takenWhileRunning.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { ToolError } from '../errors.js';
import { readEncodersFromLogs, readJson } from '../obs/files.js';
import { enumerateDevices } from '../probes/devices.js';
import type { Device } from '../probes/devices.js';
import { copyIntoPrivate, ensurePrivateDir, listDirs, writePrivateJson } from '../safety/store.js';
import { flushSceneCollection } from './flush.js';
import type { FlushResult } from './flush.js';
import { collectState } from './state.js';
import type { AudioState, InputState, OutputState, VideoState } from './state.js';
import type { ServiceInfo } from '../obs/files.js';

export interface DeviceLite {
  id: string;
  name: string;
}

export interface Manifest {
  id: string;
  label: string;
  note?: string;
  /** Steps the user still had to do when this was saved (e.g. "paste stream key", "pick display"). */
  pending?: string[];
  /** True when nothing was pending. Absent in snapshots made before this field existed. */
  complete?: boolean;
  createdAt: string;
  takenWhileRunning: boolean;
  obsVersion: string | null;
  platform: string;
  profile: string | null;
  profileDir: string | null;
  sceneCollection: string | null;
  sceneCollectionFile: string | null;
  video: VideoState;
  output: OutputState;
  audio: AudioState;
  streamService: Omit<ServiceInfo, 'settings'> | null;
  encoders: string[];
  devices: { cameras: DeviceLite[]; microphones: DeviceLite[]; speakers: DeviceLite[]; displays: DeviceLite[] } | null;
  scenes: string[];
  inputs: InputState[];
}

export function snapshotsRoot(ctx: Ctx): string {
  return path.join(ctx.dataDir, 'snapshots');
}

export function slug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snapshot';
}

const lite = (d: Device[]): DeviceLite[] => d.filter((x) => x.available).map(({ id, name }) => ({ id, name }));

export async function buildManifest(ctx: Ctx, id: string, label: string, note: string | undefined, running: boolean, pending: string[] = []): Promise<{ manifest: Manifest; state: Awaited<ReturnType<typeof collectState>> }> {
  const state = await collectState(ctx);
  const enc = await readEncodersFromLogs(ctx.paths);
  let devices: Manifest['devices'] = null;
  if (ctx.obs.connected) {
    try {
      const inv = await enumerateDevices(ctx);
      devices = { cameras: lite(inv.cameras), microphones: lite(inv.microphones), speakers: lite(inv.speakers), displays: lite(inv.displays) };
    } catch {
      devices = null;
    }
  }
  const svc = state.streamService;
  const manifest: Manifest = {
    id,
    label,
    ...(note ? { note } : {}),
    pending,
    complete: pending.length === 0,
    createdAt: ctx.now().toISOString(),
    takenWhileRunning: running,
    obsVersion: state.obsVersion,
    platform: state.platform,
    profile: state.profile,
    profileDir: state.active.profile?.dir ?? null,
    sceneCollection: state.sceneCollection,
    sceneCollectionFile: state.active.collection?.file ?? null,
    video: state.video,
    output: state.output,
    audio: state.audio,
    streamService: svc ? { type: svc.type, ...(svc.service ? { service: svc.service } : {}), ...(svc.server ? { server: svc.server } : {}), key: svc.key } : null,
    encoders: enc?.video.map((e) => e.id) ?? [],
    devices,
    scenes: state.scenes,
    inputs: state.inputs,
  };
  return { manifest, state };
}

export async function saveSnapshot(ctx: Ctx, label: string, note?: string, pending: string[] = []): Promise<{ manifest: Manifest; dir: string; copied: string[]; flush: FlushResult }> {
  const running = !!(await ctx.proc.find());
  if (running && !ctx.obs.connected) await ctx.obs.connect().catch(() => undefined);
  const stamp = ctx.now().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  const id = `${stamp}-${slug(label)}`;
  const dir = path.join(snapshotsRoot(ctx), id);
  if (existsSync(dir)) throw new ToolError('ALREADY_EXISTS', `Snapshot ${id} already exists.`, 'Wait a second and save again, or use a different label.');
  // Scenes and inputs in the manifest come from the websocket when connected (buildManifest);
  // the copied collection file is flushed first so it matches them.
  const { manifest, state } = await buildManifest(ctx, id, label, note, running, pending);
  const flush = running ? await flushSceneCollection(ctx, state.active.collection?.path) : { flushed: false, fileChanged: false, waitedMs: 0 };
  await ensurePrivateDir(ctx, dir);
  const copied: string[] = [];
  if (state.active.profile && existsSync(state.active.profile.path)) {
    await copyIntoPrivate(ctx, state.active.profile.path, path.join(dir, 'profile'));
    copied.push('profile/');
  }
  if (state.active.collection && existsSync(state.active.collection.path)) {
    await copyIntoPrivate(ctx, state.active.collection.path, path.join(dir, 'scenes', state.active.collection.file));
    copied.push(`scenes/${state.active.collection.file}`);
  }
  await writePrivateJson(ctx, path.join(dir, 'manifest.json'), manifest);
  return { manifest, dir, copied, flush };
}

export async function listSnapshots(ctx: Ctx): Promise<Manifest[]> {
  const root = snapshotsRoot(ctx);
  const out: Manifest[] = [];
  for (const d of await listDirs(root)) {
    const m = await readJson<Manifest>(path.join(root, d, 'manifest.json'));
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export async function loadSnapshot(ctx: Ctx, id: string): Promise<{ manifest: Manifest; dir: string }> {
  if (!/^[\w.:-]+$/.test(id)) throw new ToolError('INVALID_ARGUMENT', `Not a snapshot id: ${id}`, 'Use an id from snapshot_list.', 'snapshot_list');
  const dir = path.join(snapshotsRoot(ctx), id);
  const manifest = await readJson<Manifest>(path.join(dir, 'manifest.json'));
  if (!manifest) throw new ToolError('NOT_FOUND', `No snapshot with id ${id}.`, 'Call snapshot_list for the ids that exist.', 'snapshot_list');
  return { manifest, dir };
}

/** The newest snapshot labelled known-good (the troubleshoot skill compares against it). */
export async function latestKnownGood(ctx: Ctx): Promise<Manifest | null> {
  return (await listSnapshots(ctx)).find((m) => m.label === 'known-good') ?? null;
}
