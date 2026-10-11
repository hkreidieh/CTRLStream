/**
 * Deterministic finding rules (DESIGN 6). Pure functions over gathered facts so each rule can be
 * unit tested. Interpretation beyond these belongs to the troubleshoot skill.
 */
import type { ParsedLog } from '../obs/files.js';
import { SIMPLE_ENCODERS } from '../obs/config-keys.js';
import type { Manifest } from '../snapshots/store.js';
import type { SetupState } from '../snapshots/state.js';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  code: string;
  severity: Severity;
  evidence: string;
  suggestedTool?: string;
  suggestedAction?: string;
}

export interface FindingInput {
  running: boolean;
  websocket: { configEnabled: boolean; configExists: boolean; connected: boolean; error?: string };
  log: ParsedLog | null;
  crashNewerThanStart: { file: string } | null;
  previousSessionCrash?: { file: string } | null;
  uncleanShutdown: boolean;
  stats: { renderSkipped: number; renderTotal: number; outputSkipped: number; outputTotal: number; diskFreeMb: number | null } | null;
  stream: { active: boolean; reconnecting: boolean; congestion: number; skipped: number; total: number } | null;
  state: SetupState | null;
  missingDevices: Array<{ input: string; kind: string; deviceId: string; audio: boolean }>;
  knownGood: Manifest | null;
  encodersInLog: string[];
  /** Encoders OBS replaced with x264 at start because it could not load them (from closed-state records). */
  encoderReplacements?: Array<{ setting: string; was: string; now: string; readAt: string }>;
  /**
   * Per unavailable Simple-mode encoder: was it ever available on this machine (never on macOS for
   * NVENC/AMF/QSV, or never in any OBS log here), and the best encoder to use instead.
   */
  encoderAdvice?: Record<string, { neverAvailable: boolean; family: string; suggest: { encoder: string; family: string } }>;
  /** Simple-mode id -> libobs ids (knowledge/encoders.json or the built-in table). */
  encoderMap?: Record<string, string[]>;
  platformCap: { displayName: string; maxVideoBitrateKbps: number | null } | null;
  lastUploadMbps: number | null;
  uploadHeadroom: number;
  sceneSourceIssues: string[];
}

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0);
const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function unavailableAction(f: FindingInput, encoder: string, setting = 'StreamEncoder'): string {
  const a = f.encoderAdvice?.[encoder];
  const tool = setting === 'RecEncoder' ? 'record_set' : 'output_set_simple';
  if (!a) return `Pick an encoder that obs_encoders lists and set it with ${tool}.`;
  const use = `Use '${a.suggest.encoder}' (${a.suggest.family}) instead, with ${tool}.`;
  return a.neverAvailable
    ? `'${encoder}' (${a.family}) has never been available on this machine, so nothing broke: it was simply the wrong choice here. ${use}`
    : `'${encoder}' (${a.family}) worked on this machine before, so its graphics driver probably changed or broke; updating it may bring it back. Until then: ${use}`;
}

