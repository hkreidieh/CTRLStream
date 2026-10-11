/**
 * In-memory OBS behind the mock websocket server. Request names, fields and response shapes follow
 * obs-websocket 5.7.4 (protocol.md) and what the real OBS 32.2.2 on macOS returned on 2026-10-11
 * (see the real-response notes next to each handler). Not a full OBS: just enough behaviour for
 * every ctrlstream tool, including failure paths.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { iniSet, parseIni, serializeIni } from '../../src/obs/files.js';

export interface Status {
  result: boolean;
  code: number;
  comment?: string;
}

export interface Reply {
  status: Status;
  data?: Record<string, unknown>;
}

const ok = (data?: Record<string, unknown>): Reply => ({ status: { result: true, code: 100 }, ...(data ? { data } : {}) });
const fail = (code: number, comment: string): Reply => ({ status: { result: false, code, comment } });

/** Placeholder base64 image bytes (only passed through, never decoded). */
export const TINY_JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

/** Real GetInputKindList(unversioned:false) from OBS 32.2.2 on macOS. */
export const MAC_INPUT_KINDS = ['image_source', 'color_source_v3', 'slideshow_v2', 'av_capture_input_v2', 'macos-avcapture', 'macos-avcapture-fast', 'screen_capture', 'sck_audio_capture', 'display_capture', 'window_capture', 'coreaudio_input_capture', 'coreaudio_output_capture', 'syphon-input', 'browser_source', 'ffmpeg_source', 'text_ft2_source_v2', 'vlc_source'];
export const WIN_INPUT_KINDS = ['image_source', 'color_source_v3', 'slideshow_v2', 'browser_source', 'ffmpeg_source', 'text_gdiplus_v3', 'monitor_capture', 'window_capture', 'game_capture', 'dshow_input', 'wasapi_input_capture', 'wasapi_output_capture', 'wasapi_process_output_capture'];
/** Real GetSourceFilterKindList from OBS 32.2.2 on macOS. */
export const FILTER_KINDS = ['mask_filter', 'mask_filter_v2', 'crop_filter', 'gain_filter', 'basic_eq_filter', 'hdr_tonemap_filter', 'sdr_on_hdr_filter', 'color_filter', 'color_filter_v2', 'scale_filter', 'scroll_filter', 'gpu_delay', 'color_key_filter', 'color_key_filter_v2', 'clut_filter', 'sharpness_filter', 'sharpness_filter_v2', 'chroma_key_filter', 'chroma_key_filter_v2', 'async_delay_filter', 'noise_suppress_filter', 'noise_suppress_filter_v2', 'invert_polarity_filter', 'noise_gate_filter', 'compressor_filter', 'limiter_filter', 'expander_filter', 'upward_compressor_filter', 'luma_key_filter', 'luma_key_filter_v2', 'vst_filter'];

/** Real defaults returned by GetProfileParameter on a fresh OBS 32.2.2 macOS profile. */
export const PROFILE_DEFAULTS: Record<string, string> = {
  'Output.Mode': 'Simple',
  'SimpleOutput.StreamEncoder': 'x264',
  'SimpleOutput.RecEncoder': 'x264',
  'SimpleOutput.RecFormat2': 'hybrid_mov',
  'SimpleOutput.RecQuality': 'Stream',
  'SimpleOutput.VBitrate': '6000',
  'SimpleOutput.ABitrate': '160',
  'SimpleOutput.FilePath': '/Users/streamer/Movies',
  'SimpleOutput.Preset': 'veryfast',
  'SimpleOutput.NVENCPreset2': 'p5',
  'SimpleOutput.RecRB': 'false',
  'Stream1.IgnoreRecommended': 'false',
  'Audio.SampleRate': '48000',
  'Audio.ChannelSetup': 'Stereo',
  'Video.BaseCX': '1920',
  'Video.BaseCY': '1080',
  'Video.OutputCX': '1280',
  'Video.OutputCY': '720',
  'Video.FPSType': '0',
  'Video.FPSCommon': '30',
  'AdvOut.Encoder': 'obs_x264',
  'AdvOut.RecEncoder': 'none',
  'AdvOut.TrackIndex': '1',
  'AdvOut.Track1Bitrate': '160',
  'AdvOut.RecType': 'Standard',
  'AdvOut.ApplyServiceSettings': 'true',
  'AdvOut.RecFilePath': '/Users/streamer/Movies',
};

export interface Transform {
  positionX: number;
  positionY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  alignment: number;
  boundsType: string;
  boundsAlignment: number;
  boundsWidth: number;
  boundsHeight: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
  cropToBounds: boolean;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
}

