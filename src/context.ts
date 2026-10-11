/**
 * Everything a tool handler needs, in one object. Production builds it from the real
 * environment; tests build it around a temp OBS config dir, the mock websocket server and a fake
 * process controller.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ObsClient } from './obs/client.js';
import type { ConnectOverrides } from './obs/client.js';
import { RealProcessControl } from './obs/discovery.js';
import type { ProcessControl } from './obs/discovery.js';
import { ctrlstreamDir, currentPathEnv, envValue, resolveObsPaths } from './obs/paths.js';
import type { ObsPaths, PathEnv } from './obs/paths.js';
import { realDisplayProbe } from './probes/displays.js';
import type { DisplayProbe } from './probes/displays.js';
import { realNetworkProbe } from './probes/network.js';
import type { NetworkProbe } from './probes/network.js';
import { realSystemProbe } from './probes/system.js';
import type { SystemProbe } from './probes/system.js';
import { SecretRegistry } from './safety/redact.js';

export interface Session {
  id: string;
  startedAt: Date;
  /** Set once the first mutating call has copied the profile and collection. */
  backupDir: string | null;
  /** True only during the call that created the backup, so the result can say so. */
  backupJustCreated: boolean;
  undoSeq: number;
  /** "<obs pid>:<source>" for macOS screen captures seen live in this session (they keep their picture afterwards). */
  shownScreenCaptures: Set<string>;
}

export interface Ctx {
  pathEnv: PathEnv;
  paths: ObsPaths;
  dataDir: string;
  /** Dev override for the knowledge tables (CTRLSTREAM_KNOWLEDGE_DIR); null = the copies embedded in the bundle. */
  knowledgeDir: string | null;
  obs: ObsClient;
  proc: ProcessControl;
  secrets: SecretRegistry;
  session: Session;
  system: SystemProbe;
  network: NetworkProbe;
  /** macOS displays from the OS (never from OBS's screen_capture list, which crashes OBS). */
  displays: DisplayProbe;
  now: () => Date;
  /** Polling interval and timeouts, shortened in tests. */
  timing: { pollMs: number; launchTimeoutMs: number; quitTimeoutMs: number; /** Multiplier for deliberate waits such as test_record's duration (tests use a tiny value). */ waitScale: number };
}

export function newSession(): Session {
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  return { id: `${stamp}-${randomUUID().slice(0, 8)}`, startedAt, backupDir: null, backupJustCreated: false, undoSeq: 0, shownScreenCaptures: new Set() };
}

export interface ContextOptions {
  pathEnv?: PathEnv;
  overrides?: ConnectOverrides;
  proc?: ProcessControl;
  system?: SystemProbe;
  network?: NetworkProbe;
  displays?: DisplayProbe;
  dataDir?: string;
  knowledgeDir?: string | null;
  obsClientFactory?: ConstructorParameters<typeof ObsClient>[2];
  timing?: Partial<Ctx['timing']>;
  now?: () => Date;
}

/** Runtime overrides from the environment (the .mcpb user_config maps onto these). */
export function envOverrides(env: NodeJS.ProcessEnv = process.env): ConnectOverrides {
  const port = Number(envValue('CTRLSTREAM_OBS_PORT', env));
  return {
    host: envValue('CTRLSTREAM_OBS_HOST', env),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined,
    password: envValue('CTRLSTREAM_OBS_PASSWORD', env),
  };
}

export function createContext(opts: ContextOptions = {}): Ctx {
  const pathEnv = opts.pathEnv ?? currentPathEnv();
  const paths = resolveObsPaths(pathEnv);
  const secrets = new SecretRegistry();
  const clientOpts = { ...(opts.obsClientFactory ?? {}), overrides: opts.overrides ?? envOverrides() };
  return {
    pathEnv,
    paths,
    dataDir: opts.dataDir ?? ctrlstreamDir(pathEnv),
    knowledgeDir: opts.knowledgeDir !== undefined ? opts.knowledgeDir : (envValue('CTRLSTREAM_KNOWLEDGE_DIR') ?? null),
    obs: new ObsClient(paths, secrets, clientOpts),
    proc: opts.proc ?? new RealProcessControl(pathEnv),
    secrets,
    session: newSession(),
    system: opts.system ?? realSystemProbe,
    network: opts.network ?? realNetworkProbe,
    displays: opts.displays ?? realDisplayProbe,
    now: opts.now ?? (() => new Date()),
    timing: { pollMs: 500, launchTimeoutMs: 30_000, quitTimeoutMs: 30_000, waitScale: 1, ...(opts.timing ?? {}) },
  };
}

export function dataPath(ctx: Ctx, ...parts: string[]): string {
  return path.join(ctx.dataDir, ...parts);
}
