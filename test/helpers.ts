/**
 * Unit-test harness: a temp home with a real-derived OBS config dir, the mock websocket server,
 * a fake OBS process and a ctrlstream context. Every tool output goes through runTool (the same
 * path as the MCP server, redaction included) and is checked for the dummy secrets on every call:
 * that is the suite-wide redaction grep (DESIGN 8).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '../src/context.js';
import type { Ctx } from '../src/context.js';
import type { PathEnv } from '../src/obs/paths.js';
import type { DisplayProbe, MacDisplay } from '../src/probes/displays.js';
import type { NetworkProbe } from '../src/probes/network.js';
import type { SystemInfo, SystemProbe } from '../src/probes/system.js';
import { toolByName } from '../src/tools/index.js';
import { runTool } from '../src/tools/registry.js';
import type { RunOutput } from '../src/tools/registry.js';
import { FakeProcess } from './mock/fake-process.js';
import { ObsModel } from './mock/obs-model.js';
import { MockObsServer } from './mock/obs-ws-server.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
export const DUMMY_KEY = 'live_123456789_DUMMYSTREAMKEYdoNotLeak42';
export const DUMMY_WS_PASSWORD = 'dummyWsPassw0rd-NotReal';
/** Fragments that must never appear in output (the key split up still counts). */
export const SECRET_MARKERS = [DUMMY_KEY, 'DUMMYSTREAMKEYdoNotLeak42', DUMMY_WS_PASSWORD];

export const FAKE_SYSTEM: SystemInfo = {
  os: { platform: 'darwin', distro: 'macOS', release: '26.2', arch: 'arm64' },
  cpu: { brand: 'Apple M2 Pro', manufacturer: 'Apple', physicalCores: 12, logicalCores: 12, speedGHz: 3.5 },
  memory: { totalMb: 32768, availableMb: 16000 },
  gpus: [{ vendor: 'Apple', model: 'Apple M2 Pro', vramMb: null, driverVersion: null }],
  displays: [{ name: 'Built-in Retina Display', width: 3456, height: 2234, refreshHz: 120, main: true }],
};

/** The real display on the QA Mac (uuid from CoreGraphics, label as OBS shows it). */
export const FAKE_DISPLAYS: MacDisplay[] = [
  { uuid: '37D8832A-2D66-02CA-B9F7-8F30A301B230', label: 'Built-in Retina Display: 1800x1169 @ 0,0', name: 'Built-in Retina Display', width: 1800, height: 1169, x: 0, y: 0, main: true },
];

export interface HarnessOptions {
  platform?: 'darwin' | 'win32';
  running?: boolean;
  /** Websocket password; null means auth off. */
  password?: string | null;
  wsEnabled?: boolean;
  /** Which config tree: the full real-derived one, or a never-launched machine. */
  config?: 'default' | 'none';
  system?: Partial<SystemInfo>;
  network?: NetworkProbe;
  displays?: DisplayProbe;
  logs?: string[];
}

export interface Harness {
  ctx: Ctx;
  server: MockObsServer;
  model: ObsModel;
  proc: FakeProcess;
  home: string;
  configDir: string;
  dataDir: string;
  profileDir: string;
  collectionFile: string;
  outputs: string[];
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  callRaw(name: string, args?: Record<string, unknown>): Promise<RunOutput>;
  cleanup(): Promise<void>;
}

