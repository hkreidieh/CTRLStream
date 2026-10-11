/** Settings: video, output, recording, audio, stream service. */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ToolError } from '../errors.js';
import { CHANNEL_SETUPS, OTHER_APPLY, REC_FORMATS, REC_QUALITIES, SIMPLE_ENCODERS, SIMPLE_OUTPUT_APPLY, SIMPLE_STREAM_ENCODER_IDS } from '../obs/config-keys.js';
import type { ApplyTiming } from '../obs/config-keys.js';
import { iniGet, parseIni, readJson, readServiceJson, readText, resolveProfileAndCollection, serializeIni, iniSet, summarizeService } from '../obs/files.js';
import { defaultServer, loadServices } from '../obs/services.js';
import { encoderReport } from '../probes/encoders.js';
import { clearClosedState } from '../diagnose/closed-state.js';
import { fileWrite } from '../safety/file-write.js';
import { mutate } from '../safety/mutate.js';
import { copyIntoPrivate } from '../safety/store.js';
import type { UndoAction, WsRequest } from '../safety/undo.js';
import { collectState, fileReader, liveReader, videoFromReader } from '../snapshots/state.js';
import { requireConnection } from './common.js';
import { defineTool } from './registry.js';

// ----- helpers ---------------------------------------------------------------------------------

async function profileParam(ctx: Ctx, section: string, key: string): Promise<{ value: string | null; default: string | null }> {
  const r = await ctx.obs.call('GetProfileParameter', { parameterCategory: section, parameterName: key });
  return { value: r.parameterValue ?? null, default: r.defaultParameterValue ?? null };
}

interface ParamChange {
  section: string;
  key: string;
  value: string;
  setting: string;
  appliesOn: ApplyTiming;
}

/** SetProfileParameter a list of keys through mutate(), with an exact inverse. */
async function setProfileParams(ctx: Ctx, tool: string, args: unknown, changes: ParamChange[], extra?: { request: WsRequest; inverse: WsRequest }) {
  return mutate(ctx, {
    tool,
    args,
    before: async () => {
      const out: Record<string, { value: string | null; default: string | null }> = {};
      for (const c of changes) out[`${c.section}.${c.key}`] = await profileParam(ctx, c.section, c.key);
      return out;
    },
    apply: async (before) => {
      if (extra) await ctx.obs.call(extra.request.requestType, extra.request.requestData as never);
      for (const c of changes) await ctx.obs.call('SetProfileParameter', { parameterCategory: c.section, parameterName: c.key, parameterValue: c.value });
      return before;
    },
    inverse: (before): UndoAction => ({
      kind: 'ws',
      requests: [
        // A key that was unset goes back to unset (null deletes it, restoring OBS's default).
        ...changes.map((c) => ({ requestType: 'SetProfileParameter' as const, requestData: { parameterCategory: c.section, parameterName: c.key, parameterValue: before[`${c.section}.${c.key}`]?.value ?? null } })),
        ...(extra ? [extra.inverse] : []),
      ],
    }),
  });
}

function changeReport(changes: ParamChange[], before: Record<string, { value: string | null; default: string | null }>) {
  return changes.map((c) => {
    const b = before[`${c.section}.${c.key}`];
    return { setting: c.setting, parameter: `${c.section}.${c.key}`, from: b?.value ?? b?.default ?? null, to: c.value, appliesOn: c.appliesOn };
  });
}

const RESTART_NOTE =
  'Changes marked restart are stored now but OBS only reads them when it resets its outputs: after obs_quit + obs_launch (or switching profile, or OK in OBS Settings). Changes marked next_start apply the next time a stream or recording starts.';

async function saveForUndo(ctx: Ctx, file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  const dst = path.join(ctx.dataDir, 'undo', ctx.session.id, 'files', `${Date.now()}-${path.basename(file)}`);
  await copyIntoPrivate(ctx, file, dst);
  return dst;
}

const FPS_COMMON: Record<string, [number, number]> = { '23.976': [24000, 1001], '29.97': [30000, 1001], '59.94': [60000, 1001] };

// ----- video -----------------------------------------------------------------------------------

