/** Which profile and scene collection are active: from the websocket when connected, else from user.ini. */
import type { Ctx } from '../context.js';
import { findProfile, findSceneCollection, resolveProfileAndCollection } from '../obs/files.js';
import type { CollectionEntry, ProfileEntry } from '../obs/files.js';

export interface Active {
  profile: ProfileEntry | null;
  collection: CollectionEntry | null;
  profileName: string | null;
  collectionName: string | null;
  via: 'websocket' | 'files';
}

export async function activeProfileAndCollection(ctx: Ctx): Promise<Active> {
  if (ctx.obs.connected) {
    const [pl, cl] = await Promise.all([ctx.obs.tryCall('GetProfileList'), ctx.obs.tryCall('GetSceneCollectionList')]);
    if (pl && cl) {
      const profile = await findProfile(ctx.paths, pl.currentProfileName);
      const collection = await findSceneCollection(ctx.paths, cl.currentSceneCollectionName);
      return { profile, collection, profileName: pl.currentProfileName, collectionName: cl.currentSceneCollectionName, via: 'websocket' };
    }
  }
  const { profile, collection } = await resolveProfileAndCollection(ctx.paths);
  return { profile, collection, profileName: profile?.name ?? null, collectionName: collection?.name ?? null, via: 'files' };
}
