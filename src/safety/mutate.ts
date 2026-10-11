/**
 * The single wrapper every mutating tool goes through (CLAUDE.md invariants):
 *  1. on first use in a session, back up the active profile and scene collection;
 *  2. capture `before`, apply, capture `after`;
 *  3. append the undo log line with the inverse.
 */
import type { Ctx } from '../context.js';
import { ensureSessionBackup } from './backup.js';
import { recordUndo } from './undo.js';
import type { UndoAction } from './undo.js';

export interface MutateSpec<B, T> {
  tool: string;
  args?: unknown;
  /** Start/stop of outputs is logged but cannot be undone. */
  undoable?: boolean;
  before?: () => Promise<B>;
  apply: (before: B) => Promise<T>;
  after?: (result: T) => Promise<unknown>;
  inverse?: (before: B, result: T) => UndoAction | null;
}

export async function mutate<B = undefined, T = unknown>(ctx: Ctx, spec: MutateSpec<B, T>): Promise<T> {
  await ensureSessionBackup(ctx);
  const before = (spec.before ? await spec.before() : undefined) as B;
  const result = await spec.apply(before);
  let after: unknown;
  try {
    after = spec.after ? await spec.after(result) : undefined;
  } catch {
    after = undefined;
  }
  const inverse = spec.undoable === false || !spec.inverse ? null : spec.inverse(before, result);
  await recordUndo(ctx, { tool: spec.tool, undoable: !!inverse, args: spec.args, before, after, inverse });
  return result;
}