export const videoGet = defineTool({
  name: 'video_get',
  title: 'Video settings',
  description: 'Canvas (base) resolution, output (scaled) resolution and frame rate. Live from OBS when connected, otherwise from the profile on disk. Changes nothing.',
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    if (ctx.obs.connected || (await ctx.proc.find())) {
      await requireConnection(ctx);
      const v = await ctx.obs.call('GetVideoSettings');
      return { source: 'live', ...v, fps: Math.round((v.fpsNumerator / v.fpsDenominator) * 1000) / 1000 };
    }
    const { profile } = await resolveProfileAndCollection(ctx.paths);
    const v = videoFromReader(await fileReader(profile?.path ?? null));
    return { source: 'files', ...v, fps: v.fpsNumerator && v.fpsDenominator ? Math.round((v.fpsNumerator / v.fpsDenominator) * 1000) / 1000 : null };
  },
});

export const videoSet = defineTool({
  name: 'video_set',
  title: 'Change video settings',
  description:
    'Set canvas (base) resolution, output (scaled) resolution and/or frame rate. Width and height go in pairs. fps accepts 30, 60, 29.97, 59.94 and the like, or give fpsNumerator/fpsDenominator. Applies immediately, but OBS refuses while streaming or recording. A canvas change can push sources off-screen: check with screenshot and fix with scene_item_transform_set. Undoable.',
  input: {
    baseWidth: z.number().int().min(8).max(4096).optional(),
    baseHeight: z.number().int().min(8).max(4096).optional(),
    outputWidth: z.number().int().min(8).max(4096).optional(),
    outputHeight: z.number().int().min(8).max(4096).optional(),
    fps: z.number().positive().max(240).optional(),
    fpsNumerator: z.number().int().min(1).optional(),
    fpsDenominator: z.number().int().min(1).optional(),
  },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const req: Record<string, number> = {};
    const pair = (a?: number, b?: number, na?: string, nb?: string) => {
      if ((a === undefined) !== (b === undefined)) throw new ToolError('INVALID_ARGUMENT', `${na} and ${nb} must be given together.`, 'OBS sets width and height as a pair.');
      if (a !== undefined && b !== undefined) {
        req[na!] = a;
        req[nb!] = b;
      }
    };
    pair(args.baseWidth, args.baseHeight, 'baseWidth', 'baseHeight');
    pair(args.outputWidth, args.outputHeight, 'outputWidth', 'outputHeight');
    if (args.fps !== undefined) {
      const common = FPS_COMMON[String(args.fps)];
      if (common) [req['fpsNumerator'], req['fpsDenominator']] = common;
      else if (Number.isInteger(args.fps)) [req['fpsNumerator'], req['fpsDenominator']] = [args.fps, 1];
      else throw new ToolError('INVALID_ARGUMENT', `fps ${args.fps} is not a whole number or a standard NTSC rate.`, 'Use 24, 25, 30, 48, 50, 60, 23.976, 29.97 or 59.94, or fpsNumerator/fpsDenominator.');
    } else pair(args.fpsNumerator, args.fpsDenominator, 'fpsNumerator', 'fpsDenominator');
    if (Object.keys(req).length === 0) throw new ToolError('INVALID_ARGUMENT', 'Nothing to change.', 'Give a resolution pair and/or fps.');
    const before = await mutate(ctx, {
      tool: 'video_set',
      args,
      before: () => ctx.obs.call('GetVideoSettings'),
      apply: async (b) => {
        await ctx.obs.call('SetVideoSettings', req as never);
        return b;
      },
      after: () => ctx.obs.call('GetVideoSettings'),
      inverse: (b) => ({ kind: 'ws', requests: [{ requestType: 'SetVideoSettings', requestData: { ...b } }] }),
    });
    const now = await ctx.obs.call('GetVideoSettings');
    return { before, now, next: 'screenshot' };
  },
});

// ----- output ----------------------------------------------------------------------------------