export function assertNoSecrets(text: string, where: string): void {
  for (const m of SECRET_MARKERS) {
    if (text.includes(m)) throw new Error(`SECRET LEAK in ${where}: output contains ${m.slice(0, 8)}...`);
  }
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const platform = opts.platform ?? 'darwin';
  const tmp = mkdtempSync(path.join(tmpdir(), 'ctrlstream-test-'));
  const home = path.join(tmp, 'home');
  const configDir = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'obs-studio') : path.join(home, 'AppData', 'Roaming', 'obs-studio');
  const dataDir = path.join(tmp, 'data');
  const recordDir = path.join(tmp, 'recordings');
  mkdirSync(recordDir, { recursive: true });
  if ((opts.config ?? 'default') === 'default') cpSync(path.join(FIXTURES, 'obs-config'), configDir, { recursive: true });
  for (const l of opts.logs ?? []) {
    mkdirSync(path.join(configDir, 'logs'), { recursive: true });
    cpSync(path.join(FIXTURES, l), path.join(configDir, 'logs', path.basename(l)));
  }
  const profileDir = path.join(configDir, 'basic', 'profiles', 'Untitled');
  const collectionFile = path.join(configDir, 'basic', 'scenes', 'Untitled.json');

  const model = new ObsModel({ platform: platform === 'darwin' ? 'macos' : 'windows', profileIniPath: existsSync(profileDir) ? path.join(profileDir, 'basic.ini') : undefined, collectionPath: existsSync(collectionFile) ? collectionFile : undefined, recordDir });
  const server = new MockObsServer({ model, password: opts.password === undefined ? DUMMY_WS_PASSWORD : opts.password });
  const running = opts.running ?? true;
  // Reserve a port even when OBS starts "closed", so the config file can name it.
  await server.start();
  const port = server.port;
  if (!running) await server.stop();
  if ((opts.config ?? 'default') === 'default') {
    writeFileSync(
      path.join(configDir, 'plugin_config', 'obs-websocket', 'config.json'),
      JSON.stringify({ alerts_enabled: false, auth_required: opts.password !== null, first_load: false, server_enabled: opts.wsEnabled ?? true, server_password: opts.password === undefined ? DUMMY_WS_PASSWORD : (opts.password ?? ''), server_port: port }, null, 4),
    );
  }
  const proc = new FakeProcess(server, path.join(configDir, 'logs'), running);
  const pathEnv: PathEnv = { platform, home, appData: platform === 'win32' ? path.join(home, 'AppData', 'Roaming') : undefined, programFiles: [path.join(tmp, 'pf')] };
  const system: SystemProbe = { info: async () => ({ ...FAKE_SYSTEM, ...(opts.system ?? {}) }) };
  const network: NetworkProbe = opts.network ?? { uploadTest: async () => ({ bytes: 25_000_000, seconds: 10, requests: 12, errors: 0 }) };
  const ctx = createContext({
    pathEnv,
    overrides: {},
    proc,
    system,
    network,
    displays: opts.displays ?? { list: async () => FAKE_DISPLAYS },
    dataDir,
    // Knowledge comes from the copies embedded at build time, as in the shipped bundle.
    obsClientFactory: { connectTimeoutMs: 1500, requestTimeoutMs: 3000, notReadyRetryMs: 1500 },
    timing: { pollMs: 10, launchTimeoutMs: 1500, quitTimeoutMs: 1000, waitScale: 0.002 },
  });
  const outputs: string[] = [];
  const callRaw = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = toolByName(name);
    if (!tool) throw new Error(`no tool ${name}`);
    const out = await runTool(ctx, tool, args);
    const text = JSON.stringify(out.json);
    outputs.push(text);
    assertNoSecrets(text, name);
    return out;
  };
  return {
    ctx,
    server,
    model,
    proc,
    home,
    configDir,
    dataDir,
    profileDir,
    collectionFile,
    outputs,
    callRaw,
    call: async (name, args = {}) => (await callRaw(name, args)).json,
    cleanup: async () => {
      await ctx.obs.disconnect();
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Every file under a dir, for grepping what ctrlstream wrote. */
export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

export function read(p: string): string {
  return readFileSync(p, 'utf8');
}

export function expectOk(r: Record<string, unknown>): Record<string, unknown> {
  if (r['ok'] !== true) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
}

export function expectError(r: Record<string, unknown>, code?: string): { code: string; message: string; hint: string; suggestedTool?: string } {
  if (r['ok'] !== false) throw new Error(`expected error, got ${JSON.stringify(r).slice(0, 400)}`);
  const e = r['error'] as { code: string; message: string; hint: string; suggestedTool?: string };
  if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
  return e;
}
