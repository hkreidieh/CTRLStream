/**
 * Tool definitions and the one place a tool runs: runTool() validates input with the zod schema,
 * calls the handler, shapes `{ ok: true, ...data }` or `{ ok: false, error }`, and applies
 * redact() to the whole result before anything leaves the process.
 */
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ToolError, toErrorShape } from '../errors.js';
import { redact } from '../safety/redact.js';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ImageOut {
  data: string;
  mimeType: string;
}

const IMAGES = Symbol('images');

export type HandlerResult = Record<string, unknown> & { [IMAGES]?: ImageOut[] };

export function withImages(result: Record<string, unknown>, images: ImageOut[]): HandlerResult {
  const r = result as HandlerResult;
  Object.defineProperty(r, IMAGES, { value: images, enumerable: false });
  return r;
}

export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** M in DESIGN 4: triggers the session backup and writes the undo log (through mutate()). */
  mutating: boolean;
  /** F in DESIGN 4: writes OBS config files (through fileWrite()), refuses while OBS runs. */
  fileWriting: boolean;
  annotations?: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: Ctx) => Promise<HandlerResult>;
}

export function defineTool<S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

export interface RunOutput {
  json: Record<string, unknown>;
  images: ImageOut[];
  isError: boolean;
}

export async function runTool(ctx: Ctx, spec: ToolSpec, rawArgs: unknown): Promise<RunOutput> {
  ctx.session.backupJustCreated = false;
  let json: Record<string, unknown>;
  let images: ImageOut[] = [];
  let isError = false;
  try {
    const parsed = z.object(spec.input).strict().safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `Invalid arguments for ${spec.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        'Fix the arguments to match the tool schema and call again.',
      );
    }
    const result = await spec.handler(parsed.data as never, ctx);
    images = result[IMAGES] ?? [];
    json = { ok: true, ...result };
    if (ctx.session.backupJustCreated && ctx.session.backupDir) {
      json['sessionBackup'] = { created: true, dir: ctx.session.backupDir, note: 'First change this session: the profile and scene collection were backed up first (backup_list).' };
    }
  } catch (err) {
    isError = true;
    json = { ok: false, error: toErrorShape(err) };
  }
  return { json: redact(json, ctx.secrets), images, isError };
}