export const outputGet = defineTool({
  name: 'output_get',
  title: 'Output settings',
  description:
    "Streaming and recording output: mode (Simple or Advanced), encoder, video and audio bitrate, preset, rate control, recording format, quality, encoder and folder, and whether the replay buffer is enabled. effectiveVideoBitrateKbps is what OBS really sends: unless the profile ignores the service's limits, OBS clamps the bitrate to the platform maximum (verified on OBS 32.2.2: 8000 on Twitch went out at 6000). Live when connected, otherwise from the profile on disk. Changes nothing.",
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    const st = await collectState(ctx);
    const note =
      st.output.effectiveVideoBitrateKbps !== null && st.output.effectiveVideoBitrateKbps !== st.output.videoBitrateKbps
        ? `OBS will stream at ${st.output.effectiveVideoBitrateKbps} kbps: the configured ${st.output.videoBitrateKbps} is above the service maximum and the profile applies service limits.`
        : undefined;
    return { source: st.source, profile: st.profile, mode: st.output.mode, [st.output.mode === 'Simple' ? 'simple' : 'advanced']: st.output, ...(note ? { note } : {}) };
  },
});

export const outputSetSimple = defineTool({
  name: 'output_set_simple',
  title: 'Set streaming output (Simple mode)',
  description:
    "Set the Simple-mode streaming output: encoder (a simpleStreamEncoders value from obs_encoders, e.g. nvenc, amd, qsv, apple_h264, x264), video bitrate, audio bitrate and encoder preset. Uses SetProfileParameter. The result says per change whether it applies at the next stream/recording start or needs an OBS restart (the encoder itself needs a restart: obs_quit then obs_launch). If OBS is in Advanced mode, pass switchToSimpleMode (also restart). Undoable.",
  input: {
    encoder: z.enum(SIMPLE_STREAM_ENCODER_IDS as [string, ...string[]]).optional(),
    videoBitrateKbps: z.number().int().min(200).max(100_000).optional(),
    audioBitrateKbps: z.number().int().min(32).max(320).optional(),
    preset: z.string().min(1).optional().describe('x264: ultrafast..fast; nvenc: p1..p7; amd/qsv: speed, balanced, quality'),
    switchToSimpleMode: z.boolean().optional(),
  },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    const r = await liveReader(ctx, [['Output', 'Mode'], ['SimpleOutput', 'StreamEncoder']]);
    const mode = r('Output', 'Mode') ?? 'Simple';
    const encoder = args.encoder ?? r('SimpleOutput', 'StreamEncoder') ?? 'x264';
    const changes: ParamChange[] = [];
    const warnings: string[] = [];
    if (args.encoder) {
      const rep = await encoderReport(ctx, false);
      if (rep.logFile && !rep.simpleStreamEncoders.includes(args.encoder)) {
        throw new ToolError('INVALID_ARGUMENT', `Encoder '${args.encoder}' is not available on this machine.`, `Available: ${rep.simpleStreamEncoders.join(', ')}.`, 'obs_encoders');
      }
      if (!rep.logFile) warnings.push('Could not confirm the encoder is available (no OBS log with an encoder list).');
      changes.push({ section: 'SimpleOutput', key: 'StreamEncoder', value: args.encoder, setting: 'encoder', appliesOn: SIMPLE_OUTPUT_APPLY['StreamEncoder']! });
    }
    if (args.videoBitrateKbps !== undefined) changes.push({ section: 'SimpleOutput', key: 'VBitrate', value: String(args.videoBitrateKbps), setting: 'videoBitrateKbps', appliesOn: 'next_start' });
    if (args.audioBitrateKbps !== undefined) changes.push({ section: 'SimpleOutput', key: 'ABitrate', value: String(args.audioBitrateKbps), setting: 'audioBitrateKbps', appliesOn: 'next_start' });
    if (args.preset !== undefined) {
      const info = SIMPLE_ENCODERS[encoder];
      if (!info?.presetKey) throw new ToolError('INVALID_ARGUMENT', `Encoder '${encoder}' has no preset in Simple mode.`, 'Drop preset.');
      if (info.presets && !info.presets.includes(args.preset)) throw new ToolError('INVALID_ARGUMENT', `Preset '${args.preset}' is not valid for ${encoder}.`, `Valid: ${info.presets.join(', ')}.`);
      changes.push({ section: 'SimpleOutput', key: info.presetKey, value: args.preset, setting: 'preset', appliesOn: SIMPLE_OUTPUT_APPLY[info.presetKey] ?? 'next_start' });
    }
    if (args.switchToSimpleMode && mode.toLowerCase() !== 'simple') changes.push({ section: 'Output', key: 'Mode', value: 'Simple', setting: 'mode', appliesOn: OTHER_APPLY['Output.Mode']! });
    else if (mode.toLowerCase() !== 'simple') warnings.push('OBS is in Advanced output mode, so these Simple settings are stored but not used. Pass switchToSimpleMode: true, or use output_set_advanced.');
    if (changes.length === 0) throw new ToolError('INVALID_ARGUMENT', 'Nothing to change.', 'Give encoder, videoBitrateKbps, audioBitrateKbps, preset or switchToSimpleMode.');
    const before = await setProfileParams(ctx, 'output_set_simple', args, changes);
    if (args.encoder) await clearClosedState(ctx);
    const report = changeReport(changes, before);
    const st = await ctx.obs.tryCall('GetStreamStatus');
    return { changes: report, restartRequired: report.some((c) => c.appliesOn === 'restart'), streamingNow: !!st?.outputActive, note: RESTART_NOTE, ...(warnings.length ? { warnings } : {}) };
  },
});