interface Item {
  id: number;
  source: string;
  enabled: boolean;
  locked: boolean;
  transform: Transform;
}

interface Scene {
  name: string;
  uuid: string;
  items: Item[];
  nextId: number;
}

interface Filter {
  name: string;
  kind: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

interface Input {
  name: string;
  uuid: string;
  kind: string;
  settings: Record<string, unknown>;
  volumeDb: number;
  muted: boolean;
  monitorType: string;
  syncOffset: number;
  filters: Filter[];
  width: number;
  height: number;
}

const AUDIO_KINDS = new Set(['coreaudio_input_capture', 'coreaudio_output_capture', 'wasapi_input_capture', 'wasapi_output_capture', 'sck_audio_capture', 'ffmpeg_source', 'browser_source', 'macos-avcapture', 'dshow_input']);
const SIZES: Record<string, [number, number]> = { color_source_v3: [1920, 1080], 'macos-avcapture': [1920, 1080], dshow_input: [1280, 720], image_source: [800, 600], browser_source: [800, 600], text_ft2_source_v2: [300, 60] };

let uuidCounter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;

export function defaultTransform(w: number, h: number): Transform {
  return { positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5, boundsType: 'OBS_BOUNDS_NONE', boundsAlignment: 0, boundsWidth: 0, boundsHeight: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, cropToBounds: false, sourceWidth: w, sourceHeight: h, width: w, height: h };
}

export interface ModelOptions {
  platform?: 'macos' | 'windows';
  /** basic.ini the model keeps in step on SetProfileParameter, like OBS's config_save. */
  profileIniPath?: string;
  /** Scene collection file the model rewrites on structural changes (not on settings changes). */
  collectionPath?: string;
  recordDir?: string;
}

export class ObsModel {
  version = { obsVersion: '32.2.2', obsWebSocketVersion: '5.7.4', rpcVersion: 1, platform: 'macos', platformDescription: 'macOS Tahoe (26.2)', supportedImageFormats: ['jpeg', 'jpg', 'png'] };
  inputKinds: string[];
  scenes: Scene[] = [];
  inputs = new Map<string, Input>();
  program = 'Scene';
  profiles = { current: 'Untitled', list: ['Untitled'] };
  collections = { current: 'Untitled', list: ['Untitled'] };
  params = new Map<string, string>();
  video = { baseWidth: 1920, baseHeight: 1080, outputWidth: 1280, outputHeight: 720, fpsNumerator: 30, fpsDenominator: 1 };
  service: { type: string; settings: Record<string, unknown> } = { type: 'rtmp_common', settings: { service: 'Twitch', server: 'auto', key: 'live_123456789_DUMMYSTREAMKEYdoNotLeak42' } };
  stream = { active: false, reconnecting: false, congestion: 0, bytes: 0, duration: 0, skipped: 0, total: 0 };
  record = { active: false, paused: false, bytes: 0, duration: 0, dir: '/Users/streamer/Movies', lastPath: '' };
  replayBuffer: { available: boolean; active: boolean } = { available: false, active: false };
  virtualCam = false;
  stats = { cpuUsage: 3.2, memoryUsage: 240, availableDiskSpace: 120_000, activeFps: 30, averageFrameRenderTime: 1.6, renderSkippedFrames: 0, renderTotalFrames: 1000, outputSkippedFrames: 0, outputTotalFrames: 1000 };
  /** Frames added per GetStats call while an output runs; skips per call for overload tests. */
  tick = { frames: 30, renderSkips: 0, outputSkips: 0 };
  monitors = [{ monitorHeight: 1169, monitorIndex: 0, monitorName: 'Built-in Retina Display(0)', monitorPositionX: 0, monitorPositionY: 0, monitorWidth: 1800 }];
  /** List property items per input kind and property (real shapes: itemName, itemValue, itemEnabled). */
  listItems: Record<string, Record<string, Array<{ itemName: string; itemValue: string | number; itemEnabled: boolean }>>>;
  /** Kinds whose list query makes OBS crash (real: screen_capture on macOS without permission). */
  crashOnListKinds = new Set(['screen_capture']);
  failures = new Map<string, { code: number; comment: string; times: number }>();
  notReadyRemaining = 0;
  requests: Array<{ requestType: string; requestData?: Record<string, unknown> }> = [];
  crashed = false;
  /** Screen captures that have been in the program scene (macOS SCK renders black before that). */
  everActive = new Set<string>();
  /** Force a non-black picture for these screen captures even if never active. */
  forcePicture = new Set<string>();
  opts: ModelOptions;

