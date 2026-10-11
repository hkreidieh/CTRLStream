import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUPS_KEPT, ensureSessionBackup, listBackups, pruneBackups } from '../../src/safety/backup.js';
import { fileWrite } from '../../src/safety/file-write.js';
import { mutate } from '../../src/safety/mutate.js';
import { undoFile } from '../../src/safety/undo.js';
import { writePrivateJson } from '../../src/safety/store.js';
import { DUMMY_KEY, expectError, expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

describe('mutate(): backup before the first change, undo log after each', () => {
  it('backs up the active profile and collection once per session, before applying', async () => {
    h = await makeHarness();
    await h.ctx.obs.connect();
    let sawBackupBeforeApply = false;
    await mutate(h.ctx, {
      tool: 'test',
      apply: async () => {
        sawBackupBeforeApply = !!h.ctx.session.backupDir && existsSync(path.join(h.ctx.session.backupDir, 'profile', 'basic.ini'));
      },
    });
    expect(sawBackupBeforeApply).toBe(true);
    const dir = h.ctx.session.backupDir!;
    expect(existsSync(path.join(dir, 'profile', 'service.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'scenes', 'Untitled.json'))).toBe(true);
    // Byte-exact copy (service.json included, so it can be restored) ...
    expect(readFileSync(path.join(dir, 'profile', 'service.json'), 'utf8')).toContain(DUMMY_KEY);
    // ... but the metadata has no secrets, and directories are private.
    expect(readFileSync(path.join(dir, 'backup.json'), 'utf8')).not.toContain(DUMMY_KEY);
    if (process.platform !== 'win32') expect(statSync(h.dataDir).mode & 0o777).toBe(0o700);
    await mutate(h.ctx, { tool: 'test2', apply: async () => undefined });
    expect(readdirSync(path.join(h.dataDir, 'backups'))).toHaveLength(1);
  });

  it('writes a redacted undo line per mutation', async () => {
    h = await makeHarness();
    await mutate(h.ctx, { tool: 't', before: async () => ({ key: DUMMY_KEY, server: 'x' }), apply: async () => 1, inverse: () => ({ kind: 'ws', requests: [] }) });
    const lines = readFileSync(undoFile(h.ctx), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0]!);
    expect(e).toMatchObject({ seq: 1, tool: 't', undoable: true, before: { key: '<set>', server: 'x' }, inverseKind: 'ws' });
  });

  it('prunes backups to the newest 10 sessions', async () => {
    h = await makeHarness();
    for (let i = 0; i < 12; i++) mkdirSync(path.join(h.dataDir, 'backups', `2026-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z-x`), { recursive: true });
    await ensureSessionBackup(h.ctx);
    const left = readdirSync(path.join(h.dataDir, 'backups'));
    expect(left.length).toBe(BACKUPS_KEPT);
    expect(left).toContain(h.ctx.session.id);
    expect(await pruneBackups(h.ctx)).toEqual([]);
    expect((await listBackups(h.ctx))[0]!.current).toBe(true);
  });
});

describe('fileWrite(): never while OBS runs', () => {
  it('refuses with OBS_RUNNING naming obs_quit', async () => {
    h = await makeHarness({ running: true });
    await expect(fileWrite(h.ctx, 'audio_set', async () => 1)).rejects.toMatchObject({ code: 'OBS_RUNNING', suggestedTool: 'obs_quit' });
  });

  it('writes atomically inside the OBS dir and refuses paths outside it', async () => {
    h = await makeHarness({ running: false });
    const target = path.join(h.configDir, 'x.json');
    await fileWrite(h.ctx, 't', (w) => w.writeJson(target, { a: 1 }));
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ a: 1 });
    await expect(fileWrite(h.ctx, 't', (w) => w.writeText(path.join(h.home, 'evil.txt'), 'x'))).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(existsSync(path.join(h.home, 'evil.txt'))).toBe(false);
  });

  it('every file tool goes through it: audio_set and output_set_advanced refuse while running', async () => {
    h = await makeHarness({ running: true });
    expect(expectError(await h.call('audio_set', { sampleRate: 44100 }), 'OBS_RUNNING').suggestedTool).toBe('obs_quit');
    expectError(await h.call('output_set_advanced', { target: 'stream', settings: { bitrate: 6000 } }), 'OBS_RUNNING');
    expectError(await h.call('snapshot_restore', { snapshotId: expectOk(await h.call('snapshot_save', { label: 'x' }))['id'] as string }), 'OBS_RUNNING');
  });
});

describe('private store', () => {
  it('redacts JSON and refuses writes outside the data dir', async () => {
    h = await makeHarness();
    const f = path.join(h.dataDir, 'a', 'b.json');
    await writePrivateJson(h.ctx, f, { password: 'pw', x: 1 });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ password: '<set>', x: 1 });
    await expect(writePrivateJson(h.ctx, path.join(h.home, 'nope.json'), {})).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
