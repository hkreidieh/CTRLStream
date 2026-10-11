import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObsClient, mapRequestError } from '../../src/obs/client.js';
import { OBSWebSocketError } from 'obs-websocket-js/json';
import { ToolError } from '../../src/errors.js';
import { makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
afterEach(async () => h?.cleanup());

describe('ObsClient', () => {
  it('reads port and password from the websocket config and authenticates', async () => {
    h = await makeHarness();
    const info = await h.ctx.obs.connect();
    expect(info.authUsed).toBe(true);
    expect(info.url).toBe(`ws://127.0.0.1:${h.server.port}`);
    expect(info.source).toBe('config');
    expect((await h.ctx.obs.version()).obsVersion).toBe('32.2.2');
  });

  it('works without auth', async () => {
    h = await makeHarness({ password: null });
    expect((await h.ctx.obs.connect()).authUsed).toBe(false);
  });

  it('wrong password -> WEBSOCKET_AUTH_FAILED with a hint', async () => {
    h = await makeHarness();
    h.server.password = 'something-else';
    await expect(h.ctx.obs.connect()).rejects.toMatchObject({ code: 'WEBSOCKET_AUTH_FAILED' });
    expect(h.server.authFailures).toBe(1);
  });

  it('server off with config disabled -> WEBSOCKET_DISABLED naming obs_quit', async () => {
    h = await makeHarness({ wsEnabled: false });
    await h.server.stop();
    await expect(h.ctx.obs.connect()).rejects.toMatchObject({ code: 'WEBSOCKET_DISABLED', suggestedTool: 'obs_quit' });
  });

  it('nothing listening -> WEBSOCKET_UNREACHABLE', async () => {
    h = await makeHarness();
    await h.server.stop();
    await expect(h.ctx.obs.connect()).rejects.toMatchObject({ code: 'WEBSOCKET_UNREACHABLE' });
  });

  it('env overrides win over the config file and register the password as a secret', async () => {
    h = await makeHarness();
    writeFileSync(path.join(h.configDir, 'plugin_config/obs-websocket/config.json'), JSON.stringify({ server_enabled: true, server_port: 1, auth_required: true, server_password: 'wrong' }));
    const c = new ObsClient(h.ctx.paths, h.ctx.secrets, { overrides: { port: h.server.port, password: 'dummyWsPassw0rd-NotReal' } });
    const info = await c.connect();
    expect(info.source).toBe('override');
    expect(h.ctx.secrets.list()).toContain('dummyWsPassw0rd-NotReal');
    await c.disconnect();
  });

  it('retries 207 NotReady while OBS finishes loading (seen on the real OBS)', async () => {
    h = await makeHarness();
    h.model.notReadyRemaining = 3;
    const r = await h.ctx.obs.call('GetSceneList');
    expect(r.currentProgramSceneName).toBe('Scene');
  });

  it('reconnects after the connection drops', async () => {
    h = await makeHarness();
    await h.ctx.obs.connect();
    h.server.crash();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.ctx.obs.connected).toBe(false);
    expect((await h.ctx.obs.call('GetVersion')).obsVersion).toBe('32.2.2');
  });

  it('maps request status codes to error codes', () => {
    const m = (c: number) => mapRequestError('X', new OBSWebSocketError(c, 'c')).code;
    expect(m(600)).toBe('NOT_FOUND');
    expect(m(601)).toBe('ALREADY_EXISTS');
    expect(m(500)).toBe('OUTPUT_ACTIVE');
    expect(m(501)).toBe('OUTPUT_NOT_ACTIVE');
    expect(m(402)).toBe('INVALID_ARGUMENT');
    expect(m(204)).toBe('UNSUPPORTED');
    expect(m(702)).toBe('OBS_REQUEST_FAILED');
    expect(mapRequestError('X', new ToolError('TIMEOUT', 'm', 'h')).code).toBe('TIMEOUT');
  });
});
