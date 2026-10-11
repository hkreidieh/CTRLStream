/** Diagnosis: diagnose, logs_tail, stats. */
import path from 'node:path';
import { z } from 'zod';
import { runDiagnose } from '../diagnose/report.js';
import { ToolError } from '../errors.js';
import { listLogs, parseLog, readText } from '../obs/files.js';
import { requireConnection } from './common.js';
import { defineTool } from './registry.js';

export const diagnose = defineTool({
  name: 'diagnose',
  title: 'Diagnose OBS',
  description:
    "One call for 'OBS is broken': gathers whether OBS runs, websocket, crash reports and unclean shutdowns, live stats, stream and recording health, video/output/audio settings, present devices, the current log's encoders, errors and warnings, and drift against the newest known-good snapshot, then returns deterministic findings with severity, evidence, suggestedTool and suggestedAction (codes such as DEVICE_MISSING, ENCODER_OVERLOAD, NETWORK_DROPS, OUTPUT_DRIFT). Act on findings in severity order, then verify with test_record. Read-only (device listing may briefly use the scratch scene).",
  input: { checkDevices: z.boolean().optional().describe('Default true') },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => ({ ...(await runDiagnose(ctx, { devices: args.checkDevices !== false })) }),
});

export const logsTail = defineTool({
  name: 'logs_tail',
  title: 'OBS log',
  description: "The last lines of an OBS log (default the newest, 80 lines, max 400), plus errors, warnings and encoder-overload lines extracted from the whole file, and the names of recent logs. Optional grep keeps only matching lines. Stream keys and passwords are scrubbed. Changes nothing.",
  input: {
    lines: z.number().int().min(1).max(400).optional(),
    file: z.string().min(1).optional().describe('A log file name from this tool’s recentLogs'),
    grep: z.string().min(1).max(100).optional(),
  },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    const logs = await listLogs(ctx.paths);
    if (logs.length === 0) throw new ToolError('NOT_FOUND', `No OBS logs in ${ctx.paths.logsDir}.`, 'OBS writes a log each time it starts; launch it once.', 'obs_launch');
    let entry = logs[0]!;
    if (args.file) {
      if (path.basename(args.file) !== args.file) throw new ToolError('INVALID_ARGUMENT', 'file must be a log file name, not a path.', 'Use a name from recentLogs.');
      const hit = logs.find((l) => l.file === args.file);
      if (!hit) throw new ToolError('NOT_FOUND', `No log named '${args.file}'.`, `Recent logs: ${logs.slice(0, 5).map((l) => l.file).join(', ')}.`);
      entry = hit;
    }
    const text = (await readText(entry.path)) ?? '';
    const parsed = parseLog(text);
    let lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (args.grep) {
      const needle = args.grep.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(needle));
    }
    const n = args.lines ?? 80;
    return {
      file: entry.file,
      totalLines: parsed.lineCount,
      obsVersion: parsed.obsVersion ?? null,
      safeMode: parsed.safeMode,
      cleanShutdown: parsed.cleanShutdown,
      lines: lines.slice(-n).map((l) => (l.length > 400 ? `${l.slice(0, 397)}...` : l)),
      errors: parsed.errors.slice(0, 20),
      warnings: parsed.warnings.slice(0, 20),
      encoderOverload: parsed.encoderOverload.slice(0, 5),
      recentLogs: logs.slice(0, 5).map((l) => l.file),
    };
  },
});

export const stats = defineTool({
  name: 'stats',
  title: 'Performance stats',
  description: "OBS performance right now: CPU %, memory, fps, average render time, frames missed by the renderer (GPU) and skipped by the encoder, free disk space, plus stream and recording status. Rules of thumb: render or encoder skips above 1% mean trouble. Changes nothing.",
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    await requireConnection(ctx);
    const [s, st, rc] = await Promise.all([ctx.obs.call('GetStats'), ctx.obs.call('GetStreamStatus'), ctx.obs.call('GetRecordStatus')]);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : 0);
    return {
      cpuUsage: Math.round(s.cpuUsage * 10) / 10,
      memoryMb: Math.round(s.memoryUsage),
      activeFps: Math.round(s.activeFps * 100) / 100,
      averageFrameRenderTimeMs: Math.round(s.averageFrameRenderTime * 100) / 100,
      renderSkipped: s.renderSkippedFrames,
      renderTotal: s.renderTotalFrames,
      renderSkippedPercent: pct(s.renderSkippedFrames, s.renderTotalFrames),
      outputSkipped: s.outputSkippedFrames,
      outputTotal: s.outputTotalFrames,
      outputSkippedPercent: pct(s.outputSkippedFrames, s.outputTotalFrames),
      diskFreeMb: Math.round(s.availableDiskSpace),
      stream: { active: st.outputActive, reconnecting: st.outputReconnecting, congestion: Math.round(st.outputCongestion * 100) / 100, skipped: st.outputSkippedFrames, total: st.outputTotalFrames, durationSeconds: Math.round(st.outputDuration / 1000) },
      record: { active: rc.outputActive, paused: rc.outputPaused, durationSeconds: Math.round(rc.outputDuration / 1000), bytes: rc.outputBytes },
    };
  },
});

export const diagnosisTools = [diagnose, logsTail, stats];
