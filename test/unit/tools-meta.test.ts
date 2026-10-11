import { afterEach, describe, expect, it } from 'vitest';
import { PROMPTS } from '../../src/prompts.generated.js';
import { expectError, expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

describe('get_started', () => {
  it('orients and lists the prompts', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('get_started'));
    expect((r['prompts'] as Array<{ name: string }>).map((p) => p.name)).toEqual(['setup', 'troubleshoot', 'platforms']);
    expect((r['firstSteps'] as string[])[0]).toContain('obs_status');
  });

  it('returns a full guide for clients without prompt support, adapted for the knowledge tool', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('get_started', { guide: 'setup' }));
    expect(String(r['text'])).toContain('knowledge');
    expect(String(r['text'])).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expectError(await h.call('get_started', { guide: 'nope' }), 'INVALID_ARGUMENT');
  });

  it('generated prompts come from the skills', () => {
    for (const p of PROMPTS) expect(p.source).toBe(`plugin/skills/${p.name}/SKILL.md`);
  });
});

describe('knowledge', () => {
  it('summarises a file, returns one platform, or one section', async () => {
    h = await makeHarness();
    const s = expectOk(await h.call('knowledge', { file: 'platforms' }));
    expect(s['platforms']).toEqual(expect.arrayContaining(['twitch', 'youtube', 'kick']));
    const t = expectOk(await h.call('knowledge', { file: 'platforms', platform: 'Twitch' }));
    expect(t['platform']).toBe('twitch');
    expect(t['rules']).toBeTruthy();
    const e = expectOk(await h.call('knowledge', { file: 'encoders', section: 'logIdToSimpleEncoder' }));
    expect((e['value'] as Record<string, unknown>)['obs_nvenc_h264_tex']).toBe('nvenc');
    expectError(await h.call('knowledge', { file: 'platforms', platform: 'myspace' }), 'NOT_FOUND');
    expectError(await h.call('knowledge', { file: 'encoders', section: 'nope' }), 'NOT_FOUND');
  });
});
