/** Outputs: stream, record, replay buffer, virtual camera, test recording. */
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ToolError } from '../errors.js';
import { mutate } from '../safety/mutate.js';
import { requireConnection } from './common.js';
import { defineTool } from './registry.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(ctx: Ctx, check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(Math.min(ctx.timing.pollMs, 250));
  }
  return check();
}

function streamSummary(s: { outputActive: boolean; outputReconnecting: boolean; outputCongestion: number; outputSkippedFrames: number; outputTotalFrames: number; outputBytes: number; outputDuration: number; outputTimecode: string }) {
  return {
    active: s.outputActive,
    reconnecting: s.outputReconnecting,
    congestion: Math.round((s.outputCongestion ?? 0) * 100) / 100,
    skippedFrames: s.outputSkippedFrames,
    totalFrames: s.outputTotalFrames,
    droppedPercent: s.outputTotalFrames > 0 ? Math.round((1000 * s.outputSkippedFrames) / s.outputTotalFrames) / 10 : 0,
    bytes: s.outputBytes,
    durationSeconds: Math.round(s.outputDuration / 1000),
    timecode: s.outputTimecode,
  };
}

function recordSummary(r: { outputActive: boolean; outputPaused: boolean; outputBytes: number; outputDuration: number; outputTimecode: string }) {
  return { active: r.outputActive, paused: r.outputPaused, bytes: r.outputBytes, durationSeconds: Math.round(r.outputDuration / 1000), timecode: r.outputTimecode };
}

export const streamStart = defineTool({
  name: 'stream_start',
  title: 'Go live',
  description:
    'Start streaming. This GOES LIVE to the public on the configured platform: only call it when the user has explicitly asked to go live now. Refuses if no stream key is set (the user pastes it in OBS Settings > Stream). Waits up to 15 s for the stream to connect. Then watch stream_status for congestion and dropped frames. Not undoable (use stream_stop).',
  input: {},
  mutating: true,
  fileWriting: false,
  handler: async (_args, ctx) => {
    await requireConnection(ctx);
    const svc = await ctx.obs.call('GetStreamServiceSettings');
    const key = (svc.streamServiceSettings as Record<string, unknown>)['key'];
    if (svc.streamServiceType !== 'whip_custom' && !(typeof key === 'string' && key.length > 0)) {
      throw new ToolError('INVALID_ARGUMENT', 'No stream key is set, so the platform would reject the stream.', 'Ask the user to paste their stream key into OBS (Settings > Stream > Stream Key), then try again.', 'stream_service_get');
    }
    if ((await ctx.obs.call('GetStreamStatus')).outputActive) return { alreadyLive: true, ...streamSummary(await ctx.obs.call('GetStreamStatus')) };
    await mutate(ctx, { tool: 'stream_start', undoable: false, apply: () => ctx.obs.call('StartStream') });
    const ok = await waitFor(ctx, async () => (await ctx.obs.call('GetStreamStatus')).outputActive, 15_000);
    const s = streamSummary(await ctx.obs.call('GetStreamStatus'));
    if (!ok) throw new ToolError('TIMEOUT', 'The stream did not start within 15 s.', 'OBS may be showing a connection error dialog. Check the server and key (stream_service_get), the network, then logs_tail.', 'logs_tail');
    return { live: true, ...s };
  },
});

export const streamStop = defineTool({
  name: 'stream_stop',
  title: 'End stream',
  description: 'Stop streaming: this ends the broadcast for viewers, so only call it when the user asks or agrees. Waits until OBS reports the stream stopped. Starting again is stream_start; there is no undo.',
  input: {},
  mutating: true,
  fileWriting: false,
  annotations: { destructiveHint: true },
  handler: async (_args, ctx) => {
    await requireConnection(ctx);
    if (!(await ctx.obs.call('GetStreamStatus')).outputActive) return { wasLive: false };
    await mutate(ctx, { tool: 'stream_stop', undoable: false, apply: () => ctx.obs.call('StopStream') });
    const ok = await waitFor(ctx, async () => !(await ctx.obs.call('GetStreamStatus')).outputActive, 15_000);
    return { wasLive: true, stopped: ok };
  },
});

export const streamStatus = defineTool({
  name: 'stream_status',
  title: 'Stream health',
  description: 'Whether the stream is live, reconnecting, network congestion (0 = fine, above 0.3 = the connection is struggling), dropped frames and percentage, bytes sent and duration. Changes nothing.',
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    await requireConnection(ctx);
    return streamSummary(await ctx.obs.call('GetStreamStatus'));
  },
});

