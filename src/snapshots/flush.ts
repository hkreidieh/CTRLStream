/**
 * Make OBS write its in-memory scene collection to disk before we copy the file.
 *
 * Measured on the real OBS 32.2.2 (2026-10-11): creating a scene or input reaches the collection
 * file about 250 ms later, but a SetInputSettings change made over the websocket was still not on
 * disk 12 s later. Creating and removing a scene makes OBS save the whole collection once
 * (about 250 ms later), current settings included, with no trace of the scratch scene. So when
 * connected we do that with the scratch scene, then wait for the file's mtime to settle (up to
 * 5 s) before copying it.
 */
import { stat } from 'node:fs/promises';
import type { Ctx } from '../context.js';
import { SCRATCH_SCENE, cleanupScratch } from '../probes/devices.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mtime(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

export interface FlushResult {
  flushed: boolean;
  fileChanged: boolean;
  waitedMs: number;
}

export async function flushSceneCollection(ctx: Ctx, collectionPath: string | null | undefined): Promise<FlushResult> {
  if (!ctx.obs.connected || !collectionPath) return { flushed: false, fileChanged: false, waitedMs: 0 };
  const start = Date.now();
  const m0 = await mtime(collectionPath);
  try {
    await cleanupScratch(ctx);
    await ctx.obs.call('CreateScene', { sceneName: SCRATCH_SCENE });
    await ctx.obs.call('RemoveScene', { sceneName: SCRATCH_SCENE });
  } catch {
    await ctx.obs.tryCall('RemoveScene', { sceneName: SCRATCH_SCENE });
    return { flushed: false, fileChanged: false, waitedMs: Date.now() - start };
  }
  const maxWait = 5000 * ctx.timing.waitScale;
  const step = Math.max(10, Math.min(250, maxWait / 10));
  let last = m0;
  let changed = false;
  let stableSince = Date.now();
  while (Date.now() - start < maxWait) {
    await sleep(step);
    const m = await mtime(collectionPath);
    if (m !== last) {
      changed = true;
      last = m;
      stableSince = Date.now();
    } else if (changed && Date.now() - stableSince >= 500 * ctx.timing.waitScale) {
      break;
    }
  }
  return { flushed: true, fileChanged: changed, waitedMs: Date.now() - start };
}
