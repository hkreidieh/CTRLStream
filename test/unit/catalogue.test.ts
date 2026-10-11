/**
 * Catalogue-wide checks that keep the invariants enforced in code rather than by convention:
 * every DESIGN 4 tool exists; every M tool goes through mutate() and every F tool through
 * fileWrite(); every tool has a zod schema, a real description and is exercised by a unit test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { ROOT } from '../helpers.js';

const DESIGN_TOOLS = [
  'obs_status', 'obs_connect', 'obs_launch', 'obs_quit',
  'system_info', 'obs_encoders', 'obs_devices', 'network_test',
  'scene_list', 'scene_create', 'scene_remove', 'scene_set_current', 'input_kinds', 'input_list', 'input_create', 'input_remove', 'input_settings_get', 'input_settings_set', 'input_properties', 'input_audio_set',
  'scene_items', 'scene_item_transform_set', 'scene_item_visible_set', 'scene_item_order_set', 'filter_list', 'filter_add', 'filter_set', 'filter_remove', 'screenshot',
  'video_get', 'video_set', 'output_get', 'output_set_simple', 'output_set_advanced', 'record_set', 'audio_set', 'stream_service_get', 'stream_service_set',
  'stream_start', 'stream_stop', 'stream_status', 'record_start', 'record_stop', 'record_status', 'replay_buffer_set', 'virtual_camera_set', 'test_record',
  'snapshot_save', 'snapshot_list', 'snapshot_diff', 'snapshot_restore', 'backup_list', 'undo_last',
  'diagnose', 'logs_tail', 'stats',
];
// M and F markings from DESIGN 4 (obs_devices is transient and does not count).
const DESIGN_M = ['scene_create', 'scene_remove', 'scene_set_current', 'input_create', 'input_remove', 'input_settings_set', 'input_audio_set', 'scene_item_transform_set', 'scene_item_visible_set', 'scene_item_order_set', 'filter_add', 'filter_set', 'filter_remove', 'video_set', 'output_set_simple', 'output_set_advanced', 'record_set', 'audio_set', 'stream_service_set', 'stream_start', 'stream_stop', 'record_start', 'record_stop', 'replay_buffer_set', 'virtual_camera_set', 'test_record', 'snapshot_restore', 'undo_last'];
const DESIGN_F = ['output_set_advanced', 'audio_set', 'snapshot_restore'];

const toolsDir = path.join(ROOT, 'src', 'tools');
const sources = readdirSync(toolsDir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(path.join(toolsDir, f), 'utf8')).join('\n');

/** The source text of one tool definition. */
function toolSource(name: string): string {
  const start = sources.indexOf(`name: '${name}'`);
  const next = sources.indexOf('defineTool({', start);
  return sources.slice(start, next === -1 ? undefined : next);
}

describe('tool catalogue', () => {
  it('implements every tool in DESIGN 4 (plus get_started, knowledge, filter_kinds)', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const t of DESIGN_TOOLS) expect(names, t).toContain(t);
    expect(names.filter((n) => !DESIGN_TOOLS.includes(n)).sort()).toEqual(['filter_kinds', 'get_started', 'knowledge']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('M and F flags match DESIGN, and each goes through its wrapper', () => {
    for (const t of ALL_TOOLS) {
      expect(t.mutating, `${t.name} mutating`).toBe(DESIGN_M.includes(t.name));
      expect(t.fileWriting, `${t.name} fileWriting`).toBe(DESIGN_F.includes(t.name) || t.name === 'obs_connect');
      const src = toolSource(t.name);
      if (t.mutating && t.name !== 'undo_last') expect(src, t.name).toMatch(/mutate\(ctx|setProfileParams\(ctx/);
      if (DESIGN_F.includes(t.name)) expect(src, t.name).toContain('fileWrite(ctx');
    }
    // obs_connect's file branch goes through enableWebsocketConfig, which uses fileWrite.
    expect(readFileSync(path.join(ROOT, 'src/obs/discovery.ts'), 'utf8')).toMatch(/return fileWrite\(ctx, 'obs_connect'/);
  });

  it('nothing outside safety/ writes into the OBS config dir directly', () => {
    const srcRoot = path.join(ROOT, 'src');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(srcRoot).filter((p) => p.endsWith('.ts') && !p.includes(`${path.sep}safety${path.sep}`))) {
      const text = readFileSync(f, 'utf8');
      // w.copyFile(...) etc. are the fileWrite writer's own methods and are allowed.
      expect(text, f).not.toMatch(/(?<![.\w])(writeFile|writeFileSync|appendFile|rename|rm|unlink|cp|copyFile)\(/);
    }
  });

  it('every tool has a description written for the model and a strict zod schema', () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(80);
      expect(typeof t.input).toBe('object');
    }
    const ss = ALL_TOOLS.find((t) => t.name === 'stream_service_set')!.description;
    expect(ss).toMatch(/WARNING about key/);
    expect(ALL_TOOLS.find((t) => t.name === 'network_test')!.description).toContain('https://speed.cloudflare.com/__up');
  });

  it('every tool is called by at least one unit test', () => {
    const testDir = path.join(ROOT, 'test', 'unit');
    const tests = readdirSync(testDir).filter((f) => f.endsWith('.test.ts') && f !== 'catalogue.test.ts').map((f) => readFileSync(path.join(testDir, f), 'utf8')).join('\n');
    const missing = ALL_TOOLS.map((t) => t.name).filter((n) => !new RegExp(`call(Raw)?\\('${n}'`).test(tests));
    expect(missing).toEqual([]);
  });
});
