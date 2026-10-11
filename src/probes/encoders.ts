/** Available encoders, from the newest OBS log that lists them, cross-checked against the GPUs. */
import type { Ctx } from '../context.js';
import { FAMILY_HINTS, SIMPLE_ENCODERS, SIMPLE_STREAM_ENCODER_IDS, encoderFamily } from '../obs/config-keys.js';
import type { EncoderFamily } from '../obs/config-keys.js';
import { readKnowledge } from '../knowledge.js';
import { readEncodersFromLogs } from '../obs/files.js';
import { gpuFamily } from './system.js';

export interface EncoderReport {
  logFile: string | null;
  video: Array<{ id: string; name: string; family: EncoderFamily }>;
  audio: string[];
  families: Array<{ family: EncoderFamily; ids: string[]; hint: string }>;
  /** Simple-mode StreamEncoder values usable on this machine (for output_set_simple). */
  simpleStreamEncoders: string[];
  notes: string[];
}

export type EncoderMap = Record<string, string[]>;

interface EncodersKnowledge {
  simpleModeEncoders?: Record<string, { libobsId?: string; libobsIdByObsVersion?: Record<string, string>; libobsFallbackIds?: string[]; streamAndRecord?: string }>;
}

/** The built-in, source-verified table (config-keys.ts), used when knowledge/ is missing. */
export function builtinEncoderMap(): EncoderMap {
  return Object.fromEntries(Object.entries(SIMPLE_ENCODERS).map(([k, v]) => [k, v.libobs]));
}

/**
 * Simple-mode id -> libobs ids, from knowledge/encoders.json (the skills agent's table, the single
 * source of truth for both id generations), falling back to the built-in table.
 */
export async function loadEncoderMap(ctx: Ctx): Promise<{ map: EncoderMap; from: 'knowledge' | 'builtin' }> {
  const k = (await readKnowledge<EncodersKnowledge>(ctx, 'encoders')).data;
  if (!k?.simpleModeEncoders) return { map: builtinEncoderMap(), from: 'builtin' };
  const map: EncoderMap = {};
  for (const [id, e] of Object.entries(k.simpleModeEncoders)) {
    const ids = [...Object.values(e.libobsIdByObsVersion ?? {}).reverse(), ...(e.libobsId ? [e.libobsId] : []), ...(e.libobsFallbackIds ?? [])];
    map[id] = Array.from(new Set(ids));
  }
  return { map, from: 'knowledge' };
}

export function simpleEncodersAvailable(libobsIds: string[], map: EncoderMap = builtinEncoderMap()): string[] {
  return SIMPLE_STREAM_ENCODER_IDS.filter((id) => (map[id] ?? SIMPLE_ENCODERS[id]!.libobs).some((l) => libobsIds.includes(l)));
}

export async function encoderReport(ctx: Ctx, withGpuCheck = true): Promise<EncoderReport> {
  const found = await readEncodersFromLogs(ctx.paths);
  const { map } = await loadEncoderMap(ctx);
  const video = (found?.video ?? []).map((e) => ({ ...e, family: encoderFamily(e.id) }));
  const fams = new Map<EncoderFamily, string[]>();
  for (const v of video) fams.set(v.family, [...(fams.get(v.family) ?? []), v.id]);
  const notes: string[] = [];
  if (!found) notes.push('No OBS log with an "Available Encoders" list was found. Launch OBS once (obs_launch), then call obs_encoders again.');
  if (withGpuCheck && found) {
    try {
      const sys = await ctx.system.info();
      const gpuFams = new Set(sys.gpus.map((g) => gpuFamily(g.vendor, g.model)));
      if (gpuFams.has('nvidia') && !fams.has('nvenc')) notes.push('An NVIDIA GPU is present but OBS lists no NVENC encoder: the NVIDIA driver is probably missing or too old.');
      if (gpuFams.has('amd') && !fams.has('amf')) notes.push('An AMD GPU is present but OBS lists no AMF encoder: the AMD driver is probably missing or too old.');
      if (gpuFams.has('intel') && !fams.has('qsv') && ctx.paths.platform === 'win32') notes.push('An Intel GPU is present but OBS lists no Quick Sync encoder: the Intel graphics driver may be missing.');
    } catch {
      notes.push('GPU check skipped: system information unavailable.');
    }
  }
  return {
    logFile: found?.file ?? null,
    video,
    audio: (found?.audio ?? []).map((a) => a.id),
    families: [...fams.entries()].map(([family, ids]) => ({ family, ids, hint: FAMILY_HINTS[family] })),
    simpleStreamEncoders: simpleEncodersAvailable(video.map((v) => v.id), map),
    notes,
  };
}

interface FamiliesKnowledge {
  simpleModeEncoders?: Record<string, { vendor?: string; codec?: string; streamAndRecord?: string }>;
  families?: Record<string, { displayName?: string; streaming?: { codecByPlatform?: { value?: Record<string, string> } } }>;
}

export interface EncoderSuggestion {
  encoder: string;
  family: string;
}

/**
 * The best encoder this machine can use, from knowledge/encoders.json: for each hardware vendor
 * family, its recommended Simple-mode encoder for the platform (streaming.codecByPlatform), then
 * that vendor's other H.264 encoders; the first one OBS actually loaded wins; x264 otherwise.
 */
export async function suggestEncoder(ctx: Ctx, available: string[], platform: string | null): Promise<EncoderSuggestion> {
  const k = (await readKnowledge<FamiliesKnowledge>(ctx, 'encoders')).data;
  const sme = k.simpleModeEncoders ?? {};
  const fams = k.families ?? {};
  for (const [vendor, fam] of Object.entries(fams)) {
    if (vendor === 'x264') continue;
    const byPlatform = fam.streaming?.codecByPlatform?.value ?? {};
    const preferred = (platform && byPlatform[platform]) || byPlatform['twitch'];
    const sameVendor = Object.entries(sme)
      .filter(([, e]) => e.vendor === vendor && e.codec === 'h264' && e.streamAndRecord !== 'record-only')
      .map(([id]) => id);
    for (const id of [preferred, ...sameVendor]) {
      if (id && available.includes(id)) return { encoder: id, family: fam.displayName ?? vendor };
    }
  }
  return { encoder: 'x264', family: fams['x264']?.displayName ?? 'x264 (CPU)' };
}

/** Display name of the vendor family a Simple-mode encoder belongs to. */
export async function familyName(ctx: Ctx, simpleId: string): Promise<string> {
  const k = (await readKnowledge<FamiliesKnowledge>(ctx, 'encoders')).data;
  const vendor = k.simpleModeEncoders?.[simpleId]?.vendor;
  if (!vendor) return simpleId;
  return k.families?.[vendor === 'cpu' ? 'x264' : vendor]?.displayName ?? vendor;
}
