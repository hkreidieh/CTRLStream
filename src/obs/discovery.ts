/**
 * Is OBS running, launch it, quit it, and its websocket config. OS-level work only; the
 * websocket client is in client.ts. All of it sits behind the ProcessControl interface so the
 * unit tests can drive a fake OBS process in step with the mock websocket server.
 *
 * Quit behaviour verified on the real OBS 32.2.2 (macOS) and in its source
 * (frontend/OBSApp.cpp processSigTerm): `osascript quit` is refused with "User canceled (-128)"
 * while a modal dialog such as the first-run Auto-Configuration Wizard is open, and OBS handles
 * SIGTERM on macOS and Linux by quitting cleanly through Qt (log ends with "Number of memory
 * leaks: 0", no unclean-shutdown sentinel). So SIGTERM is the graceful escalation; SIGKILL
 * (taskkill /F on Windows) is only used with force: true.
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Ctx } from '../context.js';
import { fileWrite } from '../safety/file-write.js';
import { readJson, readWebsocketConfig } from './files.js';
import type { PathEnv, Platform } from './paths.js';
import { obsBinaryCandidates } from './paths.js';

const execFileP = promisify(execFile);

export interface ObsProcess {
  pid: number;
  command?: string;
}

export interface LaunchOptions {
  safeMode?: boolean | undefined;
  onlyBundledPlugins?: boolean | undefined;
  profile?: string | undefined;
  collection?: string | undefined;
}

export type Escalation = 'none' | 'sigterm' | 'force';

export interface QuitResult {
  exited: boolean;
  escalated: Escalation;
  waitedMs: number;
  detail?: string;
}

export interface ProcessControl {
  find(): Promise<ObsProcess | null>;
  binary(): string | null;
  launch(opts: LaunchOptions): Promise<void>;
  quit(proc: ObsProcess, opts: { timeoutMs: number; force: boolean }): Promise<QuitResult>;
}

export function launchArgs(opts: LaunchOptions): string[] {
  const args: string[] = [];
  if (opts.safeMode) args.push('--safe-mode');
  if (opts.onlyBundledPlugins) args.push('--only-bundled-plugins');
  if (opts.profile) args.push('--profile', opts.profile);
  if (opts.collection) args.push('--collection', opts.collection);
  return args;
}

/** Matches the OBS binary in a `ps` args column, per OS. */
export function isObsCommand(platform: Platform, args: string): boolean {
  if (platform === 'darwin') return /\/OBS\.app\/Contents\/MacOS\/OBS(\s|$)/.test(args);
  if (platform === 'linux') {
    const exe = args.split(/\s+/)[0] ?? '';
    return path.posix.basename(exe) === 'obs' || /com\.obsproject\.Studio/.test(args) && /(^|\/)obs(\s|$)/.test(args);
  }
  return /obs64\.exe/i.test(args);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForExit(isAlive: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isAlive())) return true;
    await sleep(250);
  }
  return !(await isAlive());
}

export class RealProcessControl implements ProcessControl {
  constructor(private readonly env: PathEnv) {}

  binary(): string | null {
    return obsBinaryCandidates(this.env).find((p) => existsSync(p)) ?? null;
  }

  async find(): Promise<ObsProcess | null> {
    if (this.env.platform === 'win32') {
      try {
        const { stdout } = await execFileP('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
        const m = /"obs64\.exe","(\d+)"/i.exec(stdout);
        return m ? { pid: Number(m[1]), command: 'obs64.exe' } : null;
      } catch {
        return null;
      }
    }
    try {
      const { stdout } = await execFileP('ps', ['-axo', 'pid=,args='], { maxBuffer: 16 * 1024 * 1024 });
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (m && isObsCommand(this.env.platform, m[2]!)) return { pid: Number(m[1]), command: m[2]! };
      }
    } catch {
      /* ps unavailable */
    }
    return null;
  }