  constructor(opts: ModelOptions = {}) {
    this.opts = opts;
    if (opts.recordDir) this.record.dir = opts.recordDir;
    const mac = (opts.platform ?? 'macos') === 'macos';
    this.version.platform = mac ? 'macos' : 'windows';
    this.inputKinds = mac ? MAC_INPUT_KINDS : WIN_INPUT_KINDS;
    this.listItems = {
      'macos-avcapture': { device: [{ itemName: '', itemValue: '', itemEnabled: true }, { itemName: 'FaceTime HD Camera', itemValue: 'cam-facetime-uuid', itemEnabled: true }, { itemName: 'Elgato Facecam', itemValue: 'cam-elgato-uuid', itemEnabled: true }] },
      coreaudio_input_capture: { device_id: [{ itemName: 'Default', itemValue: 'default', itemEnabled: true }, { itemName: 'MacBook Pro Microphone', itemValue: 'BuiltInMicrophoneDevice', itemEnabled: true }] },
      coreaudio_output_capture: { device_id: [{ itemName: 'Default', itemValue: 'default', itemEnabled: true }, { itemName: 'BlackHole 2ch', itemValue: 'BlackHole2ch_UID', itemEnabled: true }] },
      dshow_input: { video_device_id: [{ itemName: 'Logitech C920', itemValue: 'Logitech C920:\\\\?\\usb#vid_046d', itemEnabled: true }] },
      wasapi_input_capture: { device_id: [{ itemName: 'Default', itemValue: 'default', itemEnabled: true }] },
      wasapi_output_capture: { device_id: [{ itemName: 'Default', itemValue: 'default', itemEnabled: true }] },
      monitor_capture: { monitor_id: [{ itemName: 'Display 1: 2560x1440 @ 0,0 (Primary Monitor)', itemValue: '\\\\?\\DISPLAY#1', itemEnabled: true }] },
    };
    this.addScene('Scene');
    this.addScene('Live');
    this.addInput('Live', 'Background', 'color_source_v3', { color: 4281545523, width: 1920, height: 1080 });
    this.addInput('Live', 'Webcam', mac ? 'macos-avcapture' : 'dshow_input', mac ? { device: 'cam-facetime-uuid' } : { video_device_id: 'Logitech C920:\\\\?\\usb#vid_046d' });
    this.addInput(null, 'Mic/Aux', mac ? 'coreaudio_input_capture' : 'wasapi_input_capture', { device_id: 'default' });
  }

  // ---- helpers ----------------------------------------------------------------------------

  addScene(name: string): Scene {
    const s = { name, uuid: uuid(), items: [], nextId: 1 };
    this.scenes.push(s);
    return s;
  }

  addInput(scene: string | null, name: string, kind: string, settings: Record<string, unknown>, enabled = true): number | null {
    const [w, h] = SIZES[kind] ?? [0, 0];
    this.inputs.set(name, { name, uuid: uuid(), kind, settings: { ...settings }, volumeDb: 0, muted: false, monitorType: 'OBS_MONITORING_TYPE_NONE', syncOffset: 0, filters: [], width: w, height: h });
    if (!scene) return null;
    return this.addItem(scene, name, enabled);
  }

  addItem(sceneName: string, source: string, enabled = true): number {
    const s = this.scene(sceneName)!;
    const inp = this.inputs.get(source);
    const id = s.nextId++;
    s.items.push({ id, source, enabled, locked: false, transform: defaultTransform(inp?.width ?? 0, inp?.height ?? 0) });
    return id;
  }

  scene(name: string | undefined): Scene | undefined {
    return this.scenes.find((s) => s.name === name);
  }

  param(cat: string, name: string): { value: string | null; def: string | null } {
    const key = `${cat}.${name}`;
    const def = PROFILE_DEFAULTS[key] ?? null;
    return { value: this.params.get(key) ?? def, def };
  }

  failNext(requestType: string, code: number, comment = 'injected failure', times = 1): void {
    this.failures.set(requestType, { code, comment, times });
  }