export const outputSetAdvanced = defineTool({
  name: 'output_set_advanced',
  title: 'Set encoder settings (Advanced mode)',
  description:
    "Advanced-mode encoder settings, written to the profile's streamEncoder.json or recordEncoder.json (for example { rate_control: 'CBR', bitrate: 6000, keyint_sec: 2, preset: 'p5' }), and optionally the encoder id (a libobs id from obs_encoders, e.g. obs_nvenc_h264_tex). This edits OBS config files, so OBS must be closed: call obs_quit first, then obs_launch after. Only given keys change unless replace: true. Undoable with OBS closed.",
  input: {
    target: z.enum(['stream', 'record']),
    settings: z.record(z.string(), z.unknown()),
    encoder: z.string().min(1).optional(),
    replace: z.boolean().optional(),
  },
  mutating: true,
  fileWriting: true,
  handler: async (args, ctx) => {
    return fileWrite(ctx, 'output_set_advanced', async (w) => {
      const { profile } = await resolveProfileAndCollection(ctx.paths);
      if (!profile) throw new ToolError('CONFIG_NOT_FOUND', 'Could not find the active OBS profile on disk.', 'Launch OBS once so it creates its profile.', 'obs_status');
      if (args.encoder) {
        const rep = await encoderReport(ctx, false);
        if (rep.logFile && !rep.video.some((v) => v.id === args.encoder)) throw new ToolError('INVALID_ARGUMENT', `Encoder '${args.encoder}' is not available on this machine.`, `Available: ${rep.video.map((v) => v.id).join(', ')}.`, 'obs_encoders');
      }
      const jsonFile = path.join(profile.path, args.target === 'stream' ? 'streamEncoder.json' : 'recordEncoder.json');
      const iniFile = path.join(profile.path, 'basic.ini');
      const result = await mutate(ctx, {
        tool: 'output_set_advanced',
        args,
        before: async () => ({ json: await saveForUndo(ctx, jsonFile), ini: args.encoder ? await saveForUndo(ctx, iniFile) : undefined, prev: (await readJson<Record<string, unknown>>(jsonFile)) ?? {} }),
        apply: async (b) => {
          const next = args.replace ? { ...args.settings } : { ...b.prev, ...args.settings };
          await w.writeJson(jsonFile, next);
          if (args.encoder) {
            const ini = parseIni((await readText(iniFile)) ?? '');
            iniSet(ini, 'AdvOut', args.target === 'stream' ? 'Encoder' : 'RecEncoder', args.encoder);
            await w.writeText(iniFile, serializeIni(ini));
          }
          return next;
        },
        inverse: (b) => ({ kind: 'files', files: [{ target: jsonFile, saved: b.json }, ...(b.ini !== undefined ? [{ target: iniFile, saved: b.ini }] : [])] }),
      });
      const mode = iniGet(parseIni((await readText(iniFile)) ?? ''), 'Output', 'Mode') ?? 'Simple';
      return { profile: profile.name, file: path.basename(jsonFile), settings: result, encoder: args.encoder ?? null, ...(mode !== 'Advanced' ? { warning: 'The profile is in Simple output mode, so these Advanced settings are stored but not used.' } : {}), next: 'obs_launch' };
    });
  },
});