  async launch(opts: LaunchOptions): Promise<void> {
    const bin = this.binary();
    const args = launchArgs(opts);
    if (this.env.platform === 'darwin') {
      if (!bin) throw new Error('OBS.app not found in /Applications or ~/Applications');
      // `open --args` passes flags only when the app is not already running, which is the
      // only case we launch in.
      await execFileP('open', ['-a', bin, ...(args.length ? ['--args', ...args] : [])]);
      return;
    }
    if (!bin) throw new Error('OBS binary not found in the usual install locations');
    const child = spawn(bin, args, {
      cwd: path.dirname(bin), // OBS on Windows expects to start in bin/64bit
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
  }

  async quit(proc: ObsProcess, opts: { timeoutMs: number; force: boolean }): Promise<QuitResult> {
    const start = Date.now();
    const stillThere = async () => alive(proc.pid);
    let detail: string | undefined;

    // 1. The polite request.
    try {
      if (this.env.platform === 'darwin') {
        await execFileP('osascript', ['-e', 'quit app "OBS"'], { timeout: 10_000 });
      } else if (this.env.platform === 'win32') {
        await execFileP('taskkill', ['/PID', String(proc.pid)], { windowsHide: true });
      } else {
        process.kill(proc.pid, 'SIGTERM');
      }
    } catch (e) {
      detail = (e as Error).message.split('\n')[0];
    }
    const politeWait = Math.min(opts.timeoutMs, this.env.platform === 'linux' ? opts.timeoutMs : 15_000);
    if (await waitForExit(stillThere, politeWait)) {
      return { exited: true, escalated: 'none', waitedMs: Date.now() - start, ...(detail ? { detail } : {}) };
    }

    // 2. SIGTERM on macOS: OBS quits cleanly through Qt even with a modal dialog open.
    if (this.env.platform === 'darwin') {
      try {
        process.kill(proc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      if (await waitForExit(stillThere, Math.max(5_000, opts.timeoutMs - (Date.now() - start)))) {
        return { exited: true, escalated: 'sigterm', waitedMs: Date.now() - start, ...(detail ? { detail } : {}) };
      }
    }

    // 3. Only when asked: kill.
    if (opts.force) {
      try {
        if (this.env.platform === 'win32') await execFileP('taskkill', ['/F', '/PID', String(proc.pid)], { windowsHide: true });
        else process.kill(proc.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      const exited = await waitForExit(stillThere, 5_000);
      return { exited, escalated: 'force', waitedMs: Date.now() - start, ...(detail ? { detail } : {}) };
    }
    return {
      exited: false,
      escalated: this.env.platform === 'darwin' ? 'sigterm' : 'none',
      waitedMs: Date.now() - start,
      ...(detail ? { detail } : {}),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Websocket config (plugin_config/obs-websocket/config.json). Keys verified against obs-websocket
// 5.7.4 src/Config.cpp: first_load, server_enabled, server_port, alerts_enabled, auth_required,
// server_password. On first load obs-websocket generates a password itself and leaves the server
// disabled (seen on the real OBS 32.2.2: auth_required true, server_enabled false).



export interface EnableResult {
  changed: boolean;
  createdFile: boolean;
  passwordGenerated: boolean;
  port: number;
}

/** Turn the websocket server on, with OBS closed. Never returns or logs the password. */
export async function enableWebsocketConfig(ctx: Ctx): Promise<EnableResult> {
  return fileWrite(ctx, 'obs_connect', async (w) => {
    const raw = (await readJson<Record<string, unknown>>(ctx.paths.websocketConfig)) ?? null;
    const cfg = await readWebsocketConfig(ctx.paths, ctx.secrets);
    const next: Record<string, unknown> = {
      alerts_enabled: false,
      auth_required: true,
      first_load: false,
      server_enabled: true,
      server_port: 4455,
      ...(raw ?? {}),
    };
    next['server_enabled'] = true;
    next['first_load'] = false;
    let generated = false;
    if (next['auth_required'] !== false && !(typeof next['server_password'] === 'string' && next['server_password'].length >= 6)) {
      next['server_password'] = randomBytes(24).toString('base64url');
      next['auth_required'] = true;
      generated = true;
    }
    ctx.secrets.add(next['server_password']);
    const changed = !cfg.serverEnabled || generated || !raw;
    if (changed) await w.writeJson(ctx.paths.websocketConfig, next);
    return { changed, createdFile: !raw, passwordGenerated: generated, port: Number(next['server_port']) || 4455 };
  });
}