export const recordStart = defineTool({
  name: 'record_start',
  title: 'Start recording',
  description: 'Start recording to the configured folder (record_set). For a quick health check use test_record instead, which also stops and measures. Not undoable (use record_stop).',
  input: {},
  mutating: true,
  fileWriting: false,
  handler: async (_args, ctx) => {
    await requireConnection(ctx);
    if ((await ctx.obs.call('GetRecordStatus')).outputActive) return { alreadyRecording: true };
    await mutate(ctx, { tool: 'record_start', undoable: false, apply: () => ctx.obs.call('StartRecord') });
    const ok = await waitFor(ctx, async () => (await ctx.obs.call('GetRecordStatus')).outputActive, 10_000);
    if (!ok) throw new ToolError('TIMEOUT', 'Recording did not start within 10 s.', 'OBS may be showing an error dialog (bad folder, encoder failure). Check logs_tail.', 'logs_tail');
    return { recording: true, folder: (await ctx.obs.call('GetRecordDirectory')).recordDirectory };
  },
});

export const recordStop = defineTool({
  name: 'record_stop',
  title: 'Stop recording',
  description: 'Stop the current recording and return the saved file path and its size once OBS has finished writing it. A size of 0 or a missing file means recording is broken: run diagnose. Not undoable.',
  input: {},
  mutating: true,
  fileWriting: false,
  handler: async (_args, ctx) => {
    await requireConnection(ctx);
    if (!(await ctx.obs.call('GetRecordStatus')).outputActive) return { wasRecording: false };
    const r = await mutate(ctx, { tool: 'record_stop', undoable: false, apply: () => ctx.obs.call('StopRecord') });
    await waitFor(ctx, async () => !(await ctx.obs.call('GetRecordStatus')).outputActive, 15_000);
    const size = await stableSize(ctx, r.outputPath);
    return { wasRecording: true, path: r.outputPath, sizeBytes: size };
  },
});

export const recordStatus = defineTool({
  name: 'record_status',
  title: 'Recording status',
  description: 'Whether OBS is recording right now, whether it is paused, bytes written and duration. Use before obs_quit or settings changes that OBS refuses while recording. Changes nothing.',
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    await requireConnection(ctx);
    return recordSummary(await ctx.obs.call('GetRecordStatus'));
  },
});

export const replayBufferSet = defineTool({
  name: 'replay_buffer_set',
  title: 'Replay buffer',
  description: "Start or stop the replay buffer (keeps the last N seconds in memory), and/or save it to a file with save: true. The replay buffer must be enabled in OBS Settings > Output first; if it is not, the error says so.",
  input: { active: z.boolean().optional(), save: z.boolean().optional() },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    if (args.active === undefined && !args.save) throw new ToolError('INVALID_ARGUMENT', 'Nothing to do.', 'Give active and/or save: true.');
    const status = await ctx.obs.tryCall('GetReplayBufferStatus');
    if (!status) throw new ToolError('UNSUPPORTED', 'The replay buffer is not enabled in this profile.', 'Ask the user to enable it in OBS Settings > Output > Replay Buffer (then OBS restarts its outputs).');
    let active = status.outputActive;
    if (args.active !== undefined && args.active !== active) {
      await mutate(ctx, { tool: 'replay_buffer_set', undoable: false, args, apply: () => ctx.obs.call(args.active ? 'StartReplayBuffer' : 'StopReplayBuffer') });
      await waitFor(ctx, async () => (await ctx.obs.call('GetReplayBufferStatus')).outputActive === args.active, 10_000);
      active = (await ctx.obs.call('GetReplayBufferStatus')).outputActive;
    }
    let savedPath: string | null = null;
    if (args.save) {
      if (!active) throw new ToolError('OUTPUT_NOT_ACTIVE', 'The replay buffer is not running, so there is nothing to save.', 'Start it with active: true first.');
      await ctx.obs.call('SaveReplayBuffer');
      await sleep(1500);
      savedPath = (await ctx.obs.tryCall('GetLastReplayBufferReplay'))?.savedReplayPath ?? null;
    }
    return { active, ...(args.save ? { savedPath } : {}) };
  },
});

