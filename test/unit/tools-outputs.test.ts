import { afterEach, describe, expect, it } from 'vitest';
import { expectError, expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

describe('stream', () => {
  it('start, status, stop; not undoable', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('stream_start'))).toMatchObject({ live: true, active: true });
    expect(expectOk(await h.call('stream_start'))).toMatchObject({ alreadyLive: true });
    h.model.stream.congestion = 0.42;
    h.model.stream.skipped = 30;
    const s = expectOk(await h.call('stream_status'));
    expect(s).toMatchObject({ active: true, congestion: 0.42, skippedFrames: 30 });
    expect(expectOk(await h.call('stream_stop'))).toMatchObject({ wasLive: true, stopped: true });
    expect(expectOk(await h.call('stream_stop'))).toMatchObject({ wasLive: false });
    const u = expectError(await h.call('undo_last'), 'NOTHING_TO_UNDO');
    expect(u.message).toContain('stream_start');
  });

  it('refuses to go live without a stream key', async () => {
    h = await makeHarness();
    h.model.service = { type: 'rtmp_common', settings: { service: 'Twitch', server: 'auto' } };
    expectError(await h.call('stream_start'), 'INVALID_ARGUMENT');
    expect(h.model.stream.active).toBe(false);
  });
});

describe('record', () => {
  it('start, status, stop returns the file', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('record_start'))).toMatchObject({ recording: true });
    expect(expectOk(await h.call('record_start'))).toMatchObject({ alreadyRecording: true });
    expect(expectOk(await h.call('record_status'))).toMatchObject({ active: true });
    const r = expectOk(await h.call('record_stop'));
    expect(r).toMatchObject({ wasRecording: true, sizeBytes: 4096 });
    expect(String(r['path'])).toMatch(/\.mov$/);
    expect(expectOk(await h.call('record_stop'))).toMatchObject({ wasRecording: false });
  });

  it('test_record measures the delta and skipped percentages', async () => {
    h = await makeHarness();
    h.model.tick = { frames: 100, renderSkips: 0, outputSkips: 5 };
    const r = expectOk(await h.call('test_record', { seconds: 3 }));
    expect(r).toMatchObject({ seconds: 3, sizeBytes: 4096 });
    expect(r['skippedFramePercent'] as number).toBeGreaterThan(1);
    expect(r['healthy']).toBe(false);
    h.model.tick = { frames: 100, renderSkips: 0, outputSkips: 0 };
    expect(expectOk(await h.call('test_record', { seconds: 3 }))['healthy']).toBe(true);
  });

  it('test_record refuses while recording and validates seconds', async () => {
    h = await makeHarness();
    h.model.record.active = true;
    expectError(await h.call('test_record'), 'OUTPUT_ACTIVE');
    expectError(await h.call('test_record', { seconds: 600 }), 'INVALID_ARGUMENT');
  });
});

describe('replay buffer and virtual camera', () => {
  it('replay buffer: not enabled in the profile -> UNSUPPORTED with the settings hint', async () => {
    h = await makeHarness();
    expect(expectError(await h.call('replay_buffer_set', { active: true }), 'UNSUPPORTED').hint).toContain('Replay Buffer');
    expectError(await h.call('replay_buffer_set', {}), 'INVALID_ARGUMENT');
  });

  it('replay buffer start, save, stop', async () => {
    h = await makeHarness();
    h.model.replayBuffer.available = true;
    expectError(await h.call('replay_buffer_set', { save: true }), 'OUTPUT_NOT_ACTIVE');
    expect(expectOk(await h.call('replay_buffer_set', { active: true, save: true }))).toMatchObject({ active: true });
    expect(expectOk(await h.call('replay_buffer_set', { active: false }))).toMatchObject({ active: false });
  });

  it('virtual camera on and off', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('virtual_camera_set', { active: true }))).toMatchObject({ active: true, changed: true });
    expect(expectOk(await h.call('virtual_camera_set', { active: true }))).toMatchObject({ changed: false });
    expect(expectOk(await h.call('virtual_camera_set', { active: false }))).toMatchObject({ active: false });
  });

  it('outputs need a connection', async () => {
    h = await makeHarness({ running: false });
    for (const t of ['stream_start', 'stream_stop', 'stream_status', 'record_start', 'record_stop', 'record_status']) expectError(await h.call(t), 'WEBSOCKET_UNREACHABLE');
  });
});
