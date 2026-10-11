/**
 * One picture of the OBS setup, built live over the websocket when connected or from the files
 * on disk when OBS is closed. Used by output_get, snapshot manifests, snapshot_diff and diagnose.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { DEFAULTS, SIMPLE_ENCODERS, defaultRecFormat } from '../obs/config-keys.js';
import { iniGet, readIni, readJson, readServiceJson, readWebsocketConfig, summarizeService } from '../obs/files.js';
import type { ServiceInfo } from '../obs/files.js';
import { deviceProperty } from '../obs/input-roles.js';
import { serviceLimits } from '../obs/services.js';
import { activeProfileAndCollection } from '../safety/active.js';
import type { Active } from '../safety/active.js';

export interface VideoState {
  baseWidth: number | null;
  baseHeight: number | null;
  outputWidth: number | null;
  outputHeight: number | null;
  fpsNumerator: number | null;
  fpsDenominator: number | null;
}

export interface OutputState {
  mode: 'Simple' | 'Advanced';
  /** Simple mode: the simple id (nvenc, x264...). Advanced: the libobs id (obs_x264...). */
  encoder: string | null;
  encoderLibobs: string[];
  videoBitrateKbps: number | null;
  audioBitrateKbps: number | null;
  preset: string | null;
  rateControl: string | null;
  recFormat: string | null;
  recQuality: string | null;
  recEncoder: string | null;
  recPath: string | null;
  replayBuffer: boolean;
  /** [Stream1] IgnoreRecommended (Simple) / not [AdvOut] ApplyServiceSettings (Advanced). */
  ignoreServiceLimits: boolean;
  /** What OBS will actually send: the configured bitrate clamped to the service maximum. */
  effectiveVideoBitrateKbps: number | null;
  serviceMaxVideoKbps: number | null;
}

export interface AudioState {
  sampleRate: number | null;
  channels: string | null;
}

export interface InputState {
  name: string;
  kind: string;
  scenes: string[];
  deviceId: string | null;
  settingsDigest: string;
}

export interface SetupState {
  source: 'live' | 'files';
  obsVersion: string | null;
  platform: string;
  profile: string | null;
  sceneCollection: string | null;
  video: VideoState;
  output: OutputState;
  audio: AudioState;
  streamService: ServiceInfo | null;
  scenes: string[];
  inputs: InputState[];
}

export type ValueReader = (section: string, key: string) => string | undefined;

const num = (v: string | undefined | null): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export function digest(settings: unknown): string {
  return createHash('sha256').update(stableStringify(settings ?? {})).digest('hex').slice(0, 12);
}

/** Profile values over the websocket: value, else OBS's own default, else ours. */
export async function liveReader(ctx: Ctx, keys: Array<[string, string]>): Promise<ValueReader> {
  const map = new Map<string, string | undefined>();
  await Promise.all(
    keys.map(async ([s, k]) => {
      const r = await ctx.obs.tryCall('GetProfileParameter', { parameterCategory: s, parameterName: k });
      const v = r?.parameterValue ?? r?.defaultParameterValue ?? DEFAULTS[s]?.[k];
      map.set(`${s}.${k}`, v === null ? undefined : v);
    }),
  );
  return (s, k) => map.get(`${s}.${k}`) ?? DEFAULTS[s]?.[k];
}

/** Profile values from basic.ini on disk, falling back to OBS defaults. */
export async function fileReader(profilePath: string | null): Promise<ValueReader> {
  const ini = profilePath ? await readIni(path.join(profilePath, 'basic.ini')) : null;
  return (s, k) => iniGet(ini, s, k) ?? DEFAULTS[s]?.[k];
}

export const OUTPUT_KEYS: Array<[string, string]> = [
  ['Output', 'Mode'],
  ['SimpleOutput', 'VBitrate'],
  ['SimpleOutput', 'ABitrate'],
  ['SimpleOutput', 'StreamEncoder'],
  ['SimpleOutput', 'Preset'],
  ['SimpleOutput', 'NVENCPreset2'],
  ['SimpleOutput', 'QSVPreset'],
  ['SimpleOutput', 'AMDPreset'],
  ['SimpleOutput', 'AMDAV1Preset'],
  ['SimpleOutput', 'RecQuality'],
  ['SimpleOutput', 'RecFormat2'],
  ['SimpleOutput', 'RecEncoder'],
  ['SimpleOutput', 'FilePath'],
  ['SimpleOutput', 'RecRB'],
  ['Stream1', 'IgnoreRecommended'],
  ['AdvOut', 'ApplyServiceSettings'],
  ['AdvOut', 'Encoder'],
  ['AdvOut', 'RecEncoder'],
  ['AdvOut', 'RecFilePath'],
  ['AdvOut', 'RecFormat2'],
  ['AdvOut', 'TrackIndex'],
  ['AdvOut', 'Track1Bitrate'],
  ['AdvOut', 'Track2Bitrate'],
  ['AdvOut', 'Track3Bitrate'],
  ['AdvOut', 'Track4Bitrate'],
  ['AdvOut', 'Track5Bitrate'],
  ['AdvOut', 'Track6Bitrate'],
  ['AdvOut', 'RecRB'],
  ['Audio', 'SampleRate'],
  ['Audio', 'ChannelSetup'],
  ['Video', 'BaseCX'],
  ['Video', 'BaseCY'],
  ['Video', 'OutputCX'],
  ['Video', 'OutputCY'],
  ['Video', 'FPSType'],
  ['Video', 'FPSCommon'],
  ['Video', 'FPSInt'],
  ['Video', 'FPSNum'],
  ['Video', 'FPSDen'],
];

