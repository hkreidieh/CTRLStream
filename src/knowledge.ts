/**
 * The knowledge tables (knowledge/platforms.json and knowledge/encoders.json, written by the skills
 * agent) are embedded in the bundle at build time, so the npm package and the .mcpb need no
 * knowledge/ folder at run time. CTRLSTREAM_KNOWLEDGE_DIR (ctx.knowledgeDir) is a development
 * override: when set and the file exists there, it wins.
 */
import path from 'node:path';
import type { Ctx } from './context.js';
import { readJson } from './obs/files.js';
import encoders from '../knowledge/encoders.json' with { type: 'json' };
import platforms from '../knowledge/platforms.json' with { type: 'json' };

export type KnowledgeName = 'platforms' | 'encoders';

export const EMBEDDED_KNOWLEDGE: Record<KnowledgeName, Record<string, unknown>> = {
  platforms: platforms as Record<string, unknown>,
  encoders: encoders as Record<string, unknown>,
};

export interface KnowledgeRead<T> {
  data: T;
  from: 'embedded' | 'override';
}

export async function readKnowledge<T = Record<string, unknown>>(ctx: Ctx, name: KnowledgeName): Promise<KnowledgeRead<T>> {
  if (ctx.knowledgeDir) {
    const fromDir = await readJson<T>(path.join(ctx.knowledgeDir, `${name}.json`));
    if (fromDir) return { data: fromDir, from: 'override' };
  }
  return { data: EMBEDDED_KNOWLEDGE[name] as T, from: 'embedded' };
}
