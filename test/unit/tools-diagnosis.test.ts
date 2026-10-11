import { cpSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expectError, expectOk, FIXTURES, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

const codes = (r: Record<string, unknown>) => (r['findings'] as Array<{ code: string }>).map((f) => f.code);

describe('diagnose', () => {
  it('healthy running OBS: report shape per DESIGN 6, few findings', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('diagnose'));
    expect(r['obs']).toMatchObject({ running: true, version: '32.2.2', safeMode: false, crashSinceLastStart: false });
    expect(r['connection']).toEqual({ ok: true });
    expect(r['stats']).toMatchObject({ activeFps: 30, diskFreeMb: 120000 });
    expect(r['stream']).toMatchObject({ active: false });
    expect(r['output']).toMatchObject({ mode: 'Simple', encoder: 'x264' });
    expect((r['devices'] as Record<string, unknown>)['present']).toMatchObject({ cameras: ['FaceTime HD Camera', 'Elgato Facecam'] });
    expect(r['log']).toMatchObject({ file: '2026-10-11 01-50-57.txt' });
    expect(codes(r)).not.toContain('ENCODER_OVERLOAD');
    expect(codes(r)).not.toContain('DEVICE_MISSING');
  });

  it('OBS not running, last session crashed: OBS_NOT_RUNNING, PLUGIN_CRASH_SUSPECTED from files only', async () => {
    h = await makeHarness({ running: false });
    const crashDir = path.join(h.home, 'Library', 'Logs', 'DiagnosticReports');
    mkdirSync(crashDir, { recursive: true });
    cpSync(path.join(FIXTURES, 'real', 'OBS-2026-10-11-023001.ips'), path.join(crashDir, 'OBS-2026-10-11-023001.ips'));
    mkdirSync(path.join(h.configDir, '.sentinel'), { recursive: true });
    writeFileSync(path.join(h.configDir, '.sentinel', 'run_x'), '');
    const r = expectOk(await h.call('diagnose'));
    expect(codes(r)[0]).toBe('OBS_NOT_RUNNING');
    expect(codes(r)).toContain('PLUGIN_CRASH_SUSPECTED');
    expect(r['obs']).toMatchObject({ running: false, uncleanShutdown: true });
    expect(r['connection']).toMatchObject({ ok: false });
    // The real test collection on disk references cameras and mics by id; files-only mode still reports drift-free shape.
    expect(r['output']).toMatchObject({ videoBitrateKbps: 2500 });
  });

  it('relaunched after a crash: PLUGIN_CRASH_SUSPECTED from the crash-recovery log line', async () => {
    h = await makeHarness({ logs: ['real/log-after-unclean-shutdown.txt'] });
    const logs = path.join(h.configDir, 'logs');
    rmSync(path.join(logs, '2026-10-11 01-50-57.txt'));
    cpSync(path.join(FIXTURES, 'real', 'log-session-missing-devices-crashed.txt'), path.join(logs, '2026-10-11 02-25-31.txt'));
    cpSync(path.join(logs, 'log-after-unclean-shutdown.txt'), path.join(logs, '2026-10-11 02-30-06.txt'));
    rmSync(path.join(logs, 'log-after-unclean-shutdown.txt'));
    const crashDir = path.join(h.home, 'Library', 'Logs', 'DiagnosticReports');
    mkdirSync(crashDir, { recursive: true });
    const crash = path.join(crashDir, 'OBS-2026-10-11-023001.ips');
    cpSync(path.join(FIXTURES, 'real', 'OBS-2026-10-11-023001.ips'), crash);
    const t = new Date(2026, 9, 11, 2, 30, 2);
    utimesSync(crash, t, t);
    const r = expectOk(await h.call('diagnose', { checkDevices: false }));
    expect(r['obs']).toMatchObject({ crashSinceLastStart: false, previousSessionCrashed: true });
    expect(codes(r)).toContain('PLUGIN_CRASH_SUSPECTED');
  });

  it('missing camera and microphone, encoder overload from the log, network drops, render lag', async () => {
    h = await makeHarness({ logs: ['logs/log-overload-missing-device.txt'] });
    rmSync(path.join(h.configDir, 'logs', '2026-10-11 01-50-57.txt'));
    h.model.addInput('Live', 'cam-bogus', 'macos-avcapture', { device: 'bogus-device-uuid-1234' });
    h.model.addInput('Live', 'mic-bogus', 'coreaudio_input_capture', { device_id: 'bogus-mic-uid' });
    h.model.stream.active = true;
    h.model.stream.congestion = 0.6;
    h.model.stats.renderSkippedFrames = 200;
    h.model.stats.renderTotalFrames = 1000;
    const r = expectOk(await h.call('diagnose'));
    const c = codes(r);
    expect(c).toEqual(expect.arrayContaining(['DEVICE_MISSING', 'AUDIO_DEVICE_MISSING', 'ENCODER_OVERLOAD', 'NETWORK_DROPS', 'RENDER_LAG', 'LOG_ERRORS']));
    const dm = (r['findings'] as Array<Record<string, unknown>>).find((f) => f['code'] === 'DEVICE_MISSING')!;
    expect(dm).toMatchObject({ severity: 'high', suggestedTool: 'input_settings_set' });
    expect(String(dm['evidence'])).toContain('cam-bogus');
    // Severity order: high first.
    const sev = (r['findings'] as Array<{ severity: string }>).map((f) => f.severity);
    expect(sev.indexOf('low')).toBeGreaterThan(sev.lastIndexOf('high'));
  });

  it('drift against known-good, platform cap, upload, disk, scene source checks', async () => {
    h = await makeHarness();
    expectOk(await h.call('snapshot_save', { label: 'known-good' }));
    h.model.video.fpsNumerator = 60;
    h.model.params.set('SimpleOutput.VBitrate', '9000');
    h.model.params.set('Stream1.IgnoreRecommended', 'true');
    h.model.stats.availableDiskSpace = 3227;
    writeFileSync(path.join(h.dataDir, 'network.json'), JSON.stringify({ measuredAt: '2026-10-11T00:00:00Z', uploadMbps: 10 }));
    h.model.addInput('Live', 'Logo', 'image_source', { file: '/nowhere/logo.png' });
    const r = expectOk(await h.call('diagnose', { checkDevices: false }));
    expect(codes(r)).toEqual(expect.arrayContaining(['RESOLUTION_OR_FPS_DRIFT', 'OUTPUT_DRIFT', 'BITRATE_ABOVE_PLATFORM_CAP', 'BITRATE_ABOVE_UPLOAD', 'DISK_LOW', 'SCENE_SOURCE_MISSING']));
    const cap = (r['findings'] as Array<Record<string, unknown>>).find((f) => f['code'] === 'BITRATE_ABOVE_PLATFORM_CAP')!;
    expect(String(cap['evidence'])).toContain('Twitch');
  });

  it('no platform-cap finding when OBS clamps the bitrate itself (verified on the real OBS)', async () => {
    h = await makeHarness();
    h.model.params.set('SimpleOutput.VBitrate', '9000');
    const r = expectOk(await h.call('diagnose', { checkDevices: false }));
    expect(codes(r)).not.toContain('BITRATE_ABOVE_PLATFORM_CAP');
    expect(r['output']).toMatchObject({ videoBitrateKbps: 9000, effectiveVideoBitrateKbps: 6000 });
  });

  it('websocket disabled while running; safe mode; encoder unavailable', async () => {
    h = await makeHarness({ wsEnabled: false });
    await h.server.stop();
    expect(codes(expectOk(await h.call('diagnose')))).toContain('WEBSOCKET_DISABLED');
    await h.cleanup();
    h = await makeHarness();
    writeFileSync(path.join(h.configDir, 'logs', '2026-10-11 23-00-00.txt'), '23:00:00.000: Safe Mode enabled.\n23:00:00.001: OBS 32.2.2 (mac)\n');
    h.model.params.set('SimpleOutput.StreamEncoder', 'nvenc');
    const c = codes(expectOk(await h.call('diagnose', { checkDevices: false })));
    expect(c).toContain('SAFE_MODE_ACTIVE');
    expect(c).toContain('ENCODER_UNAVAILABLE');
  });
});

