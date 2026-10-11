import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envOverrides } from '../../src/context.js';
import { defaultConfigDirCandidates, envValue, isCrashReportName, obsBinaryCandidates, portableConfigDir, resolveObsConfigDir, resolveObsPaths } from '../../src/obs/paths.js';

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ctrlstream-paths-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('config dir per OS (DESIGN 3.1)', () => {
  it('macOS, Windows and the Linux packagings', () => {
    expect(defaultConfigDirCandidates({ platform: 'darwin', home: '/Users/a' })).toEqual(['/Users/a/Library/Application Support/obs-studio']);
    expect(defaultConfigDirCandidates({ platform: 'win32', home: 'C:\\Users\\a', appData: 'C:\\Users\\a\\AppData\\Roaming' })).toEqual(['C:\\Users\\a\\AppData\\Roaming\\obs-studio']);
    expect(defaultConfigDirCandidates({ platform: 'linux', home: '/home/a' })).toEqual([
      '/home/a/.config/obs-studio',
      '/home/a/.var/app/com.obsproject.Studio/config/obs-studio',
      '/home/a/snap/obs-studio/current/.config/obs-studio',
    ]);
  });

  it('Linux picks the packaging that was used most recently', () => {
    const home = tmp();
    const flatpak = path.join(home, '.var/app/com.obsproject.Studio/config/obs-studio');
    mkdirSync(flatpak, { recursive: true });
    writeFileSync(path.join(flatpak, 'user.ini'), '[Basic]\n');
    expect(resolveObsConfigDir({ platform: 'linux', home }).dir).toBe(flatpak);
  });

  it('override wins', () => {
    expect(resolveObsConfigDir({ platform: 'darwin', home: '/x', obsConfigDirOverride: '/custom/obs-studio' })).toMatchObject({ dir: '/custom/obs-studio', source: 'override' });
  });

  it('Windows portable mode: marker in the install root, config under it', () => {
    const root = tmp();
    const bin = path.join(root, 'bin', '64bit', 'obs64.exe');
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(path.join(root, 'portable_mode.txt'), '');
    expect(portableConfigDir({ platform: 'win32', home: root }, bin)).toBe(path.join(root, 'config', 'obs-studio'));
    rmSync(path.join(root, 'portable_mode.txt'));
    writeFileSync(path.join(root, 'obs_portable_mode'), '');
    expect(portableConfigDir({ platform: 'win32', home: root }, bin)).toBe(path.join(root, 'config', 'obs-studio'));
    rmSync(path.join(root, 'obs_portable_mode'));
    expect(portableConfigDir({ platform: 'win32', home: root }, bin)).toBeNull();
    expect(portableConfigDir({ platform: 'darwin', home: root }, bin)).toBeNull();
  });

  it('honours global.ini [Locations] for profiles, scenes and user.ini when the dir exists', () => {
    const home = tmp();
    const cfg = path.join(home, 'Library/Application Support/obs-studio');
    const moved = path.join(home, 'Moved');
    mkdirSync(cfg, { recursive: true });
    mkdirSync(moved, { recursive: true });
    writeFileSync(path.join(cfg, 'global.ini'), `[Locations]\nConfiguration=${moved}\nProfiles=${moved}\nSceneCollections=/does/not/exist\n`);
    const p = resolveObsPaths({ platform: 'darwin', home });
    expect(p.profilesDir).toBe(path.join(moved, 'obs-studio/basic/profiles'));
    expect(p.userIni).toBe(path.join(moved, 'obs-studio/user.ini'));
    expect(p.scenesDir).toBe(path.join(home, 'Library/Application Support/obs-studio/basic/scenes'));
    expect(p.crashDirs).toEqual([path.join(home, 'Library/Logs/DiagnosticReports')]);
    expect(p.websocketConfig).toBe(path.join(cfg, 'plugin_config/obs-websocket/config.json'));
  });

  it('binary candidates and crash report names', () => {
    expect(obsBinaryCandidates({ platform: 'darwin', home: '/Users/a' })[0]).toBe('/Applications/OBS.app');
    expect(obsBinaryCandidates({ platform: 'win32', home: 'C:\\Users\\a', programFiles: ['C:\\Program Files'] })[0]).toBe('C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe');
    expect(isCrashReportName('darwin', 'OBS-2026-10-11-023001.ips')).toBe(true);
    expect(isCrashReportName('darwin', 'Safari-2026.ips')).toBe(false);
    expect(isCrashReportName('win32', 'Crash 2026-10-11 02-29-30.txt')).toBe(true);
  });
});

describe('envValue', () => {
  it('treats empty and unexpanded ${...} templates as unset', () => {
    const env = { A: '${user_config.obs_host}', B: '', C: ' 127.0.0.1 ', D: '${}' } as NodeJS.ProcessEnv;
    expect(envValue('A', env)).toBeUndefined();
    expect(envValue('B', env)).toBeUndefined();
    expect(envValue('C', env)).toBe('127.0.0.1');
    expect(envValue('D', env)).toBeUndefined();
    expect(envValue('Z', env)).toBeUndefined();
  });

  it('the .mcpb overrides fall back to zero-config when Claude Desktop passes empty templates', () => {
    const env = { CTRLSTREAM_OBS_HOST: '${user_config.obs_host}', CTRLSTREAM_OBS_PORT: '${user_config.obs_port}', CTRLSTREAM_OBS_PASSWORD: '${user_config.obs_password}' } as NodeJS.ProcessEnv;
    expect(envOverrides(env)).toEqual({ host: undefined, port: undefined, password: undefined });
    expect(envOverrides({ CTRLSTREAM_OBS_HOST: '10.0.0.5', CTRLSTREAM_OBS_PORT: '4460', CTRLSTREAM_OBS_PASSWORD: 'pw' } as NodeJS.ProcessEnv)).toEqual({ host: '10.0.0.5', port: 4460, password: 'pw' });
    expect(envOverrides({ CTRLSTREAM_OBS_PORT: '99999' } as NodeJS.ProcessEnv).port).toBeUndefined();
  });
});
