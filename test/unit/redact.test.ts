import { describe, expect, it } from 'vitest';
import { SecretRegistry, isSecretKey, redact, redactString } from '../../src/safety/redact.js';
import { DUMMY_KEY } from '../helpers.js';

describe('redact', () => {
  it('replaces secret-named fields with <set>/<empty> at any depth', () => {
    const out = redact({ key: DUMMY_KEY, a: { server_password: 'pw', stream_key: '', nested: [{ bearer_token: 'tok' }] }, keep: 'x' });
    expect(out).toEqual({ key: '<set>', a: { server_password: '<set>', stream_key: '<empty>', nested: [{ bearer_token: '<set>' }] }, keep: 'x' });
  });

  it('knows which names are secret', () => {
    for (const k of ['key', 'stream_key', 'token', 'auth_token', 'password', 'server_password', 'streamKey', 'authToken', 'secret']) expect(isSecretKey(k), k).toBe(true);
    for (const k of ['hotkeys', 'keyint_sec', 'monkey', 'name', 'server', 'service', 'device_id']) expect(isSecretKey(k), k).toBe(false);
  });

  it('scrubs registered secret values out of free text', () => {
    const reg = new SecretRegistry();
    reg.add(DUMMY_KEY);
    reg.add('abc'); // too short to register
    expect(redactString(`connecting to rtmp://x/app/${DUMMY_KEY} now`, reg)).not.toContain(DUMMY_KEY);
    expect(reg.size).toBe(1);
  });

  it('scrubs common key shapes even when unregistered', () => {
    expect(redactString('url rtmp://live.twitch.tv/app/live_987654321_AbCdEfGhIjKlMnOp')).toContain('<redacted>');
    expect(redactString('yt key abcd-efgh-ijkl-mnop-qrst here')).toContain('<redacted>');
    expect(redactString('https://x/y?token=s3cr3t&a=1')).toBe('https://x/y?token=<redacted>&a=1');
    expect(redactString('ServerPassword=hunter22')).toBe('ServerPassword=<redacted>');
    expect(redactString('{"key": "abc"}')).toBe('{"key": "<redacted>"}');
  });

  it('leaves UUIDs and ordinary log lines alone', () => {
    const line = "Switched to scene 'Scene' c61c70ce-97fc-4ecf-9555-cb6c5aeb9046 keyint: 250";
    expect(redactString(line)).toBe(line);
  });

  it('does not mutate its input and handles cycles', () => {
    const a: Record<string, unknown> = { key: 'v' };
    a['self'] = a;
    const out = redact(a) as Record<string, unknown>;
    expect(a['key']).toBe('v');
    expect(out['self']).toBe('[circular]');
  });
});