describe('logs_tail and stats', () => {
  it('logs_tail returns the tail, extracted lines and recent logs; grep filters', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('logs_tail', { lines: 5 }));
    expect((r['lines'] as string[]).length).toBe(5);
    expect(r).toMatchObject({ file: '2026-10-11 01-50-57.txt', obsVersion: '32.2.2', cleanShutdown: true });
    const g = expectOk(await h.call('logs_tail', { grep: 'videotoolbox' }));
    expect((g['lines'] as string[]).every((l) => l.toLowerCase().includes('videotoolbox'))).toBe(true);
    expectError(await h.call('logs_tail', { file: '../user.ini' }), 'INVALID_ARGUMENT');
    expectError(await h.call('logs_tail', { file: 'nope.txt' }), 'NOT_FOUND');
    rmSync(path.join(h.configDir, 'logs'), { recursive: true });
    expectError(await h.call('logs_tail'), 'NOT_FOUND');
  });

  it('logs_tail scrubs a key that leaked into a log line', async () => {
    h = await makeHarness();
    const f = path.join(h.configDir, 'logs', '2026-10-11 01-50-57.txt');
    writeFileSync(f, `${readFileSync(f, 'utf8')}12:00:00.000: [rtmp stream: 'simple_stream'] Connecting to rtmp://live.twitch.tv/app/live_123456789_DUMMYSTREAMKEYdoNotLeak42\n`);
    const r = expectOk(await h.call('logs_tail', { lines: 1 }));
    expect((r['lines'] as string[])[0]).toContain('<redacted>');
  });

  it('stats returns percentages and output status; needs a connection', async () => {
    h = await makeHarness();
    h.model.stats.outputSkippedFrames = 50;
    h.model.stats.outputTotalFrames = 1000;
    const r = expectOk(await h.call('stats'));
    expect(r).toMatchObject({ outputSkippedPercent: 5, stream: { active: false }, record: { active: false } });
    await h.cleanup();
    h = await makeHarness({ running: false });
    expectError(await h.call('stats'), 'WEBSOCKET_UNREACHABLE');
  });
});
