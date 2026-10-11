/**
 * Backup before mutate (CLAUDE.md invariant). The first mutating call of a session copies the
 * active profile dir and scene collection file to ~/.ctrlstream/backups/<sessionId>/ before
 * anything changes. Pruned to the newest 10 sessions (DESIGN 5).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { findProfile, findSceneCollection, readJson } from '../obs/files.js';
import { flushSceneCollection } from '../snapshots/flush.js';
import { activeProfileAndCollection } from './active.js';
import { copyIntoPrivate, ensurePrivateDir, listDirs, removePrivate, writePrivateJson } from './store.js';

export const BACKUPS_KEPT = 10;

export function backupsRoot(ctx: Ctx): string {
  return path.join(ctx.dataDir, 'backups');
}

export interface BackupMeta {
  sessionId: string;
  createdAt: string;
  profile: string | null;
  collection: string | null;
  obsWasRunning: boolean;
  files: string[];
}

/** Copy profile + collection into `dir`. Shared by session backups and pre-restore copies. */
export async function copyActiveState(ctx: Ctx, dir: string, names?: { profile?: string | null; collection?: string | null }): Promise<Omit<BackupMeta, 'sessionId' | 'createdAt'>> {
  const active = await activeProfileAndCollection(ctx);
  const files: string[] = [];
  await ensurePrivateDir(ctx, dir);
  const profile = names?.profile !== undefined ? (names.profile ? await findProfile(ctx.paths, names.profile) : null) : active.profile;
  const collection = names?.collection !== undefined ? (names.collection ? await findSceneCollection(ctx.paths, names.collection) : null) : active.collection;
  // OBS may hold scene changes it has not written yet; make it write them first.
  if (collection && ctx.obs.connected) await flushSceneCollection(ctx, collection.path);
  if (profile && existsSync(profile.path)) {
    await copyIntoPrivate(ctx, profile.path, path.join(dir, 'profile'));
    files.push(`profile/ (${profile.dir})`);
  }
  if (collection && existsSync(collection.path)) {
    await copyIntoPrivate(ctx, collection.path, path.join(dir, 'scenes', collection.file));
    files.push(`scenes/${collection.file}`);
  }
  return {
    profile: profile?.name ?? active.profileName,
    collection: collection?.name ?? active.collectionName,
    obsWasRunning: !!(await ctx.proc.find()),
    files,
  };
}

export async function ensureSessionBackup(ctx: Ctx): Promise<string | null> {
  if (ctx.session.backupDir) return null;
  const dir = path.join(backupsRoot(ctx), ctx.session.id);
  const copied = await copyActiveState(ctx, dir);
  const meta: BackupMeta = { sessionId: ctx.session.id, createdAt: ctx.now().toISOString(), ...copied };
  await writePrivateJson(ctx, path.join(dir, 'backup.json'), meta);
  ctx.session.backupDir = dir;
  ctx.session.backupJustCreated = true;
  await pruneBackups(ctx);
  return dir;
}

export async function pruneBackups(ctx: Ctx): Promise<string[]> {
  const root = backupsRoot(ctx);
  const dirs = (await listDirs(root)).sort(); // session ids start with an ISO timestamp
  const excess = dirs.length - BACKUPS_KEPT;
  const removed: string[] = [];
  for (const d of dirs.slice(0, Math.max(0, excess))) {
    if (path.join(root, d) === ctx.session.backupDir) continue;
    await removePrivate(ctx, path.join(root, d));
    removed.push(d);
  }
  return removed;
}

export async function listBackups(ctx: Ctx): Promise<Array<BackupMeta & { dir: string; current: boolean }>> {
  const root = backupsRoot(ctx);
  const out: Array<BackupMeta & { dir: string; current: boolean }> = [];
  for (const d of (await listDirs(root)).sort().reverse()) {
    const meta = await readJson<BackupMeta>(path.join(root, d, 'backup.json'));
    if (!meta) continue;
    out.push({ ...meta, dir: path.join(root, d), current: d === ctx.session.id });
  }
  return out;
}
