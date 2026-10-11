/**
 * Closed-state evidence. At startup (and on profile activation) OBS rewrites a Simple-mode
 * StreamEncoder/RecEncoder it cannot load to "x264" and saves it (frontend/widgets/
 * OBSBasic_Profiles.cpp CheckForSimpleModeX264Fallback, OBS 32.2.2), so after a launch the evidence
 * of ENCODER_UNAVAILABLE is gone. Whenever ctrlstream reads the profile from disk with OBS closed
 * it records what the encoders were and whether OBS had loaded them, in memory for the session and
 * in ~/.ctrlstream/closed-state.json for the next session. diagnose uses the record after a launch.
 */
import path from 'node:path';
import type { Ctx } from '../context.js';
import { SIMPLE_ENCODERS } from '../obs/config-keys.js';
import { readEncodersFromLogs, readJson, resolveProfileAndCollection } from '../obs/files.js';
import { loadEncoderMap } from '../probes/encoders.js';
import { removePrivate, writePrivateJson } from '../safety/store.js';
import { fileReader } from '../snapshots/state.js';

export interface ClosedState {
  readAt: string;
  profile: string | null;
  mode: string;
  encoders: Array<{ setting: 'StreamEncoder' | 'RecEncoder'; value: string; loadedByObs: boolean | null }>;
  encodersLogFile: string | null;
}

const memory = new WeakMap<Ctx, ClosedState | null>();

export function closedStateFile(ctx: Ctx): string {
  return path.join(ctx.dataDir, 'closed-state.json');
}

/** Read the profile from disk (only meaningful with OBS closed) and remember it. */
export async function recordClosedState(ctx: Ctx): Promise<ClosedState | null> {
  if (await ctx.proc.find()) return null;
  const { profile } = await resolveProfileAndCollection(ctx.paths);
  if (!profile) return null;
  const r = await fileReader(profile.path);
  const mode = (r('Output', 'Mode') ?? 'Simple').toLowerCase() === 'advanced' ? 'Advanced' : 'Simple';
  const log = await readEncodersFromLogs(ctx.paths);
  const loaded = log ? log.video.map((v) => v.id) : null;
  const { map } = await loadEncoderMap(ctx);
  const encoders: ClosedState['encoders'] = [];
  for (const setting of ['StreamEncoder', 'RecEncoder'] as const) {
    const value = r('SimpleOutput', setting);
    if (!value) continue;
    const ids = map[value] ?? SIMPLE_ENCODERS[value]?.libobs ?? [];
    encoders.push({ setting, value, loadedByObs: loaded === null || ids.length === 0 ? null : ids.some((id) => loaded.includes(id)) });
  }
  const state: ClosedState = { readAt: ctx.now().toISOString(), profile: profile.name, mode, encoders, encodersLogFile: log?.file ?? null };
  memory.set(ctx, state);
  await writePrivateJson(ctx, closedStateFile(ctx), state);
  return state;
}

export async function lastClosedState(ctx: Ctx): Promise<ClosedState | null> {
  const m = memory.get(ctx);
  if (m !== undefined) return m;
  return readJson<ClosedState>(closedStateFile(ctx));
}

/** Forget it once this session sets the encoder itself (the old evidence no longer applies). */
export async function clearClosedState(ctx: Ctx): Promise<void> {
  memory.set(ctx, null);
  await removePrivate(ctx, closedStateFile(ctx));
}

export interface EncoderReplacement {
  setting: 'StreamEncoder' | 'RecEncoder';
  was: string;
  now: string;
  readAt: string;
}

/**
 * After a launch: encoders that were on disk but not loadable while OBS was closed, and that OBS
 * has since replaced (its fallback is always x264).
 */
export function encoderReplacements(last: ClosedState | null, live: { profile: string | null; streamEncoder: string | null; recEncoder: string | null; lastStart: Date | null }): EncoderReplacement[] {
  if (!last || !live.lastStart || last.profile !== live.profile || last.mode !== 'Simple') return [];
  // OBS names its log by start time to the second, and records are only made while OBS is closed,
  // so a record from within that second (before the launch) still predates the start.
  if (new Date(last.readAt).getTime() > live.lastStart.getTime() + 999) return [];
  const out: EncoderReplacement[] = [];
  for (const e of last.encoders) {
    if (e.loadedByObs !== false) continue;
    const now = e.setting === 'StreamEncoder' ? live.streamEncoder : live.recEncoder;
    if (now && now !== e.value && now === 'x264') out.push({ setting: e.setting, was: e.value, now, readAt: last.readAt });
  }
  return out;
}