export const recordSet = defineTool({
  name: 'record_set',
  title: 'Recording settings',
  description:
    "Where and how OBS records: path (an existing folder; set with SetRecordDirectory), format (mkv, mp4, mov, hybrid_mp4, hybrid_mov, fragmented_mp4, fragmented_mov, flv, mpegts; hybrid_mp4/mov survive crashes and play everywhere), quality (Simple mode: Stream = same as stream, Small, HQ, Lossless) and encoder (Simple: a simple id such as x264 or nvenc; Advanced: a libobs id or 'none' to reuse the stream encoder). Refused while recording. The result says per change whether it needs a restart. Undoable.",
  input: {
    path: z.string().min(1).optional(),
    format: z.enum(REC_FORMATS).optional(),
    quality: z.enum(REC_QUALITIES).optional(),
    encoder: z.string().min(1).optional(),
  },
  mutating: true,
  fileWriting: false,
  handler: async (args, ctx) => {
    await requireConnection(ctx);
    if (!args.path && !args.format && !args.quality && !args.encoder) throw new ToolError('INVALID_ARGUMENT', 'Nothing to change.', 'Give path, format, quality or encoder.');
    if (args.path && !(existsSync(args.path) && statSync(args.path).isDirectory())) throw new ToolError('INVALID_ARGUMENT', `Folder does not exist: ${args.path}`, 'Use an existing folder (ask the user where recordings should go).');
    const mode = ((await liveReader(ctx, [['Output', 'Mode']]))('Output', 'Mode') ?? 'Simple').toLowerCase() === 'advanced' ? 'Advanced' : 'Simple';
    const sec = mode === 'Simple' ? 'SimpleOutput' : 'AdvOut';
    const changes: ParamChange[] = [];
    if (args.format) changes.push({ section: sec, key: 'RecFormat2', value: args.format, setting: 'format', appliesOn: SIMPLE_OUTPUT_APPLY['RecFormat2']! });
    if (args.quality) {
      if (mode !== 'Simple') throw new ToolError('INVALID_ARGUMENT', 'Recording quality presets exist only in Simple output mode.', 'Use output_set_advanced with target record instead.');
      changes.push({ section: 'SimpleOutput', key: 'RecQuality', value: args.quality, setting: 'quality', appliesOn: SIMPLE_OUTPUT_APPLY['RecQuality']! });
    }
    if (args.encoder) {
      if (mode === 'Simple' && !SIMPLE_ENCODERS[args.encoder]) throw new ToolError('INVALID_ARGUMENT', `'${args.encoder}' is not a Simple-mode encoder id.`, `Use one of ${Object.keys(SIMPLE_ENCODERS).join(', ')}.`, 'obs_encoders');
      changes.push({ section: sec, key: 'RecEncoder', value: args.encoder, setting: 'encoder', appliesOn: 'restart' });
    }
    let extra: { request: WsRequest; inverse: WsRequest } | undefined;
    let prevDir: string | null = null;
    if (args.path) {
      prevDir = (await ctx.obs.call('GetRecordDirectory')).recordDirectory;
      extra = { request: { requestType: 'SetRecordDirectory', requestData: { recordDirectory: args.path } }, inverse: { requestType: 'SetRecordDirectory', requestData: { recordDirectory: prevDir } } };
    }
    const before = await setProfileParams(ctx, 'record_set', args, changes, extra);
    if (args.encoder) await clearClosedState(ctx);
    const report = [...(args.path ? [{ setting: 'path', parameter: 'SetRecordDirectory', from: prevDir, to: args.path, appliesOn: 'next_start' as ApplyTiming }] : []), ...changeReport(changes, before)];
    return { mode, changes: report, restartRequired: report.some((c) => c.appliesOn === 'restart'), note: RESTART_NOTE };
  },
});

