/**
 * Platform bitrate caps from knowledge/platforms.json (written by the skills agent; schemaVersion 1).
 * Lookup follows that file's own `rules.capLookup`: for rtmp_common compare the service name with
 * platforms.*.obs.match.serviceNames; for rtmp_custom test the server URL against
 * obs.match.serverUrlPatterns (case-insensitive regexes). The cap is video.maxBitrateKbps.value
 * (null means the platform publishes none).
 */
import type { Ctx } from '../context.js';
import { readKnowledge } from '../knowledge.js';

export interface PlatformCap {
  platform: string;
  displayName: string;
  maxVideoBitrateKbps: number | null;
  confidence: string | null;
}

interface PlatformsFile {
  schemaVersion?: number;
  rules?: { uploadHeadroomFraction?: number };
  platforms?: Record<
    string,
    {
      displayName?: string;
      obs?: { match?: { serviceType?: string; serviceNames?: string[]; serverUrlPatterns?: string[] } };
      video?: { maxBitrateKbps?: { value?: number | null; confidence?: string } };
    }
  >;
}

export async function loadPlatforms(ctx: Ctx): Promise<PlatformsFile | null> {
  return (await readKnowledge<PlatformsFile>(ctx, 'platforms')).data ?? null;
}

export function uploadHeadroom(file: PlatformsFile | null): number {
  const f = file?.rules?.uploadHeadroomFraction;
  return typeof f === 'number' && f > 0 && f <= 1 ? f : 0.7;
}

export function matchPlatform(file: PlatformsFile | null, service: { type: string; service?: string | undefined; server?: string | undefined }): PlatformCap | null {
  for (const [id, p] of Object.entries(file?.platforms ?? {})) {
    const m = p.obs?.match;
    if (!m) continue;
    let hit = false;
    if (service.type === 'rtmp_common' && m.serviceType === 'rtmp_common') {
      hit = !!service.service && (m.serviceNames ?? []).includes(service.service);
    } else if (service.type === 'rtmp_custom' && m.serviceType === 'rtmp_custom' && service.server) {
      hit = (m.serverUrlPatterns ?? []).some((re) => {
        try {
          return new RegExp(re, 'i').test(service.server!);
        } catch {
          return false;
        }
      });
    }
    if (!hit) continue;
    const cap = p.video?.maxBitrateKbps;
    return {
      platform: id,
      displayName: p.displayName ?? id,
      maxVideoBitrateKbps: typeof cap?.value === 'number' ? cap.value : null,
      confidence: cap?.confidence ?? null,
    };
  }
  return null;
}