  /** Mirror of OBS saving the collection on structural changes (measured: ~250 ms, not on settings changes). */
  saveCollection(): void {
    const p = this.opts.collectionPath;
    if (!p) return;
    const sources: unknown[] = [];
    for (const i of this.inputs.values()) sources.push({ name: i.name, uuid: i.uuid, id: i.kind.replace(/_v\d+$/, ''), versioned_id: i.kind, settings: i.settings, filters: i.filters.map((f) => ({ name: f.name, id: f.kind, settings: f.settings, enabled: f.enabled })) });
    for (const s of this.scenes) sources.push({ name: s.name, uuid: s.uuid, id: 'scene', versioned_id: 'scene', settings: { id_counter: s.nextId - 1, custom_size: false, items: s.items.map((it) => ({ name: it.source, visible: it.enabled, locked: it.locked, id: it.id })) } });
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ name: this.collections.current, sources, scene_order: this.scenes.map((s) => ({ name: s.name })), current_scene: this.program, current_program_scene: this.program }, null, 4));
  }

  private writeIni(cat: string, name: string, value: string | null): void {
    const p = this.opts.profileIniPath;
    if (!p) return;
    const doc = parseIni(existsSync(p) ? readFileSync(p, 'utf8') : '');
    iniSet(doc, cat, name, value ?? undefined);
    writeFileSync(p, serializeIni(doc));
  }

  private bump(): void {
    const active = this.stream.active || this.record.active;
    this.stats.renderTotalFrames += this.tick.frames;
    this.stats.renderSkippedFrames += this.tick.renderSkips;
    if (active) {
      this.stats.outputTotalFrames += this.tick.frames;
      this.stats.outputSkippedFrames += this.tick.outputSkips;
    }
    if (this.stream.active) {
      this.stream.total += this.tick.frames;
      this.stream.duration += 1000;
      this.stream.bytes += 100_000;
    }
    if (this.record.active) {
      this.record.duration += 1000;
      this.record.bytes += 100_000;
    }
  }

  // ---- request dispatch -------------------------------------------------------------------

  handle(requestType: string, d: Record<string, unknown> = {}): Reply {
    this.requests.push({ requestType, ...(Object.keys(d).length ? { requestData: d } : {}) });
    if (this.notReadyRemaining > 0) {
      this.notReadyRemaining--;
      return fail(207, 'OBS is not ready to perform the request.');
    }
    const f = this.failures.get(requestType);
    if (f) {
      if (--f.times <= 0) this.failures.delete(requestType);
      return fail(f.code, f.comment);
    }
    const h = (this as unknown as Record<string, (d: Record<string, unknown>) => Reply>)[`r${requestType}`];
    if (!h) return fail(204, 'Your request type is not valid.');
    return h.call(this, d);
  }

  private input(d: Record<string, unknown>): Input | Reply {
    const i = this.inputs.get(String(d['inputName'] ?? d['sourceName']));
    return i ?? fail(600, `No source was found by the name of \`${String(d['inputName'] ?? d['sourceName'])}\`.`);
  }

  private sceneOr(d: Record<string, unknown>): Scene | Reply {
    const s = this.scene(String(d['sceneName']));
    return s ?? fail(600, `No source was found by the name of \`${String(d['sceneName'])}\`.`);
  }

  private item(s: Scene, d: Record<string, unknown>): Item | Reply {
    const it = s.items.find((i) => i.id === d['sceneItemId']);
    return it ?? fail(600, 'No scene items were found in the specified scene by that ID.');
  }

  rGetVersion() {
    return ok({ ...this.version, availableRequests: Object.getOwnPropertyNames(ObsModel.prototype).filter((n) => n.startsWith('r') && n[1] === n[1]!.toUpperCase()).map((n) => n.slice(1)) });
  }
  rGetStats() {
    this.bump();
    return ok({ ...this.stats, webSocketSessionIncomingMessages: this.requests.length, webSocketSessionOutgoingMessages: this.requests.length });
  }
  rGetInputKindList(d: Record<string, unknown>) {
    return ok({ inputKinds: d['unversioned'] ? this.inputKinds.map((k) => k.replace(/_v\d+$/, '')) : this.inputKinds });
  }
  rGetSourceFilterKindList() {
    return ok({ sourceFilterKinds: FILTER_KINDS });
  }
  rGetMonitorList() {
    return ok({ monitors: this.monitors });
  }
  rGetProfileList() {
    return ok({ currentProfileName: this.profiles.current, profiles: this.profiles.list });
  }
  rGetSceneCollectionList() {
    return ok({ currentSceneCollectionName: this.collections.current, sceneCollections: this.collections.list });
  }
  rSetCurrentProfile(d: Record<string, unknown>) {
    if (!this.profiles.list.includes(String(d['profileName']))) return fail(600, 'No profile by that name.');
    this.profiles.current = String(d['profileName']);
    return ok();
  }
  rGetProfileParameter(d: Record<string, unknown>) {
    const p = this.param(String(d['parameterCategory']), String(d['parameterName']));
    return ok({ parameterValue: p.value, defaultParameterValue: p.def });
  }
  rSetProfileParameter(d: Record<string, unknown>) {
    const key = `${d['parameterCategory']}.${d['parameterName']}`;
    if (d['parameterValue'] === null || d['parameterValue'] === undefined) {
      if (!this.params.has(key)) return fail(600, 'There are no existing instances of that profile parameter.');
      this.params.delete(key);
    } else if (typeof d['parameterValue'] === 'string') this.params.set(key, d['parameterValue']);
    else return fail(401, 'The field `parameterValue` must be a string.');
    this.writeIni(String(d['parameterCategory']), String(d['parameterName']), (d['parameterValue'] as string | null) ?? null);
    return ok();
  }
  rGetVideoSettings() {
    return ok({ ...this.video });
  }
  rSetVideoSettings(d: Record<string, unknown>) {
    if (this.stream.active || this.record.active) return fail(500, 'Video settings cannot be changed while an output is active.');
    let changed = false;
    for (const [a, b] of [['baseWidth', 'baseHeight'], ['outputWidth', 'outputHeight'], ['fpsNumerator', 'fpsDenominator']] as const) {
      if (d[a] !== undefined && d[b] !== undefined) {
        (this.video as Record<string, number>)[a] = Number(d[a]);
        (this.video as Record<string, number>)[b] = Number(d[b]);
        changed = true;
      }
    }
    return changed ? ok() : fail(300, 'You must specify at least one video-changing pair.');
  }
  rGetStreamServiceSettings() {
    return ok({ streamServiceType: this.service.type, streamServiceSettings: { ...this.service.settings } });
  }
  rSetStreamServiceSettings(d: Record<string, unknown>) {
    if (this.stream.active) return fail(500, 'You cannot change stream service settings while streaming.');
    const type = String(d['streamServiceType']);
    const settings = (d['streamServiceSettings'] ?? {}) as Record<string, unknown>;
    // Same type merges, a new type replaces (RequestHandler_Config.cpp).
    this.service = type === this.service.type ? { type, settings: { ...this.service.settings, ...settings } } : { type, settings: { ...settings } };
    return ok();
  }
  rGetRecordDirectory() {
    return ok({ recordDirectory: this.record.dir });
  }
  rSetRecordDirectory(d: Record<string, unknown>) {
    if (this.record.active) return fail(500, '');
    this.record.dir = String(d['recordDirectory']);
    this.params.set('SimpleOutput.FilePath', this.record.dir);
    this.params.set('AdvOut.RecFilePath', this.record.dir);
    return ok();
  }
  rGetSceneList() {
    return ok({
      currentProgramSceneName: this.program,
      currentProgramSceneUuid: this.scene(this.program)?.uuid ?? null,
      currentPreviewSceneName: null,
      currentPreviewSceneUuid: null,
      // Real OBS: sceneIndex counts from the bottom of the UI list.
      scenes: this.scenes.map((s, i) => ({ sceneIndex: this.scenes.length - i - 1, sceneName: s.name, sceneUuid: s.uuid })).reverse(),
    });
  }
  rGetCurrentProgramScene() {
    return ok({ sceneName: this.program, sceneUuid: this.scene(this.program)?.uuid, currentProgramSceneName: this.program, currentProgramSceneUuid: this.scene(this.program)?.uuid });
  }
  rSetCurrentProgramScene(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    this.program = s.name;
    for (const it of s.items) if (it.enabled) this.everActive.add(it.source);
    return ok();
  }
  rCreateScene(d: Record<string, unknown>) {
    const name = String(d['sceneName']);
    if (this.scene(name) || this.inputs.has(name)) return fail(601, 'A source already exists by that scene name.');
    const s = this.addScene(name);
    this.saveCollection();
    return ok({ sceneUuid: s.uuid });
  }
  rRemoveScene(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    if (this.scenes.length === 1) return fail(603, 'You cannot remove the last scene in the collection.');
    this.scenes = this.scenes.filter((x) => x !== s);
    if (this.program === s.name) this.program = this.scenes[0]!.name;
    // Sources referenced only by this scene go away with it.
    for (const it of s.items) {
      if (!this.scenes.some((x) => x.items.some((i) => i.source === it.source)) && this.inputs.get(it.source)?.kind !== 'coreaudio_input_capture') this.inputs.delete(it.source);
    }
    this.saveCollection();
    return ok();
  }
  rGetSceneItemList(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    return ok({
      sceneItems: s.items.map((it, idx) => {
        const inp = this.inputs.get(it.source);
        return { inputKind: inp?.kind ?? null, isGroup: inp ? null : false, sceneItemBlendMode: 'OBS_BLEND_NORMAL', sceneItemEnabled: it.enabled, sceneItemId: it.id, sceneItemIndex: idx, sceneItemLocked: it.locked, sceneItemTransform: { ...it.transform }, sourceName: it.source, sourceType: inp ? 'OBS_SOURCE_TYPE_INPUT' : 'OBS_SOURCE_TYPE_SCENE', sourceUuid: inp?.uuid ?? null };
      }),
    });
  }
  rCreateSceneItem(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    if (!this.inputs.has(String(d['sourceName'])) && !this.scene(String(d['sourceName']))) return fail(600, 'No source was found by the name.');
    const id = this.addItem(s.name, String(d['sourceName']), d['sceneItemEnabled'] !== false);
    this.saveCollection();
    return ok({ sceneItemId: id });
  }
  rRemoveSceneItem(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    const it = this.item(s, d);
    if ('status' in it) return it;
    s.items = s.items.filter((x) => x !== it);
    return ok();
  }
  rGetSceneItemTransform(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    const it = this.item(s, d);
    if ('status' in it) return it;
    return ok({ sceneItemTransform: { ...it.transform } });
  }
  rSetSceneItemTransform(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    const it = this.item(s, d);
    if ('status' in it) return it;
    const t = (d['sceneItemTransform'] ?? {}) as Record<string, unknown>;
    for (const k of ['boundsWidth', 'boundsHeight']) if (t[k] !== undefined && Number(t[k]) < 1) return fail(402, `The field \`${k}\` is below the minimum of \`1\``);
    Object.assign(it.transform, t);
    it.transform.width = it.transform.scaleX * it.transform.sourceWidth;
    it.transform.height = it.transform.scaleY * it.transform.sourceHeight;
    return ok();
  }
  rGetSceneItemEnabled(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    const it = this.item(s, d);
    if ('status' in it) return it;
    return ok({ sceneItemEnabled: it.enabled });
  }
  rSetSceneItemEnabled(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    const it = this.item(s, d);
    if ('status' in it) return it;
    it.enabled = !!d['sceneItemEnabled'];
    return ok();
  }
  rGetSceneItemIndex(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    const it = this.item(s, d);
    if ('status' in it) return it;
    return ok({ sceneItemIndex: s.items.indexOf(it) });
  }
  rSetSceneItemIndex(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    const it = this.item(s, d);
    if ('status' in it) return it;
    s.items = s.items.filter((x) => x !== it);
    s.items.splice(Number(d['sceneItemIndex']), 0, it);
    return ok();
  }
  rGetInputList(d: Record<string, unknown>) {
    return ok({
      inputs: [...this.inputs.values()]
        .filter((i) => !d['inputKind'] || i.kind === d['inputKind'])
        .map((i) => ({ inputKind: i.kind, inputKindCaps: AUDIO_KINDS.has(i.kind) ? 130 : 1, inputName: i.name, inputUuid: i.uuid, unversionedInputKind: i.kind.replace(/_v\d+$/, '') })),
    });
  }
  rCreateInput(d: Record<string, unknown>) {
    const s = this.sceneOr(d);
    if ('status' in s) return s;
    const name = String(d['inputName']);
    if (this.inputs.has(name) || this.scene(name)) return fail(601, 'A source already exists by that input name.');
    if (!this.inputKinds.includes(String(d['inputKind']))) return fail(605, 'Your specified input kind is not supported by OBS. Check that your specified kind is properly versioned and that any necessary plugins are loaded.');
    const id = this.addInput(s.name, name, String(d['inputKind']), (d['inputSettings'] ?? {}) as Record<string, unknown>, d['sceneItemEnabled'] !== false);
    this.saveCollection();
    return ok({ inputUuid: this.inputs.get(name)!.uuid, sceneItemId: id });
  }
  rRemoveInput(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    this.inputs.delete(i.name);
    for (const s of this.scenes) s.items = s.items.filter((it) => it.source !== i.name);
    this.saveCollection();
    return ok();
  }
  rGetInputSettings(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    return ok({ inputSettings: { ...i.settings }, inputKind: i.kind });
  }
  rSetInputSettings(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    const s = (d['inputSettings'] ?? {}) as Record<string, unknown>;
    i.settings = d['overlay'] === false ? { ...s } : { ...i.settings, ...s };
    // Real OBS does not save the collection for this (measured on 32.2.2).
    return ok();
  }
  rGetInputDefaultSettings(d: Record<string, unknown>) {
    const defaults: Record<string, Record<string, unknown>> = {
      'macos-avcapture': { device: '', use_preset: true, preset: 'AVCaptureSessionPreset1280x720', enable_audio: false },
      coreaudio_input_capture: { device_id: 'default', enable_downmix: true },
      color_source_v3: { color: 4291940817, width: 0, height: 0 },
      screen_capture: { type: 0, show_cursor: true, display_uuid: null },
    };
    return ok({ defaultInputSettings: defaults[String(d['inputKind'])] ?? {} });
  }
  rGetInputPropertiesListPropertyItems(d: Record<string, unknown>): Reply {
    const i = this.input(d);
    if ('status' in i) return i;
    if (this.crashOnListKinds.has(i.kind)) {
      this.crashed = true;
      throw new Error('simulated OBS crash (obs-websocket strlen(NULL))');
    }
    const list = this.listItems[i.kind]?.[String(d['propertyName'])];
    if (!list) return fail(600, 'Unable to find a property by that name.');
    const current = i.settings[String(d['propertyName'])];
    // Plugins like mac-avcapture add the configured-but-missing device as a disabled entry.
    const missing = typeof current === 'string' && current !== '' && !list.some((x) => x.itemValue === current) && i.kind === 'macos-avcapture';
    return ok({ propertyItems: missing ? [...list, { itemName: '', itemValue: current, itemEnabled: false }] : list });
  }
  rGetInputMute(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    if (!AUDIO_KINDS.has(i.kind)) return fail(604, 'The specified input does not support audio.');
    return ok({ inputMuted: i.muted });
  }
  rSetInputMute(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    i.muted = !!d['inputMuted'];
    return ok();
  }
  rGetInputVolume(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    if (!AUDIO_KINDS.has(i.kind)) return fail(604, 'The specified input does not support audio.');
    return ok({ inputVolumeMul: 10 ** (i.volumeDb / 20), inputVolumeDb: i.volumeDb });
  }
  rSetInputVolume(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    const db = Number(d['inputVolumeDb']);
    if (db < -100 || db > 26) return fail(402, 'The field `inputVolumeDb` is out of range.');
    i.volumeDb = db;
    return ok();
  }
  rGetInputAudioMonitorType(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    return ok({ monitorType: i.monitorType });
  }
  rSetInputAudioMonitorType(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    i.monitorType = String(d['monitorType']);
    return ok();
  }
  rGetInputAudioSyncOffset(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    return ok({ inputAudioSyncOffset: i.syncOffset });
  }
  rSetInputAudioSyncOffset(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    i.syncOffset = Number(d['inputAudioSyncOffset']);
    return ok();
  }
  rGetSourceFilterList(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    return ok({ filters: i.filters.map((f, idx) => ({ filterEnabled: f.enabled, filterIndex: idx, filterKind: f.kind, filterName: f.name, filterSettings: f.settings })) });
  }
  rGetSourceFilter(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    const idx = i.filters.findIndex((f) => f.name === d['filterName']);
    if (idx < 0) return fail(600, 'No filter was found in the source by that name.');
    const f = i.filters[idx]!;
    return ok({ filterEnabled: f.enabled, filterIndex: idx, filterKind: f.kind, filterSettings: f.settings });
  }
  rCreateSourceFilter(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    if (i.filters.some((f) => f.name === d['filterName'])) return fail(601, 'A filter already exists by that name.');
    if (!FILTER_KINDS.includes(String(d['filterKind']))) return fail(607, 'Your specified filter kind is not supported by OBS.');
    i.filters.push({ name: String(d['filterName']), kind: String(d['filterKind']), enabled: true, settings: (d['filterSettings'] ?? {}) as Record<string, unknown> });
    return ok();
  }
  rRemoveSourceFilter(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    if (!i.filters.some((f) => f.name === d['filterName'])) return fail(600, 'No filter was found in the source by that name.');
    i.filters = i.filters.filter((f) => f.name !== d['filterName']);
    return ok();
  }
  rSetSourceFilterSettings(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    const f = i.filters.find((x) => x.name === d['filterName']);
    if (!f) return fail(600, 'No filter was found in the source by that name.');
    const s = (d['filterSettings'] ?? {}) as Record<string, unknown>;
    f.settings = d['overlay'] === false ? { ...s } : { ...f.settings, ...s };
    return ok();
  }
  rSetSourceFilterEnabled(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    const f = i.filters.find((x) => x.name === d['filterName']);
    if (!f) return fail(600, 'No filter was found in the source by that name.');
    f.enabled = !!d['filterEnabled'];
    return ok();
  }
  rSetSourceFilterIndex(d: Record<string, unknown>) {
    const i = this.input(d);
    if ('status' in i) return i;
    const f = i.filters.find((x) => x.name === d['filterName']);
    if (!f) return fail(600, 'No filter was found in the source by that name.');
    i.filters = i.filters.filter((x) => x !== f);
    i.filters.splice(Number(d['filterIndex']), 0, f);
    return ok();
  }
  rGetSourceActive(d: Record<string, unknown>) {
    const name = String(d['sourceName']);
    if (!this.inputs.has(name) && !this.scene(name)) return fail(600, `No source was found by the name of \`${name}\`.`);
    // Active = shown in the program scene (real OBS: also preview and projectors).
    const live = this.scene(this.program);
    const active = name === this.program || !!live?.items.some((i) => i.source === name && i.enabled);
    return ok({ videoActive: active, videoShowing: active });
  }
  rGetSourceScreenshot(d: Record<string, unknown>) {
    const name = String(d['sourceName']);
    if (!this.inputs.has(name) && !this.scene(name)) return fail(600, `No source was found by the name of \`${name}\`.`);
    if (!this.version.supportedImageFormats.includes(String(d['imageFormat']))) return fail(400, 'Your specified image format is invalid or not supported by this system.');
    const inp = this.inputs.get(name);
    if (inp?.kind === 'screen_capture') {
      // Calibrated sizes at 160 px: black ~900 bytes, desktop ~4 kB (see BLACK_PROBE).
      const picture = this.everActive.has(name) || this.forcePicture.has(name) || this.scene(this.program)?.items.some((i) => i.source === name && i.enabled);
      return ok({ imageData: `data:image/${d['imageFormat']};base64,${Buffer.alloc(picture ? 4000 : 900, 7).toString('base64')}` });
    }
    return ok({ imageData: `data:image/${d['imageFormat']};base64,${TINY_JPEG}` });
  }
  rGetStreamStatus() {
    this.bump();
    return ok({ outputActive: this.stream.active, outputBytes: this.stream.bytes, outputCongestion: this.stream.congestion, outputDuration: this.stream.duration, outputReconnecting: this.stream.reconnecting, outputSkippedFrames: this.stream.skipped, outputTimecode: '00:00:00.000', outputTotalFrames: this.stream.total });
  }
  rStartStream() {
    if (this.stream.active) return fail(500, '');
    this.stream.active = true;
    return ok();
  }
  rStopStream() {
    if (!this.stream.active) return fail(501, '');
    this.stream.active = false;
    return ok();
  }
  rGetRecordStatus() {
    this.bump();
    return ok({ outputActive: this.record.active, outputBytes: this.record.bytes, outputDuration: this.record.duration, outputPaused: this.record.paused, outputTimecode: '00:00:00.000' });
  }
  rStartRecord() {
    if (this.record.active) return fail(500, '');
    this.record.active = true;
    return ok();
  }
  rStopRecord() {
    if (!this.record.active) return fail(501, '');
    this.record.active = false;
    const file = path.join(this.record.dir, `2026-10-11 12-00-${String(this.requests.length % 60).padStart(2, '0')}.mov`);
    try {
      mkdirSync(this.record.dir, { recursive: true });
      writeFileSync(file, Buffer.alloc(4096, 1));
    } catch {
      /* directory not writable in this test */
    }
    this.record.lastPath = file;
    return ok({ outputPath: file });
  }
  rGetReplayBufferStatus() {
    return this.replayBuffer.available ? ok({ outputActive: this.replayBuffer.active }) : fail(604, 'Replay buffer is not available.');
  }
  rStartReplayBuffer() {
    if (!this.replayBuffer.available) return fail(604, 'Replay buffer is not available.');
    this.replayBuffer.active = true;
    return ok();
  }
  rStopReplayBuffer() {
    this.replayBuffer.active = false;
    return ok();
  }
  rSaveReplayBuffer() {
    return this.replayBuffer.active ? ok() : fail(501, '');
  }
  rGetLastReplayBufferReplay() {
    return ok({ savedReplayPath: path.join(this.record.dir, 'Replay 2026-10-11 12-00-00.mov') });
  }
  rGetVirtualCamStatus() {
    return ok({ outputActive: this.virtualCam });
  }
  rStartVirtualCam() {
    this.virtualCam = true;
    return ok();
  }
  rStopVirtualCam() {
    this.virtualCam = false;
    return ok();
  }
}