export const audioSet = defineTool({
  name: 'audio_set',
  title: 'Audio sample rate and channels',
  description:
    "Set the profile's audio sample rate (44100 or 48000 Hz) and channel layout (Mono, Stereo, 2.1, 4.0, 4.1, 5.1, 7.1). OBS only reads these at startup, so this edits basic.ini and needs OBS closed: obs_quit first, then this, then obs_launch. Most setups want 48000 Hz Stereo. Undoable with OBS closed.",
  input: { sampleRate: z.union([z.literal(44100), z.literal(48000)]).optional(), channels: z.enum(CHANNEL_SETUPS).optional() },
  mutating: true,
  fileWriting: true,
  handler: async (args, ctx) => {
    if (args.sampleRate === undefined && args.channels === undefined) throw new ToolError('INVALID_ARGUMENT', 'Nothing to change.', 'Give sampleRate and/or channels.');
    return fileWrite(ctx, 'audio_set', async (w) => {
      const { profile } = await resolveProfileAndCollection(ctx.paths);
      if (!profile) throw new ToolError('CONFIG_NOT_FOUND', 'Could not find the active OBS profile on disk.', 'Launch OBS once so it creates its profile.', 'obs_status');
      const iniFile = path.join(profile.path, 'basic.ini');
      const before = await mutate(ctx, {
        tool: 'audio_set',
        args,
        before: async () => {
          const ini = parseIni((await readText(iniFile)) ?? '');
          return { saved: await saveForUndo(ctx, iniFile), sampleRate: iniGet(ini, 'Audio', 'SampleRate') ?? '48000', channels: iniGet(ini, 'Audio', 'ChannelSetup') ?? 'Stereo' };
        },
        apply: async (b) => {
          const ini = parseIni((await readText(iniFile)) ?? '');
          if (args.sampleRate !== undefined) iniSet(ini, 'Audio', 'SampleRate', String(args.sampleRate));
          if (args.channels !== undefined) iniSet(ini, 'Audio', 'ChannelSetup', args.channels);
          await w.writeText(iniFile, serializeIni(ini));
          return b;
        },
        inverse: (b) => ({ kind: 'files', files: [{ target: iniFile, saved: b.saved }] }),
      });
      return { profile: profile.name, sampleRate: { from: Number(before.sampleRate), to: args.sampleRate ?? Number(before.sampleRate) }, channels: { from: before.channels, to: args.channels ?? before.channels }, appliesOn: 'restart', next: 'obs_launch' };
    });
  },
});

// ----- stream service --------------------------------------------------------------------------

export const streamServiceGet = defineTool({
  name: 'stream_service_get',
  title: 'Streaming destination',
  description: "Where OBS streams to: service type (rtmp_common = a listed platform, rtmp_custom = custom server), platform name and server. The stream key is never shown: key is \"<set>\" or \"<empty>\". Changes nothing.",
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    if (ctx.obs.connected || (await ctx.proc.find())) {
      await requireConnection(ctx);
      const s = await ctx.obs.call('GetStreamServiceSettings');
      return { source: 'live', ...summarizeService(s.streamServiceType, s.streamServiceSettings as Record<string, unknown>, ctx.secrets) };
    }
    const { profile } = await resolveProfileAndCollection(ctx.paths);
    const svc = profile ? await readServiceJson(profile.path, ctx.secrets) : null;
    if (!svc) return { source: 'files', type: null, key: '<empty>', note: 'No stream service configured in this profile yet.' };
    return { source: 'files', ...svc };
  },
});


