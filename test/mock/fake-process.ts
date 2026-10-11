/**
 * Fake OBS process for unit tests: "running" means the mock websocket server is up. Launch can
 * also write a startup log into the temp config dir, as OBS does.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LaunchOptions, ObsProcess, ProcessControl, QuitResult } from '../../src/obs/discovery.js';
import type { MockObsServer } from './obs-ws-server.js';

export class FakeProcess implements ProcessControl {
  running: boolean;
  pid = 4242;
  launches: LaunchOptions[] = [];
  quits = 0;
  /** 'ok' exits on the polite request, 'sigterm' needs the second step, 'stuck' never exits. */
  quitBehavior: 'ok' | 'sigterm' | 'stuck' = 'ok';
  /** Launch starts the process but not the websocket (a dialog is up). */
  launchHangs = false;
  binaryPath: string | null = '/Applications/OBS.app';

  constructor(
    private readonly server: MockObsServer,
    private readonly logsDir: string | null,
    running = true,
  ) {
    this.running = running;
  }

  async find(): Promise<ObsProcess | null> {
    return this.running ? { pid: this.pid, command: '/Applications/OBS.app/Contents/MacOS/OBS' } : null;
  }

  binary(): string | null {
    return this.binaryPath;
  }

  async launch(opts: LaunchOptions): Promise<void> {
    this.launches.push(opts);
    this.running = true;
    if (this.logsDir) {
      mkdirSync(this.logsDir, { recursive: true });
      const lines = ['12:00:00.000: [macOS] Permission for screen capture denied.', '12:00:00.100: OBS 32.2.2 (mac)', ...(opts.safeMode ? ['12:00:00.200: Safe Mode enabled.'] : []), '12:00:00.300: ==== Startup complete ==============================================='];
      // Named like OBS names its logs: the local start time.
      const t = new Date(Date.now() + 1000);
      const p2 = (n: number) => String(n).padStart(2, '0');
      const name = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}-${p2(t.getMinutes())}-${p2(t.getSeconds())}.txt`;
      writeFileSync(path.join(this.logsDir, name), `${lines.join('\n')}\n`);
    }
    if (!opts.safeMode && !this.launchHangs) await this.server.start();
  }

  async quit(_proc: ObsProcess, opts: { timeoutMs: number; force: boolean }): Promise<QuitResult> {
    this.quits++;
    if (this.quitBehavior === 'stuck' && !opts.force) return { exited: false, escalated: 'sigterm', waitedMs: 10 };
    this.running = false;
    await this.server.stop();
    return { exited: true, escalated: this.quitBehavior === 'stuck' ? 'force' : this.quitBehavior === 'sigterm' ? 'sigterm' : 'none', waitedMs: 5 };
  }
}