export const virtualCameraSet = defineTool({
  name: 'virtual_camera_set',
  title: 'Virtual camera',
  description: 'Start or stop the OBS virtual camera, which lets Zoom, Meet, Discord and the like use the OBS output as a webcam. On macOS the first start may need the user to approve the camera extension in System Settings.',
  input: { active: z.boolean() },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const cur = (await ctx.obs.call('GetVirtualCamStatus')).outputActive;
    if (cur === args.active) return { active: cur, changed: false };
    await mutate(ctx, { tool: 'virtual_camera_set', undoable: false, args, apply: () => ctx.obs.call(args.active ? 'StartVirtualCam' : 'StopVirtualCam') });
    const ok = await waitFor(ctx, async () => (await ctx.obs.call('GetVirtualCamStatus')).outputActive === args.active, 10_000);
    if (!ok) throw new ToolError('TIMEOUT', `The virtual camera did not ${args.active ? 'start' : 'stop'}.`, 'On macOS the camera extension may need approval in System Settings > General > Login Items & Extensions.');
    return { active: args.active, changed: true };
  },
});

/** Wait until a just-finished recording stops growing (hybrid MP4/MOV finalise after stop). */
async function stableSize(ctx: Ctx, file: string | undefined): Promise<number | null> {
  if (!file) return null;
  let last = -1;
  for (let i = 0; i < 20; i++) {
    try {
      const s = (await stat(file)).size;
      if (s === last && s > 0) return s;
      last = s;
    } catch {
      /* not there yet */
    }
    await sleep(Math.min(ctx.timing.pollMs, 250));
  }
  return last >= 0 ? last : null;
}

export const testRecord = defineTool({
  name: 'test_record',
  title: 'Test recording',
  description:
    'The health check after any change: records for N seconds (default 30, max 50), stops, and returns the file path and size, the stats delta, and the percentage of frames skipped by the encoder and missed by the renderer during the test. Under 1% each is healthy. A missing or empty file means the recording setup is broken. Uses the normal recording folder; tell the user a short test file will be created there.',
  input: { seconds: z.number().int().min(3).max(50).optional() },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const seconds = args.seconds ?? 30;
    if ((await ctx.obs.call('GetRecordStatus')).outputActive) throw new ToolError('OUTPUT_ACTIVE', 'OBS is already recording.', 'Stop the current recording first (record_stop), or wait for it to finish.', 'record_stop');
    const result = await mutate(ctx, {
      tool: 'test_record',
      undoable: false,
      args: { seconds },
      apply: async () => {
        const before = await ctx.obs.call('GetStats');
        await ctx.obs.call('StartRecord');
        const started = await waitFor(ctx, async () => (await ctx.obs.call('GetRecordStatus')).outputActive, 10_000);
        if (!started) throw new ToolError('TIMEOUT', 'Recording did not start within 10 s.', 'OBS may be showing an error dialog (bad folder, encoder failure). Check logs_tail.', 'logs_tail');
        await sleep(seconds * 1000 * ctx.timing.waitScale);
        const stop = await ctx.obs.call('StopRecord');
        await waitFor(ctx, async () => !(await ctx.obs.call('GetRecordStatus')).outputActive, 15_000);
        const after = await ctx.obs.call('GetStats');
        return { before, after, path: stop.outputPath };
      },
    });
    const d = (k: 'renderSkippedFrames' | 'renderTotalFrames' | 'outputSkippedFrames' | 'outputTotalFrames') => Math.max(0, result.after[k] - result.before[k]);
    const sizeBytes = await stableSize(ctx, result.path);
    const encPct = d('outputTotalFrames') > 0 ? Math.round((1000 * d('outputSkippedFrames')) / d('outputTotalFrames')) / 10 : 0;
    const renderPct = d('renderTotalFrames') > 0 ? Math.round((1000 * d('renderSkippedFrames')) / d('renderTotalFrames')) / 10 : 0;
    return {
      path: result.path,
      sizeBytes,
      seconds,
      statsDelta: { renderSkipped: d('renderSkippedFrames'), renderTotal: d('renderTotalFrames'), outputSkipped: d('outputSkippedFrames'), outputTotal: d('outputTotalFrames') },
      skippedFramePercent: encPct,
      renderLagPercent: renderPct,
      averageFps: Math.round((d('outputTotalFrames') / seconds) * 10) / 10,
      cpuUsage: Math.round(result.after.cpuUsage * 10) / 10,
      healthy: !!sizeBytes && sizeBytes > 0 && encPct < 1 && renderPct < 1,
    };
  },
});

export const outputTools = [streamStart, streamStop, streamStatus, recordStart, recordStop, recordStatus, replayBufferSet, virtualCameraSet, testRecord];