export const streamServiceSet = defineTool({
  name: 'stream_service_set',
  title: 'Set streaming destination',
  description:
    "Set where OBS streams to. type rtmp_common with service (exact OBS name, e.g. 'Twitch', 'YouTube - RTMPS', 'Facebook Live') and optional server (default: auto, or the service's first server); type rtmp_custom with server (an rtmp:// or rtmps:// URL). WARNING about key: passing key sends the stream key through this conversation and to the AI provider. Strongly prefer leaving it out and asking the user to paste the key into OBS themselves (Settings > Stream > Stream Key); only pass it if the user insists. The key is never echoed back. Refused while streaming. Undoable (undo restores the destination; it never brings back an old key).",
  input: {
    type: z.enum(['rtmp_common', 'rtmp_custom']),
    service: z.string().min(1).optional(),
    server: z.string().min(1).optional(),
    key: z.string().min(1).optional().describe('Discouraged: see description'),
  },
  mutating: true,
  fileWriting: false,
  annotations: { destructiveHint: false },
  handler: async (args, ctx) => {
    if (args.key) ctx.secrets.add(args.key);
    await requireConnection(ctx);
    const settings: Record<string, unknown> = {};
    if (args.type === 'rtmp_common') {
      if (!args.service) throw new ToolError('INVALID_ARGUMENT', 'rtmp_common needs service (the platform name as OBS lists it).', "For example 'Twitch' or 'YouTube - RTMPS'.");
      const list = await loadServices(ctx);
      const svc = list?.find((s) => s.name === args.service);
      if (list && !svc) {
        const close = list.filter((s) => s.name.toLowerCase().includes(args.service!.toLowerCase().split(' ')[0]!)).map((s) => s.name).slice(0, 8);
        throw new ToolError('NOT_FOUND', `OBS has no streaming service named '${args.service}'.`, close.length ? `Did you mean: ${close.join(', ')}?` : 'Use the exact name from OBS Settings > Stream > Service, or rtmp_custom with a server URL.');
      }
      settings['service'] = args.service;
      settings['server'] = args.server ?? defaultServer(svc, args.service);
    } else {
      if (!args.server) throw new ToolError('INVALID_ARGUMENT', 'rtmp_custom needs server (the rtmp:// or rtmps:// URL from the platform).', 'Ask the user for the server URL shown on their platform dashboard.');
      if (!/^(rtmps?|srt|rist):\/\//i.test(args.server)) throw new ToolError('INVALID_ARGUMENT', `Server '${args.server}' is not an rtmp://, rtmps://, srt:// or rist:// URL.`, 'Copy the server URL exactly from the platform dashboard.');
      settings['server'] = args.server;
    }
    if (args.key) settings['key'] = args.key;
    const before = await mutate(ctx, {
      tool: 'stream_service_set',
      args: { ...args, ...(args.key ? { key: '<set>' } : {}) },
      before: async () => {
        const s = await ctx.obs.call('GetStreamServiceSettings');
        return summarizeService(s.streamServiceType, s.streamServiceSettings as Record<string, unknown>, ctx.secrets);
      },
      apply: async (b) => {
        await ctx.obs.call('SetStreamServiceSettings', { streamServiceType: args.type, streamServiceSettings: settings as never });
        return b;
      },
      after: async () => {
        const s = await ctx.obs.call('GetStreamServiceSettings');
        return summarizeService(s.streamServiceType, s.streamServiceSettings as Record<string, unknown>, ctx.secrets);
      },
      inverse: (b) => ({ kind: 'stream_service', type: b.type, settings: { ...b.settings, ...(b.service ? { service: b.service } : {}), ...(b.server ? { server: b.server } : {}) } }),
    });
    const now = await ctx.obs.call('GetStreamServiceSettings');
    const summary = summarizeService(now.streamServiceType, now.streamServiceSettings as Record<string, unknown>, ctx.secrets);
    const keptOldKey = !args.key && summary.key === '<set>' && before.key === '<set>';
    return {
      before: { type: before.type, service: before.service ?? null, server: before.server ?? null, key: before.key },
      now: { type: summary.type, service: summary.service ?? null, server: summary.server ?? null, key: summary.key },
      ...(summary.key === '<empty>' ? { next: 'Ask the user to paste their stream key into OBS: Settings > Stream > Stream Key, then OK.' } : {}),
      ...(keptOldKey && (before.service !== summary.service || before.type !== summary.type) ? { warning: 'The previous stream key was kept. If the platform changed, the user must paste the new platform’s key in OBS.' } : {}),
    };
  },
});

export const settingsTools = [videoGet, videoSet, outputGet, outputSetSimple, outputSetAdvanced, recordSet, audioSet, streamServiceGet, streamServiceSet];
