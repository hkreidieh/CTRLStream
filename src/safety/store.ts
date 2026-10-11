/**
 * Writes into ctrlstream's own directory (~/.ctrlstream): backups, snapshots, undo log.
 * Directories are created mode 700 (DESIGN 5). JSON written here passes through redact()
 * first; only the byte-exact profile copies (which must include service.json to be restorable)
 * are copied raw, and they never appear in any tool result.
 */
import { chmod, copyFile, cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { ToolError } from '../errors.js';
import { redact } from './redact.js';

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertPrivate(ctx: Ctx, target: string): void {
  if (!isInside(ctx.dataDir, target)) {
    throw new ToolError('INTERNAL', `Refusing to write outside ${ctx.dataDir}: ${target}`, 'This is a bug in ctrlstream; nothing was written.');
  }
}

export async function ensurePrivateDir(ctx: Ctx, dir: string): Promise<void> {
  assertPrivate(ctx, dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask and does not apply to existing dirs.
  const rel = path.relative(ctx.dataDir, dir);
  let cur = ctx.dataDir;
  await chmod(cur, 0o700).catch(() => undefined);
  for (const part of rel ? rel.split(path.sep) : []) {
    cur = path.join(cur, part);
    await chmod(cur, 0o700).catch(() => undefined);
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, file);
}

/** Redacted JSON into the private dir. */
export async function writePrivateJson(ctx: Ctx, file: string, data: unknown): Promise<void> {
  assertPrivate(ctx, file);
  await ensurePrivateDir(ctx, path.dirname(file));
  await atomicWrite(file, `${JSON.stringify(redact(data, ctx.secrets), null, 2)}\n`);
}

/** Append one redacted JSON line. */
export async function appendPrivateLine(ctx: Ctx, file: string, data: unknown): Promise<void> {
  assertPrivate(ctx, file);
  await ensurePrivateDir(ctx, path.dirname(file));
  const { appendFile } = await import('node:fs/promises');
  await appendFile(file, `${JSON.stringify(redact(data, ctx.secrets))}\n`, { mode: 0o600 });
}

/** Byte-exact copy of a file or directory into the private dir. */
export async function copyIntoPrivate(ctx: Ctx, src: string, dst: string): Promise<void> {
  assertPrivate(ctx, dst);
  await ensurePrivateDir(ctx, path.dirname(dst));
  const st = await stat(src);
  if (st.isDirectory()) {
    await cp(src, dst, { recursive: true, force: true });
  } else {
    await copyFile(src, dst);
  }
}

export async function removePrivate(ctx: Ctx, target: string): Promise<void> {
  assertPrivate(ctx, target);
  await rm(target, { recursive: true, force: true });
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}
