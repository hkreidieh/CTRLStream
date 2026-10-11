/**
 * Every filesystem location ctrlstream knows about lives here and nowhere else (CLAUDE.md:
 * "No hardcoded paths outside src/obs/paths.ts").
 *
 * Verified against OBS 32.2.2 source (frontend/OBSApp.cpp, frontend/obs-main.cpp,
 * frontend/utility/CrashHandler_*.{cpp,mm}) and a real macOS install on 2026-10-11:
 *  - config root: os_get_config_path() + "obs-studio" (macOS ~/Library/Application Support,
 *    Windows %APPDATA%, Linux $XDG_CONFIG_HOME or ~/.config).
 *  - portable mode (Windows, or builds with ENABLE_PORTABLE_CONFIG): a marker file named
 *    portable_mode, obs_portable_mode, portable_mode.txt or obs_portable_mode.txt in BASE_PATH,
 *    which is "../.." from bin/64bit on Windows (the install root), and config lives in
 *    <install root>/config/obs-studio.
 *  - global.ini [Locations] Configuration / Profiles / SceneCollections (OBS 31+) can move
 *    user.ini, profiles and scene collections; each is a parent dir that gets "obs-studio/..."
 *    appended. OBS falls back to the default when the configured dir does not exist.
 *  - crash reports: Windows <config>/crashes/"Crash *.txt"; macOS
 *    ~/Library/Logs/DiagnosticReports/OBS*.ips; Linux <config>/crashes (best effort).
 *  - unclean-shutdown sentinel: <config>/.sentinel/run_<uuid>, removed on clean exit.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type Platform = 'win32' | 'darwin' | 'linux';

export interface PathEnv {
  platform: Platform;
  home: string;
  appData?: string | undefined;
  xdgConfigHome?: string | undefined;
  programFiles?: string[];
  /** Explicit override, used by tests and unusual installs (env CTRLSTREAM_OBS_CONFIG_DIR). */
  obsConfigDirOverride?: string | undefined;
  /** Explicit override of where ctrlstream keeps backups and snapshots (env CTRLSTREAM_DIR). */
  dataDirOverride?: string | undefined;
}

/**
 * Read an environment variable, treating empty values and unexpanded templates as unset.
 * Claude Desktop passes the literal "${user_config.obs_host}" for an optional .mcpb setting the
 * user left empty, so anything starting with "${" means "not set".
 */
export function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === '' || t.startsWith('${')) return undefined;
  return t;
}

export function currentPathEnv(): PathEnv {
  const platform = (['win32', 'darwin'].includes(process.platform) ? process.platform : 'linux') as Platform;
  const pf = [process.env['ProgramFiles'], process.env['ProgramW6432'], process.env['ProgramFiles(x86)']].filter(
    (p): p is string => !!p,
  );
  return {
    platform,
    home: homedir(),
    appData: envValue('APPDATA'),
    xdgConfigHome: envValue('XDG_CONFIG_HOME'),
    programFiles: pf,
    obsConfigDirOverride: envValue('CTRLSTREAM_OBS_CONFIG_DIR'),
    dataDirOverride: envValue('CTRLSTREAM_DIR'),
  };
}

/**
 * Join for the target OS. In production the target is the host. Windows-style roots (C:\, \\server)
 * use path.win32 on any host so Windows paths can be computed and tested anywhere; otherwise the
 * host path module is used, so tests can simulate a Windows layout inside a POSIX temp dir.
 */
function join(env: PathEnv, ...parts: string[]): string {
  if (env.platform === 'win32' && /^([A-Za-z]:[\\/]|\\\\)/.test(parts[0] ?? '')) return path.win32.join(...parts);
  return path.join(...parts);
}

/** Where OBS binaries usually live, per OS. First existing one wins. */
export function obsBinaryCandidates(env: PathEnv): string[] {
  switch (env.platform) {
    case 'darwin':
      return ['/Applications/OBS.app', join(env, env.home, 'Applications', 'OBS.app')];
    case 'win32': {
      const roots = env.programFiles && env.programFiles.length > 0 ? env.programFiles : ['C:\\Program Files'];
      const out: string[] = [];
      for (const root of roots) {
        out.push(join(env, root, 'obs-studio', 'bin', '64bit', 'obs64.exe'));
        out.push(join(env, root, 'Steam', 'steamapps', 'common', 'OBS Studio', 'bin', '64bit', 'obs64.exe'));
      }
      return out;
    }
    default:
      return ['/usr/bin/obs', '/usr/local/bin/obs', '/var/lib/flatpak/exports/bin/com.obsproject.Studio', '/snap/bin/obs-studio'];
  }
}

/** Default config roots per OS, in preference order (Linux has several packagings). */
export function defaultConfigDirCandidates(env: PathEnv): string[] {
  switch (env.platform) {
    case 'darwin':
      return [join(env, env.home, 'Library', 'Application Support', 'obs-studio')];
    case 'win32':
      return [join(env, env.appData ?? join(env, env.home, 'AppData', 'Roaming'), 'obs-studio')];
    default: {
      const xdg = env.xdgConfigHome ?? join(env, env.home, '.config');
      return [
        join(env, xdg, 'obs-studio'),
        join(env, env.home, '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio'),
        join(env, env.home, 'snap', 'obs-studio', 'current', '.config', 'obs-studio'),
      ];
    }
  }
}