export function videoFromReader(r: ValueReader): VideoState {
  const type = num(r('Video', 'FPSType')) ?? 0;
  let fpsNumerator: number | null;
  let fpsDenominator: number | null;
  if (type === 1) {
    fpsNumerator = num(r('Video', 'FPSInt'));
    fpsDenominator = 1;
  } else if (type === 2) {
    fpsNumerator = num(r('Video', 'FPSNum'));
    fpsDenominator = num(r('Video', 'FPSDen'));
  } else {
    const common = r('Video', 'FPSCommon') ?? '30';
    // Common values include fractional NTSC rates ("29.97", "59.94").
    const map: Record<string, [number, number]> = { '10': [10, 1], '20': [20, 1], '24 NTSC': [24000, 1001], '25 PAL': [25, 1], '29.97': [30000, 1001], '30': [30, 1], '48': [48, 1], '50 PAL': [50, 1], '59.94': [60000, 1001], '60': [60, 1] };
    const hit = map[common] ?? [Number.parseFloat(common) || 30, 1];
    [fpsNumerator, fpsDenominator] = hit;
  }
  return {
    baseWidth: num(r('Video', 'BaseCX')),
    baseHeight: num(r('Video', 'BaseCY')),
    outputWidth: num(r('Video', 'OutputCX')),
    outputHeight: num(r('Video', 'OutputCY')),
    fpsNumerator,
    fpsDenominator,
  };
}

export async function outputFromReader(r: ValueReader, profilePath: string | null, platform: string): Promise<OutputState> {
  const mode = (r('Output', 'Mode') ?? 'Simple').toLowerCase() === 'advanced' ? 'Advanced' : 'Simple';
  if (mode === 'Simple') {
    const enc = r('SimpleOutput', 'StreamEncoder') ?? 'x264';
    const info = SIMPLE_ENCODERS[enc];
    const presetKey = info?.presetKey ?? 'Preset';
    const recQuality = r('SimpleOutput', 'RecQuality') ?? 'Stream';
    return {
      mode,
      encoder: enc,
      encoderLibobs: info?.libobs ?? [],
      videoBitrateKbps: num(r('SimpleOutput', 'VBitrate')),
      audioBitrateKbps: num(r('SimpleOutput', 'ABitrate')),
      preset: info && info.presetKey === null ? null : (r('SimpleOutput', presetKey) ?? null),
      rateControl: 'CBR',
      recFormat: r('SimpleOutput', 'RecFormat2') ?? defaultRecFormat(platform),
      recQuality,
      recEncoder: recQuality === 'Stream' ? enc : (r('SimpleOutput', 'RecEncoder') ?? null),
      recPath: r('SimpleOutput', 'FilePath') ?? null,
      replayBuffer: r('SimpleOutput', 'RecRB') === 'true',
      ignoreServiceLimits: r('Stream1', 'IgnoreRecommended') === 'true',
      effectiveVideoBitrateKbps: num(r('SimpleOutput', 'VBitrate')),
      serviceMaxVideoKbps: null,
    };
  }
  const enc = r('AdvOut', 'Encoder') ?? 'obs_x264';
  const streamJson = profilePath ? await readJson<Record<string, unknown>>(path.join(profilePath, 'streamEncoder.json')) : null;
  const track = num(r('AdvOut', 'TrackIndex')) ?? 1;
  const recEnc = r('AdvOut', 'RecEncoder') ?? 'none';
  const preset = (streamJson?.['preset2'] ?? streamJson?.['preset'] ?? null) as string | null;
  return {
    mode,
    encoder: enc,
    encoderLibobs: [enc],
    videoBitrateKbps: num(streamJson?.['bitrate'] === undefined ? undefined : String(streamJson['bitrate'])) ?? (streamJson ? null : 2500),
    audioBitrateKbps: num(r('AdvOut', `Track${track}Bitrate`)),
    preset,
    rateControl: (streamJson?.['rate_control'] as string | undefined) ?? 'CBR',
    recFormat: r('AdvOut', 'RecFormat2') ?? defaultRecFormat(platform),
    recQuality: null,
    recEncoder: recEnc === 'none' ? enc : recEnc,
    recPath: r('AdvOut', 'RecFilePath') ?? null,
    replayBuffer: r('AdvOut', 'RecRB') === 'true',
    ignoreServiceLimits: r('AdvOut', 'ApplyServiceSettings') === 'false' || r('Stream1', 'IgnoreRecommended') === 'true',
    effectiveVideoBitrateKbps: null,
    serviceMaxVideoKbps: null,
  };
}