export function computeFindings(f: FindingInput): Finding[] {
  const out: Finding[] = [];
  const add = (x: Finding) => out.push(x);

  if (!f.running) {
    add({
      code: 'OBS_NOT_RUNNING',
      severity: 'high',
      evidence: f.uncleanShutdown ? 'OBS is not running, and its last session did not shut down cleanly.' : 'OBS is not running.',
      suggestedTool: 'obs_launch',
      suggestedAction: f.crashNewerThanStart ? 'A crash report exists for the last session: launch with safeMode (or onlyBundledPlugins to keep the websocket) to triage.' : 'Launch OBS, then diagnose again.',
    });
  }

  if (f.running && (!f.websocket.configEnabled || !f.websocket.connected)) {
    add({
      code: 'WEBSOCKET_DISABLED',
      severity: 'high',
      evidence: !f.websocket.configEnabled
        ? 'OBS is running but its websocket server is disabled in plugin_config/obs-websocket/config.json.'
        : `OBS is running but the websocket did not answer${f.websocket.error ? `: ${f.websocket.error}` : ''}.`,
      suggestedTool: f.websocket.configEnabled ? 'obs_connect' : 'obs_quit',
      suggestedAction: f.websocket.configEnabled ? 'Retry obs_connect; if it still fails, quit and relaunch OBS.' : 'Quit OBS, call obs_connect to enable the websocket in the config, then obs_launch.',
    });
  }

  if (f.running && f.log?.safeMode) {
    add({
      code: 'SAFE_MODE_ACTIVE',
      severity: 'medium',
      evidence: 'The current OBS log says Safe Mode is enabled: third-party plugins, scripts and the websocket are off.',
      suggestedTool: 'obs_quit',
      suggestedAction: 'When triage is done, quit and relaunch normally with obs_launch.',
    });
  }

  if (f.crashNewerThanStart || f.previousSessionCrash) {
    add({
      code: 'PLUGIN_CRASH_SUSPECTED',
      severity: 'high',
      evidence: f.crashNewerThanStart
        ? `Crash report ${f.crashNewerThanStart.file} is newer than the last OBS start.`
        : `OBS crashed in its previous session (crash report ${f.previousSessionCrash!.file}) and was relaunched; the current log says "Crash or unclean shutdown detected".`,
      suggestedTool: 'obs_launch',
      suggestedAction: 'Relaunch with safeMode or onlyBundledPlugins. If OBS is stable that way, a third-party plugin is the likely cause.',
    });
  }

  const congestion = f.stream?.active ? f.stream.congestion : 0;
  const encLagRatio = f.stats ? pct(f.stats.outputSkipped, f.stats.outputTotal) : 0;
  if ((f.log?.encoderOverload.length ?? 0) > 0 || (encLagRatio > 2 && congestion < 0.3)) {
    add({
      code: 'ENCODER_OVERLOAD',
      severity: 'high',
      evidence: f.log?.encoderOverload[0] ?? `${encLagRatio.toFixed(1)}% of frames skipped by the encoder (${f.stats!.outputSkipped}/${f.stats!.outputTotal}).`,
      suggestedTool: 'output_set_simple',
      suggestedAction: 'Switch to a hardware encoder, use a faster preset, or lower output resolution/fps (video_set).',
    });
  }

  if (f.stream?.active && (f.stream.congestion > 0.3 || f.stream.reconnecting)) {
    add({
      code: 'NETWORK_DROPS',
      severity: 'high',
      evidence: f.stream.reconnecting
        ? 'The stream is reconnecting.'
        : `Stream congestion is ${f.stream.congestion.toFixed(2)} with ${f.stream.skipped}/${f.stream.total} frames dropped.`,
      suggestedTool: 'output_set_simple',
      suggestedAction: 'Lower the video bitrate, or run network_test to measure the upload first.',
    });
  } else if ((f.log?.networkDrops.length ?? 0) > 0) {
    add({
      code: 'NETWORK_DROPS',
      severity: 'medium',
      evidence: f.log!.networkDrops[0]!,
      suggestedTool: 'network_test',
      suggestedAction: 'The last stream dropped frames for bandwidth. Measure upload and set the bitrate below 70% of it.',
    });
  }

  if (f.stats && pct(f.stats.renderSkipped, f.stats.renderTotal) > 1) {
    add({
      code: 'RENDER_LAG',
      severity: 'medium',
      evidence: `${pct(f.stats.renderSkipped, f.stats.renderTotal).toFixed(1)}% of frames missed by the renderer (${f.stats.renderSkipped}/${f.stats.renderTotal}).`,
      suggestedTool: 'video_set',
      suggestedAction: 'The GPU cannot keep up: lower fps or canvas resolution, or cap the game frame rate.',
    });
  }

  for (const m of f.missingDevices) {
    add({
      code: m.audio ? 'AUDIO_DEVICE_MISSING' : 'DEVICE_MISSING',
      severity: 'high',
      evidence: `Input '${m.input}' (${m.kind}) is set to device id '${m.deviceId}', which is not present now.`,
      suggestedTool: 'input_settings_set',
      suggestedAction: `Point '${m.input}' at a device that is present (input_properties lists them), or ask the user to reconnect it.`,
    });
  }

  const out0 = f.state?.output;
  if (out0 && out0.encoder && f.encodersInLog.length > 0) {
    const candidates = out0.mode === 'Simple' ? (f.encoderMap?.[out0.encoder] ?? SIMPLE_ENCODERS[out0.encoder]?.libobs ?? []) : [out0.encoder];
    if (candidates.length > 0 && !candidates.some((c) => f.encodersInLog.includes(c))) {
      add({
        code: 'ENCODER_UNAVAILABLE',
        severity: 'high',
        evidence: `Configured encoder '${out0.encoder}' is not among the encoders OBS loaded (${f.encodersInLog.slice(0, 6).join(', ')}${f.encodersInLog.length > 6 ? ', ...' : ''}).`,
        suggestedTool: out0.mode === 'Simple' ? 'output_set_simple' : 'obs_encoders',
        suggestedAction: out0.mode === 'Simple' ? unavailableAction(f, out0.encoder) : 'Pick an encoder that obs_encoders lists and set it with output_set_advanced (OBS closed).',
      });
    }
  }

  for (const r of f.encoderReplacements ?? []) {
    if (out.some((x) => x.code === 'ENCODER_UNAVAILABLE' && x.evidence.includes(`'${r.was}'`))) continue;
    add({
      code: 'ENCODER_UNAVAILABLE',
      severity: 'high',
      evidence: `${r.setting} was '${r.was}' on disk while OBS was closed (read ${r.readAt}); OBS replaced it with '${r.now}' when it started, because '${r.was}' is not among the encoders it loaded.`,
      suggestedTool: r.setting === 'RecEncoder' ? 'record_set' : 'output_set_simple',
      suggestedAction: unavailableAction(f, r.was, r.setting),
    });
  }

  if (f.knownGood && f.state) {
    const a = f.knownGood.video;
    const b = f.state.video;
    const vKeys = ['baseWidth', 'baseHeight', 'outputWidth', 'outputHeight', 'fpsNumerator', 'fpsDenominator'] as const;
    const vDiff = vKeys.filter((k) => a[k] !== b[k]);
    if (vDiff.length) {
      add({
        code: 'RESOLUTION_OR_FPS_DRIFT',
        severity: 'medium',
        evidence: `Video differs from known-good snapshot ${f.knownGood.id}: ${vDiff.map((k) => `${k} ${a[k]} -> ${b[k]}`).join(', ')}.`,
        suggestedTool: 'video_set',
        suggestedAction: 'Set video back to the snapshot values, or snapshot_restore if much else changed too.',
      });
    }
    const oa = f.knownGood.output;
    const ob = f.state.output;
    const oKeys = ['mode', 'encoder', 'videoBitrateKbps', 'preset'] as const;
    const oDiff = oKeys.filter((k) => oa[k] !== ob[k]);
    if (oDiff.length) {
      add({
        code: 'OUTPUT_DRIFT',
        severity: 'medium',
        evidence: `Output differs from known-good snapshot ${f.knownGood.id}: ${oDiff.map((k) => `${k} ${oa[k]} -> ${ob[k]}`).join(', ')}.`,
        suggestedTool: ob.mode === 'Simple' ? 'output_set_simple' : 'snapshot_restore',
        suggestedAction: 'Set the output back to the snapshot values.',
      });
    }
  }

  // Effective bitrate: OBS clamps to the service maximum unless told to ignore it (verified live).
  const configured = f.state?.output.videoBitrateKbps ?? null;
  const vbr = f.state?.output.effectiveVideoBitrateKbps ?? configured;
  const cap = f.platformCap?.maxVideoBitrateKbps ?? null;
  if (vbr !== null && f.platformCap && cap !== null && vbr > cap) {
    add({
      code: 'BITRATE_ABOVE_PLATFORM_CAP',
      severity: 'medium',
      evidence: `OBS will send ${vbr} kbps${configured !== vbr ? ` (configured ${configured})` : ''}, above ${f.platformCap.displayName}'s cap of ${cap} kbps${f.state?.output.ignoreServiceLimits ? ' because the profile ignores the service limits' : ''}.`,
      suggestedTool: 'output_set_simple',
      suggestedAction: `Lower the video bitrate to at most ${cap} kbps.`,
    });
  }

  // Video plus audio against the headroom fraction (knowledge/platforms.json rules.uploadRule).
  const abr = f.state?.output.audioBitrateKbps ?? 0;
  if (vbr !== null && f.lastUploadMbps !== null && vbr + abr > f.uploadHeadroom * f.lastUploadMbps * 1000) {
    const pctTxt = Math.round(f.uploadHeadroom * 100);
    add({
      code: 'BITRATE_ABOVE_UPLOAD',
      severity: 'medium',
      evidence: `Video ${vbr} + audio ${abr} kbps is more than ${pctTxt}% of the last measured upload (${f.lastUploadMbps.toFixed(1)} Mbps).`,
      suggestedTool: 'output_set_simple',
      suggestedAction: `Lower the video bitrate to about ${Math.max(0, Math.floor(f.uploadHeadroom * f.lastUploadMbps * 1000 - abr))} kbps.`,
    });
  }

  if (f.stats?.diskFreeMb !== null && f.stats?.diskFreeMb !== undefined && f.stats.diskFreeMb < 5 * 1024 && f.state?.output.recPath) {
    add({
      code: 'DISK_LOW',
      severity: 'medium',
      evidence: `Only ${Math.round(f.stats.diskFreeMb)} MB free on the recording drive (${f.state.output.recPath}).`,
      suggestedTool: 'record_set',
      suggestedAction: 'Free some space, or point recordings at a drive with more room.',
    });
  }

  for (const issue of f.sceneSourceIssues) {
    add({ code: 'SCENE_SOURCE_MISSING', severity: 'medium', evidence: issue, suggestedTool: 'input_settings_set', suggestedAction: 'Point the source at a file that exists, or remove it.' });
  }

  if ((f.log?.errors.length ?? 0) > 0) {
    add({
      code: 'LOG_ERRORS',
      severity: 'low',
      evidence: f.log!.errors.slice(0, 5).join(' | '),
      suggestedTool: 'logs_tail',
      suggestedAction: 'Read the lines around these errors with logs_tail if no other finding explains them.',
    });
  }

  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
