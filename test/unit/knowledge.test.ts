import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext } from '../../src/context.js';
import { EMBEDDED_KNOWLEDGE, readKnowledge } from '../../src/knowledge.js';
import { ROOT, expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness | undefined;
const tmps: string[] = [];
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('knowledge tables embedded in the bundle', () => {
  it('the embedded copies are exactly the files in knowledge/', () => {
    for (const name of ['platforms', 'encoders'] as const) {
      expect(EMBEDDED_KNOWLEDGE[name]).toEqual(JSON.parse(readFileSync(path.join(ROOT, 'knowledge', `${name}.json`), 'utf8')));
    }
  });

  it('are used by default, with no knowledge/ folder needed at run time', async () => {
    const prev = process.env['CTRLSTREAM_KNOWLEDGE_DIR'];
    delete process.env['CTRLSTREAM_KNOWLEDGE_DIR'];
    try {
      const ctx = createContext({ dataDir: path.join(tmpdir(), 'ctrlstream-unused') });
      expect(ctx.knowledgeDir).toBeNull();
      const r = await readKnowledge(ctx, 'platforms');
      expect(r.from).toBe('embedded');
      expect(Object.keys((r.data as { platforms: object }).platforms)).toContain('twitch');
    } finally {
      if (prev !== undefined) process.env['CTRLSTREAM_KNOWLEDGE_DIR'] = prev;
    }
  });

  it('CTRLSTREAM_KNOWLEDGE_DIR wins when set, and falls back to the embedded copy for a missing file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ctrlstream-knowledge-'));
    tmps.push(dir);
    writeFileSync(path.join(dir, 'platforms.json'), JSON.stringify({ schemaVersion: 99, platforms: { testtube: { displayName: 'TestTube' } } }));
    const prev = process.env['CTRLSTREAM_KNOWLEDGE_DIR'];
    process.env['CTRLSTREAM_KNOWLEDGE_DIR'] = dir;
    try {
      const ctx = createContext({ dataDir: path.join(dir, 'data') });
      expect(ctx.knowledgeDir).toBe(dir);
      expect(await readKnowledge(ctx, 'platforms')).toMatchObject({ from: 'override', data: { schemaVersion: 99 } });
      expect((await readKnowledge(ctx, 'encoders')).from).toBe('embedded');
    } finally {
      if (prev === undefined) delete process.env['CTRLSTREAM_KNOWLEDGE_DIR'];
      else process.env['CTRLSTREAM_KNOWLEDGE_DIR'] = prev;
    }
  });

  it('the knowledge tool says where the table came from', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('knowledge', { file: 'encoders' }))).toMatchObject({ from: 'embedded', schemaVersion: 1 });
  });
});