const PORTABLE_MARKERS = ['portable_mode', 'obs_portable_mode', 'portable_mode.txt', 'obs_portable_mode.txt'];

/**
 * Windows portable installs: the binary is <root>/bin/64bit/obs64.exe, the marker sits in
 * <root>, the config in <root>/config/obs-studio. Best effort.
 */
export function portableConfigDir(env: PathEnv, binaryPath: string): string | null {
  if (env.platform !== 'win32') return null;
  // This only ever runs on Windows, where node's default path module is path.win32.
  const root = path.resolve(path.dirname(binaryPath), '..', '..');
  if (PORTABLE_MARKERS.some((m) => existsSync(path.join(root, m)))) {
    return path.join(root, 'config', 'obs-studio');
  }
  return null;
}

export interface ConfigDirResolution {
  dir: string;
  source: 'override' | 'portable' | 'default';
  exists: boolean;
}

export function resolveObsConfigDir(env: PathEnv): ConfigDirResolution {
  if (env.obsConfigDirOverride) {
    return { dir: env.obsConfigDirOverride, source: 'override', exists: existsSync(env.obsConfigDirOverride) };
  }
  if (env.platform === 'win32') {
    for (const bin of obsBinaryCandidates(env)) {
      if (!existsSync(bin)) continue;
      const portable = portableConfigDir(env, bin);
      if (portable) return { dir: portable, source: 'portable', exists: existsSync(portable) };
    }
  }
  const candidates = defaultConfigDirCandidates(env);
  // Prefer the candidate that has been used most recently (Linux can have several).
  let best: { dir: string; mtime: number } | null = null;
  for (const dir of candidates) {
    const marker = [join(env, dir, 'user.ini'), join(env, dir, 'global.ini')].find((p) => existsSync(p));
    if (!marker) continue;
    const mtime = statSync(marker).mtimeMs;
    if (!best || mtime > best.mtime) best = { dir, mtime };
  }
  const dir = best?.dir ?? candidates[0]!;
  return { dir, source: 'default', exists: existsSync(dir) };
}

/** Minimal ini lookup used only to resolve [Locations]; the full parser lives in files.ts. */
function readIniValue(file: string, section: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let current = '';
  for (const raw of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = sec[1]!;
      continue;
    }
    if (current !== section) continue;
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq) === key) return line.slice(eq + 1);
  }
  return undefined;
}

export interface ObsPaths {
  platform: Platform;
  configDir: string;
  configSource: ConfigDirResolution['source'];
  configExists: boolean;
  globalIni: string;
  userIni: string;
  profilesDir: string;
  scenesDir: string;
  logsDir: string;
  crashDirs: string[];
  sentinelDir: string;
  pluginConfigDir: string;
  websocketConfig: string;
}

export function resolveObsPaths(env: PathEnv = currentPathEnv()): ObsPaths {
  const res = resolveObsConfigDir(env);
  const configDir = res.dir;
  const parent = /^([A-Za-z]:[\\/]|\\\\)/.test(configDir) ? path.win32.dirname(configDir) : path.dirname(configDir);
  const globalIni = join(env, configDir, 'global.ini');

  // OBS 31+: [Locations] in global.ini, each a parent directory; fall back when missing.
  const loc = (key: string): string => {
    const v = readIniValue(globalIni, 'Locations', key);
    return v && existsSync(v) ? v : parent;
  };
  const userConfigRoot = loc('Configuration');
  const profilesRoot = loc('Profiles');
  const scenesRoot = loc('SceneCollections');

  const crashDirs =
    env.platform === 'darwin'
      ? [join(env, env.home, 'Library', 'Logs', 'DiagnosticReports')]
      : [join(env, configDir, 'crashes')];

  return {
    platform: env.platform,
    configDir,
    configSource: res.source,
    configExists: res.exists,
    globalIni,
    userIni: join(env, userConfigRoot, 'obs-studio', 'user.ini'),
    profilesDir: join(env, profilesRoot, 'obs-studio', 'basic', 'profiles'),
    scenesDir: join(env, scenesRoot, 'obs-studio', 'basic', 'scenes'),
    logsDir: join(env, configDir, 'logs'),
    crashDirs,
    sentinelDir: join(env, configDir, '.sentinel'),
    pluginConfigDir: join(env, configDir, 'plugin_config'),
    websocketConfig: join(env, configDir, 'plugin_config', 'obs-websocket', 'config.json'),
  };
}

/** Crash report file name filter per OS (see header comment). */
export function isCrashReportName(platform: Platform, name: string): boolean {
  if (platform === 'darwin') return name.startsWith('OBS') && name.endsWith('.ips');
  return name.startsWith('Crash ') || name.endsWith('.txt');
}

/** ~/.ctrlstream, or CTRLSTREAM_DIR. Backups, snapshots and the undo log live here. */
export function ctrlstreamDir(env: PathEnv = currentPathEnv()): string {
  return env.dataDirOverride ?? join(env, env.home, '.ctrlstream');
}