/** Fill in what OBS will really send once it applies the service's limits. */
export async function applyServiceLimits(ctx: Ctx, output: OutputState, svc: ServiceInfo | null): Promise<void> {
  const lim = await serviceLimits(ctx, svc);
  output.serviceMaxVideoKbps = lim.maxVideoKbps;
  const configured = output.videoBitrateKbps;
  output.effectiveVideoBitrateKbps = configured === null ? null : !output.ignoreServiceLimits && lim.maxVideoKbps !== null ? Math.min(configured, lim.maxVideoKbps) : configured;
}

export function audioFromReader(r: ValueReader): AudioState {
  return { sampleRate: num(r('Audio', 'SampleRate')), channels: r('Audio', 'ChannelSetup') ?? null };
}

interface SceneCollectionFile {
  name?: string;
  sources?: Array<{ name: string; id: string; versioned_id?: string; settings?: Record<string, unknown> }>;
  scene_order?: Array<{ name: string }>;
  [key: string]: unknown;
}

const SPECIAL_AUDIO_KEYS = ['DesktopAudioDevice1', 'DesktopAudioDevice2', 'AuxAudioDevice1', 'AuxAudioDevice2', 'AuxAudioDevice3', 'AuxAudioDevice4'];

/** Scenes and inputs from a scene collection json on disk. */
export function scenesAndInputsFromCollection(json: SceneCollectionFile | null): { scenes: string[]; inputs: InputState[]; items: Array<{ scene: string; source: string }>; inputSettings: Record<string, Record<string, unknown>> } {
  const scenes: string[] = [];
  const inputs: InputState[] = [];
  const items: Array<{ scene: string; source: string }> = [];
  const inputSettings: Record<string, Record<string, unknown>> = {};
  if (!json) return { scenes, inputs, items, inputSettings };
  const sources = json.sources ?? [];
  const sceneSources = sources.filter((s) => s.id === 'scene');
  const order = json.scene_order?.map((s) => s.name) ?? sceneSources.map((s) => s.name);
  scenes.push(...order.filter((n) => sceneSources.some((s) => s.name === n)));
  for (const s of sceneSources) {
    for (const it of ((s.settings?.['items'] as Array<{ name: string }> | undefined) ?? [])) items.push({ scene: s.name, source: it.name });
  }
  const add = (name: string, kind: string, settings: Record<string, unknown> | undefined) => {
    const prop = deviceProperty(kind);
    const dev = prop ? settings?.[prop] : undefined;
    inputSettings[name] = settings ?? {};
    inputs.push({
      name,
      kind,
      scenes: items.filter((i) => i.source === name).map((i) => i.scene),
      deviceId: dev === undefined || dev === null ? null : String(dev),
      settingsDigest: digest(settings ?? {}),
    });
  };
  for (const s of sources) {
    if (s.id === 'scene' || s.id === 'group') continue;
    add(s.name, s.versioned_id ?? s.id, s.settings);
  }
  for (const k of SPECIAL_AUDIO_KEYS) {
    const v = json[k] as { name?: string; id?: string; versioned_id?: string; settings?: Record<string, unknown> } | undefined;
    if (v?.name && v.id) add(v.name, v.versioned_id ?? v.id, v.settings);
  }
  return { scenes, inputs, items, inputSettings };
}

