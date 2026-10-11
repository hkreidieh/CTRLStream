/**
 * OBS's own streaming service list (plugin_config/rtmp-services/services.json, the copy OBS keeps
 * updated; format_version 5 on OBS 32.2.2). Used for service names, default servers and the
 * limits OBS itself enforces.
 *
 * Verified on the real OBS 32.2.2 (2026-10-11): with Twitch (rtmp_common) and
 * [Stream1] IgnoreRecommended=false, a VBitrate of 8000 was encoded at 6000 kbps with keyint 60
 * (2 s at 30 fps), i.e. OBS clamps to recommended."max video bitrate" and applies "keyint".
 * With rtmp_custom no clamp applied and x264 kept its default keyint of 250 frames (VideoToolbox
 * defaulted to 2 s). Twitch, Nimo TV and Amazon IVS get an "auto" server (rtmp-common.c).
 */
import path from 'node:path';
import type { Ctx } from '../context.js';
import { readKnowledge } from '../knowledge.js';
import { readJson } from './files.js';

export interface ServiceEntry {
  name: string;
  servers?: Array<{ name: string; url: string }>;
  recommended?: Record<string, unknown>;
  common?: boolean;
}

export const AUTO_SERVER_SERVICES = new Set(['Twitch', 'Nimo TV', 'Amazon IVS']);

export async function loadServices(ctx: Ctx): Promise<ServiceEntry[] | null> {
  const j = await readJson<{ services?: ServiceEntry[] }>(path.join(ctx.paths.pluginConfigDir, 'rtmp-services', 'services.json'));
  return j?.services ?? null;
}

export function defaultServer(entry: ServiceEntry | undefined, name: string): string {
  if (AUTO_SERVER_SERVICES.has(name)) return 'auto';
  return entry?.servers?.[0]?.url ?? 'auto';
}

export interface ServiceLimits {
  maxVideoKbps: number | null;
  maxAudioKbps: number | null;
  keyintSec: number | null;
  from: 'obs-services' | 'knowledge' | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Limits OBS applies for an rtmp_common service; nothing for custom servers. */
export async function serviceLimits(ctx: Ctx, svc: { type: string; service?: string | undefined } | null): Promise<ServiceLimits> {
  const none: ServiceLimits = { maxVideoKbps: null, maxAudioKbps: null, keyintSec: null, from: null };
  if (!svc || svc.type !== 'rtmp_common' || !svc.service) return none;
  const entry = (await loadServices(ctx))?.find((s) => s.name === svc.service);
  if (entry?.recommended) {
    return { maxVideoKbps: num(entry.recommended['max video bitrate']), maxAudioKbps: num(entry.recommended['max audio bitrate']), keyintSec: num(entry.recommended['keyint']), from: 'obs-services' };
  }
  // Fallback: knowledge/platforms.json obs.obsEnforced (written by the skills agent).
  const k = (await readKnowledge<{ platforms?: Record<string, { obs?: { match?: { serviceNames?: string[] }; obsEnforced?: Record<string, unknown> | null } }> }>(ctx, 'platforms')).data;
  for (const p of Object.values(k?.platforms ?? {})) {
    if (p.obs?.match?.serviceNames?.includes(svc.service) && p.obs.obsEnforced) {
      const e = p.obs.obsEnforced;
      return { maxVideoKbps: num(e['maxVideoBitrateKbps']), maxAudioKbps: num(e['maxAudioBitrateKbps']), keyintSec: num(e['keyframeIntervalSeconds']), from: 'knowledge' };
    }
  }
  return none;
}
