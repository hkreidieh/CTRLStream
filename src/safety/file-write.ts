/**
 * The single gate for writing OBS's own config files. OBS rewrites its config on exit and
 * would clobber anything written while it runs (CLAUDE.md invariant), so fileWrite() checks
 * that OBS is not running and otherwise throws the structured error that names obs_quit.
 * It also refuses any path outside the OBS config, profiles and scene collection dirs.
 */
import { cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { ToolError } from '../errors.js';
import { isInside } from './store.js';

export function obsRunningError(tool: string): ToolError {
  return new ToolError(
    'OBS_RUNNING',
    `${tool} has to edit OBS's config files, and OBS is running. OBS rewrites those files when it exits and would undo the change.`,
    'Call obs_quit (it closes OBS gracefully), retry this tool, then obs_launch to start OBS again. Tell the user OBS will close for a moment.',
    'obs_quit',
  );
}

export async function assertObsClosed(ctx: Ctx, tool: string): Promise<void> {
  if (await ctx.proc.find()) throw obsRunningError(tool);
}

export interface ObsFileWriter {
  writeText(file: string, content: string): Promise<void>;
  writeJson(file: string, data: unknown): Promise<void>;
  copyFile(src: string, dst: string): Promise<void>;
  copyDir(src: string, dst: string): Promise<void>;
  remove(target: string): Promise<void>;
  /** Every path written, for the result and the undo log. */
  readonly written: string[];
}

function allowedRoots(ctx: Ctx): string[] {
  return [ctx.paths.configDir, ctx.paths.profilesDir, ctx.paths.scenesDir];
}

function assertObsPath(ctx: Ctx, target: string): void {
  if (!allowedRoots(ctx).some((root) => isInside(root, target))) {
    throw new ToolError('INTERNAL', `Refusing to write outside the OBS config dir: ${target}`, 'This is a bug in ctrlstream; nothing was written.');
  }
}

async function atomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.ctrlstream-tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}

export async function fileWrite<T>(ctx: Ctx, tool: string, fn: (w: ObsFileWriter) => Promise<T>): Promise<T> {
  await assertObsClosed(ctx, tool);
  const written: string[] = [];
  const w: ObsFileWriter = {
    written,
    async writeText(file, content) {
      assertObsPath(ctx, file);
      await atomic(file, content);
      written.push(file);
    },
    async writeJson(file, data) {
      assertObsPath(ctx, file);
      await atomic(file, `${JSON.stringify(data, null, 4)}\n`);
      written.push(file);
    },
    async copyFile(src, dst) {
      assertObsPath(ctx, dst);
      await mkdir(path.dirname(dst), { recursive: true });
      await cp(src, dst, { force: true });
      written.push(dst);
    },
    async copyDir(src, dst) {
      assertObsPath(ctx, dst);
      await mkdir(dst, { recursive: true });
      await cp(src, dst, { recursive: true, force: true });
      written.push(dst);
    },
    async remove(target) {
      assertObsPath(ctx, target);
      try {
        await stat(target);
      } catch {
        return;
      }
      await rm(target, { recursive: true, force: true });
      written.push(target);
    },
  };
  return fn(w);
}
