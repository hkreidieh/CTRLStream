import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expectError, expectOk, FIXTURES, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

describe('obs_status', () => {
  it('reports a running, connected OBS with profile, collection and permissions', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('obs_status'));
    expect(r).toMatchObject({ running: true, pid: 4242, obsVersion: '32.2.2', profile: 'Untitled', sceneCollection: 'Untitled', platform: 'darwin', crashSinceLastStart: false, uncleanShutdown: false });
    expect(r['websocket']).toMatchObject({ enabled: true, connected: true, authRequired: true });
    expect(r['macPermissions']).toMatchObject({ screenCapture: 'denied' });
  });

  it('reports OBS closed, an unclean shutdown sentinel, and a newer crash report', async () => {
    h = await makeHarness({ running: false });
    mkdirSync(path.join(h.configDir, '.sentinel'), { recursive: true });
    writeFileSync(path.join(h.configDir, '.sentinel', 'run_1234'), '');
    const crashDir = path.join(h.home, 'Library', 'Logs', 'DiagnosticReports');
    mkdirSync(crashDir, { recursive: true });
    writeFileSync(path.join(crashDir, 'OBS-2026-10-11-023001.ips'), readFileSync(path.join(FIXTURES, 'real', 'OBS-2026-10-11-023001.ips')));
    const r = expectOk(await h.call('obs_status'));
    expect(r).toMatchObject({ running: false, uncleanShutdown: true, crashSinceLastStart: true });
    expect((r['websocket'] as Record<string, unknown>)['connected']).toBe(false);
  });

  it('works on a machine where OBS was never launched', async () => {
    h = await makeHarness({ running: false, config: 'none' });
    const r = expectOk(await h.call('obs_status'));
    expect(r).toMatchObject({ running: false, configFound: false, profile: null });
  });
});

describe('obs_connect', () => {
  it('connects when OBS runs', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('obs_connect'))).toMatchObject({ connected: true, authUsed: true, obsVersion: '32.2.2' });
  });

  it('with OBS closed and the websocket off, enables it in the config (file branch) without exposing the password', async () => {
    h = await makeHarness({ running: false, wsEnabled: false });
    const cfgPath = path.join(h.configDir, 'plugin_config/obs-websocket/config.json');
    writeFileSync(cfgPath, JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: false, server_password: '', server_port: 4455 }));
    const r = expectOk(await h.call('obs_connect'));
    expect(r).toMatchObject({ connected: false, websocketEnabled: true, configChanged: true, passwordGenerated: true, nextStep: 'obs_launch' });
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(cfg.server_enabled).toBe(true);
    expect(cfg.server_password.length).toBeGreaterThanOrEqual(24);
    expect(JSON.stringify(r)).not.toContain(cfg.server_password);
  });

  it('refuses to edit the config while OBS runs with the websocket off', async () => {
    h = await makeHarness({ wsEnabled: false });
    await h.server.stop();
    expect(expectError(await h.call('obs_connect'), 'WEBSOCKET_DISABLED').suggestedTool).toBe('obs_quit');
  });

  it('OBS closed and websocket already on -> OBS_NOT_RUNNING; never-launched -> CONFIG_NOT_FOUND', async () => {
    h = await makeHarness({ running: false });
    expectError(await h.call('obs_connect'), 'OBS_NOT_RUNNING');
    await h.cleanup();
    h = await makeHarness({ running: false, config: 'none' });
    expectError(await h.call('obs_connect'), 'CONFIG_NOT_FOUND');
  });

  it('auth failure is a structured error', async () => {
    h = await makeHarness();
    h.server.password = 'changed';
    expectError(await h.call('obs_connect'), 'WEBSOCKET_AUTH_FAILED');
  });
});

describe('obs_launch', () => {
  it('launches, waits for the websocket and connects', async () => {
    h = await makeHarness({ running: false });
    const r = expectOk(await h.call('obs_launch', { profile: 'Untitled', collection: 'Untitled' }));
    expect(r).toMatchObject({ launched: true, connected: true, obsVersion: '32.2.2' });
    expect(h.proc.launches[0]).toMatchObject({ profile: 'Untitled', collection: 'Untitled' });
  });

  it('safe mode returns at once: no websocket in safe mode', async () => {
    h = await makeHarness({ running: false });
    const r = expectOk(await h.call('obs_launch', { safeMode: true }));
    expect(r).toMatchObject({ launched: true, safeMode: true, connected: false, websocketAvailable: false });
    const st = expectOk(await h.call('obs_status'));
    expect(st['safeMode']).toBe(true);
  });

  it('already running: connects only and says options were not applied', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('obs_launch', { safeMode: true }));
    expect(r).toMatchObject({ launched: false, alreadyRunning: true });
    expect(String(r['note'])).toContain('obs_quit');
  });

  it('rejects unknown profiles, conflicting flags, missing install', async () => {
    h = await makeHarness({ running: false });
    expectError(await h.call('obs_launch', { profile: 'Nope' }), 'NOT_FOUND');
    expectError(await h.call('obs_launch', { collection: 'Nope' }), 'NOT_FOUND');
    expectError(await h.call('obs_launch', { safeMode: true, onlyBundledPlugins: true }), 'INVALID_ARGUMENT');
    h.proc.binaryPath = null;
    expectError(await h.call('obs_launch'), 'LAUNCH_FAILED');
  });

  it('times out with the crash-dialog hint after an unclean shutdown', async () => {
    h = await makeHarness({ running: false });
    mkdirSync(path.join(h.configDir, '.sentinel'), { recursive: true });
    writeFileSync(path.join(h.configDir, '.sentinel', 'run_old'), '');
    h.proc.launchHangs = true;
    const e = expectError(await h.call('obs_launch'), 'TIMEOUT');
    expect(e.hint).toContain('Run in Normal Mode');
  });

  it('websocket disabled: launches but says how to enable it', async () => {
    h = await makeHarness({ running: false, wsEnabled: false });
    expect(expectOk(await h.call('obs_launch'))).toMatchObject({ launched: true, connected: false, suggestedTool: 'obs_quit' });
  });
});

describe('obs_quit', () => {
  it('quits gracefully and reports escalation', async () => {
    h = await makeHarness();
    expect(expectOk(await h.call('obs_quit'))).toMatchObject({ wasRunning: true, exited: true, escalated: 'none' });
    expect(expectOk(await h.call('obs_quit'))).toMatchObject({ wasRunning: false });
  });

  it('refuses while streaming unless forced', async () => {
    h = await makeHarness();
    h.model.stream.active = true;
    expect(expectError(await h.call('obs_quit'), 'OUTPUT_ACTIVE').suggestedTool).toBe('stream_stop');
    expect(expectOk(await h.call('obs_quit', { force: true }))).toMatchObject({ exited: true });
  });

  it('stuck OBS -> QUIT_FAILED; force kills and warns', async () => {
    h = await makeHarness();
    h.proc.quitBehavior = 'stuck';
    expectError(await h.call('obs_quit'), 'QUIT_FAILED');
    const r = expectOk(await h.call('obs_quit', { force: true }));
    expect(r['escalated']).toBe('force');
    expect(r['warning']).toBeTruthy();
  });

  it('the sigterm escalation is reported', async () => {
    h = await makeHarness();
    h.proc.quitBehavior = 'sigterm';
    expect(expectOk(await h.call('obs_quit'))['escalated']).toBe('sigterm');
    expect(existsSync(h.configDir)).toBe(true);
    rmSync(path.join(h.configDir, 'logs'), { recursive: true, force: true });
  });
});
