/**
 * Session undo log: ~/.ctrlstream/undo/<sessionId>.jsonl, one redacted line per mutation
 * (tool, before, after). The unredacted inverse of each entry is also kept in memory for the
 * life of the session, so undo_last can replay it exactly (a redacted copy would replay
 * "<set>" in place of a real value).
 */
import path from 'node:path';
import type { Ctx } from '../context.js';
import { ToolError } from '../errors.js';
import type { RequestName } from '../obs/client.js';
import { fileWrite } from './file-write.js';
import { appendPrivateLine } from './store.js';

export interface WsRequest {
  requestType: RequestName;
  requestData?: Record<string, unknown>;
}

export type UndoAction =
  | { kind: 'ws'; requests: WsRequest[]; note?: string }
  /** Restore files from copies in the private dir; saved null means the file did not exist. */
  | { kind: 'files'; files: Array<{ target: string; saved: string | null; dir?: boolean }>; note?: string }
  /** Restore stream service type and non-secret settings; the key in OBS is left as it is. */
  | { kind: 'stream_service'; type: string; settings: Record<string, unknown> }
  /** Inverses that need results of earlier steps (ids of recreated items); see registerInverse. */
  | { kind: 'custom'; op: string; data: unknown };

type CustomInverse = (ctx: Ctx, data: unknown) => Promise<Record<string, unknown>>;
const customInverses = new Map<string, CustomInverse>();

export function registerInverse(op: string, fn: CustomInverse): void {
  customInverses.set(op, fn);
}

export interface UndoEntry {
  seq: number;
  ts: string;
  tool: string;
  undoable: boolean;
  args?: unknown;
  before?: unknown;
  after?: unknown;
  undoes?: number;
}

interface MemoryEntry extends UndoEntry {
  inverse: UndoAction | null;
  undone: boolean;
}

const memory = new WeakMap<Ctx, MemoryEntry[]>();

function entries(ctx: Ctx): MemoryEntry[] {
  let list = memory.get(ctx);
  if (!list) {
    list = [];
    memory.set(ctx, list);
  }
  return list;
}

export function undoFile(ctx: Ctx): string {
  return path.join(ctx.dataDir, 'undo', `${ctx.session.id}.jsonl`);
}

export async function recordUndo(ctx: Ctx, e: Omit<UndoEntry, 'seq' | 'ts'> & { inverse: UndoAction | null }): Promise<UndoEntry> {
  const seq = ++ctx.session.undoSeq;
  const entry: MemoryEntry = { ...e, seq, ts: ctx.now().toISOString(), undone: false };
  entries(ctx).push(entry);
  const { inverse: _inverse, undone: _undone, ...line } = entry;
  await appendPrivateLine(ctx, undoFile(ctx), { ...line, inverseKind: entry.inverse?.kind ?? null });
  return line;
}

const INPUT_TOOLS = new Set(['input_create', 'input_remove', 'input_settings_set', 'input_audio_set']);
const SOURCE_TOOLS = new Set(['filter_add', 'filter_set', 'filter_remove']);

/** When this session last changed each input (by name), from the session's change history. */
export function inputsTouched(ctx: Ctx): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const e of entries(ctx)) {
    const a = (e.args ?? {}) as Record<string, unknown>;
    const name = INPUT_TOOLS.has(e.tool) ? a['name'] : SOURCE_TOOLS.has(e.tool) ? a['source'] : undefined;
    if (typeof name !== 'string') continue;
    const t = new Date(e.ts);
    const prev = out.get(name);
    if (!prev || t > prev) out.set(name, t);
  }
  return out;
}

export function pendingUndo(ctx: Ctx): MemoryEntry[] {
  return entries(ctx).filter((e) => e.inverse && !e.undone);
}

export function undoHistory(ctx: Ctx): Array<Pick<MemoryEntry, 'seq' | 'tool' | 'undoable' | 'undone' | 'ts'>> {
  return entries(ctx).map(({ seq, tool, undoable, undone, ts }) => ({ seq, tool, undoable, undone, ts }));
}

/** Drop values that would replay as placeholders. */
function scrubPlaceholders(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === '<set>' || v === '<empty>' || (typeof v === 'string' && v.includes('<redacted>'))) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? scrubPlaceholders(v as Record<string, unknown>) : v;
  }
  return out;
}

export async function runInverse(ctx: Ctx, action: UndoAction): Promise<Record<string, unknown>> {
  if (action.kind === 'ws') {
    for (const r of action.requests) {
      await ctx.obs.call(r.requestType, scrubPlaceholders(r.requestData) as never);
    }
    return { replayed: action.requests.map((r) => r.requestType) };
  }
  if (action.kind === 'files') {
    const restored = await fileWrite(ctx, 'undo_last', async (w) => {
      for (const f of action.files) {
        if (f.saved === null) await w.remove(f.target);
        else if (f.dir) {
          await w.remove(f.target);
          await w.copyDir(f.saved, f.target);
        } else await w.copyFile(f.saved, f.target);
      }
      return w.written;
    });
    return { restoredFiles: restored.map((p) => path.basename(p)) };
  }
  if (action.kind === 'custom') {
    const fn = customInverses.get(action.op);
    if (!fn) throw new ToolError('INTERNAL', `No undo handler for ${action.op}`, 'This is a bug in ctrlstream.');
    return fn(ctx, action.data);
  }
  const current = await ctx.obs.call('GetStreamServiceSettings');
  const settings: Record<string, unknown> = { ...action.settings };
  const cur = current.streamServiceSettings as Record<string, unknown>;
  // Same type: obs-websocket merges, so the key stays. Different type: carry the key over.
  if (current.streamServiceType !== action.type && typeof cur['key'] === 'string') settings['key'] = cur['key'];
  await ctx.obs.call('SetStreamServiceSettings', { streamServiceType: action.type, streamServiceSettings: settings as never });
  return { replayed: ['SetStreamServiceSettings'] };
}

export async function undoLast(ctx: Ctx): Promise<{ undone: UndoEntry; result: Record<string, unknown>; skippedNotUndoable: string[] }> {
  const list = entries(ctx);
  const skipped: string[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]!;
    if (e.undone || e.tool === 'undo_last') continue;
    if (!e.inverse) {
      skipped.push(e.tool);
      continue;
    }
    const result = await runInverse(ctx, e.inverse);
    e.undone = true;
    await recordUndo(ctx, { tool: 'undo_last', undoable: false, undoes: e.seq, inverse: null });
    const { inverse: _i, undone: _u, ...shown } = e;
    return { undone: shown, result, skippedNotUndoable: skipped };
  }
  throw new ToolError(
    'NOTHING_TO_UNDO',
    skipped.length ? `Nothing undoable left in this session. Not undoable: ${skipped.join(', ')}.` : 'Nothing has been changed in this session.',
    'Starting or stopping outputs cannot be undone. To go back further, use snapshot_restore with a saved snapshot or the session backup (backup_list).',
    'backup_list',
  );
}