/** Live scenes and inputs (with settings digests and device ids). */
export async function liveScenesAndInputs(ctx: Ctx): Promise<{ scenes: string[]; inputs: InputState[]; inputSettings: Record<string, Record<string, unknown>> }> {
  const sl = await ctx.obs.call('GetSceneList');
  // GetSceneList returns scenes in reverse UI order (sceneIndex 0 = bottom).
  const scenes = [...sl.scenes].sort((a, b) => Number(b['sceneIndex']) - Number(a['sceneIndex'])).map((s) => String(s['sceneName']));
  const membership = new Map<string, string[]>();
  await Promise.all(
    scenes.map(async (scene) => {
      const r = await ctx.obs.tryCall('GetSceneItemList', { sceneName: scene });
      for (const it of r?.sceneItems ?? []) {
        const n = String(it['sourceName']);
        membership.set(n, [...(membership.get(n) ?? []), scene]);
      }
    }),
  );
  const { inputs: list } = await ctx.obs.call('GetInputList');
  const inputSettings: Record<string, Record<string, unknown>> = {};
  const inputs = await Promise.all(
    list.map(async (i) => {
      const name = String(i['inputName']);
      const kind = String(i['inputKind']);
      const s = await ctx.obs.tryCall('GetInputSettings', { inputName: name });
      const settings = (s?.inputSettings ?? {}) as Record<string, unknown>;
      inputSettings[name] = settings;
      const prop = deviceProperty(kind);
      const dev = prop ? settings[prop] : undefined;
      return {
        name,
        kind,
        scenes: (membership.get(name) ?? []).sort((a, b) => scenes.indexOf(a) - scenes.indexOf(b)),
        deviceId: dev === undefined || dev === null ? null : String(dev),
        settingsDigest: digest(settings),
      };
    }),
  );
  return { scenes: scenes.filter((s) => !s.startsWith('__ctrlstream')), inputs: inputs.filter((i) => !i.name.startsWith('__ctrlstream')), inputSettings };
}

export interface CollectOptions {
  /** Force reading from disk even when connected. */
  files?: boolean;
}

export async function collectState(ctx: Ctx, opts: CollectOptions = {}): Promise<SetupState & { active: Active; inputSettings: Record<string, Record<string, unknown>> }> {
  // OBS running but not yet connected: connect, so live values win over a possibly stale file.
  if (!opts.files && !ctx.obs.connected && (await ctx.proc.find())) await ctx.obs.connect().catch(() => undefined);
  const live = ctx.obs.connected && !opts.files;
  const active = await activeProfileAndCollection(ctx);
  const profilePath = active.profile?.path ?? null;
  if (live) {
    const r = await liveReader(ctx, OUTPUT_KEYS);
    const [v, svc, ver, si] = await Promise.all([
      ctx.obs.tryCall('GetVideoSettings'),
      ctx.obs.tryCall('GetStreamServiceSettings'),
      ctx.obs.version().catch(() => null),
      liveScenesAndInputs(ctx),
    ]);
    const output = await outputFromReader(r, profilePath, ctx.paths.platform);
    const rd = await ctx.obs.tryCall('GetRecordDirectory');
    if (rd?.recordDirectory) output.recPath = rd.recordDirectory;
    const svcInfo = svc ? summarizeService(svc.streamServiceType, svc.streamServiceSettings as Record<string, unknown>, ctx.secrets) : null;
    await applyServiceLimits(ctx, output, svcInfo);
    return {
      source: 'live',
      obsVersion: ver?.obsVersion ?? null,
      platform: ctx.paths.platform,
      profile: active.profileName,
      sceneCollection: active.collectionName,
      video: v
        ? { baseWidth: v.baseWidth, baseHeight: v.baseHeight, outputWidth: v.outputWidth, outputHeight: v.outputHeight, fpsNumerator: v.fpsNumerator, fpsDenominator: v.fpsDenominator }
        : videoFromReader(r),
      output,
      audio: audioFromReader(r),
      streamService: svcInfo,
      scenes: si.scenes,
      inputs: si.inputs,
      active,
      inputSettings: si.inputSettings,
    };
  }
  const r = await fileReader(profilePath);
  if (!(await ctx.proc.find())) {
    const { recordClosedState } = await import('../diagnose/closed-state.js');
    await recordClosedState(ctx).catch(() => null);
  }
  const json = active.collection ? await readJson<SceneCollectionFile>(active.collection.path) : null;
  const si = scenesAndInputsFromCollection(json);
  await readWebsocketConfig(ctx.paths, ctx.secrets); // registers the password for scrubbing
  const fileSvc = profilePath ? await readServiceJson(profilePath, ctx.secrets) : null;
  const fileOutput = await outputFromReader(r, profilePath, ctx.paths.platform);
  await applyServiceLimits(ctx, fileOutput, fileSvc);
  return {
    source: 'files',
    obsVersion: null,
    platform: ctx.paths.platform,
    profile: active.profileName,
    sceneCollection: active.collectionName,
    video: videoFromReader(r),
    output: fileOutput,
    audio: audioFromReader(r),
    streamService: fileSvc,
    scenes: si.scenes,
    inputs: si.inputs,
    active,
    inputSettings: si.inputSettings,
  };
}
