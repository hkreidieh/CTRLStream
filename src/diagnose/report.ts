/** diagnose: gather status, stats, setup, devices, log and snapshot drift, then apply the rules. */
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { listCrashReports, listLogs, listSentinels, parseLog, readJson, readText, readWebsocketConfig } from '../obs/files.js';
import type { FileEntry, ParsedLog } from '../obs/files.js';
import { AUDIO_KINDS, deviceProperty, listQueryIsSafe } from '../obs/input-roles.js';
import { enumerateDevices } from '../probes/devices.js';
import { familyName, loadEncoderMap, simpleEncodersAvailable, suggestEncoder } from '../probes/encoders.js';
import { SIMPLE_ENCODERS, encoderFamily } from '../obs/config-keys.js';
import type { DeviceInventory } from '../probes/devices.js';
import { collectState, scenesAndInputsFromCollection } from '../snapshots/state.js';
import type { SetupState } from '../snapshots/state.js';
import { latestKnownGood } from '../snapshots/store.js';
import { referencedDeviceIds } from '../snapshots/diff.js';
import { encoderReplacements, lastClosedState, recordClosedState } from './closed-state.js';
import { inputsTouched } from '../safety/undo.js';
import { computeFindings } from './findings.js';
import type { Finding } from './findings.js';
import { loadPlatforms, matchPlatform, uploadHeadroom } from './platforms.js';

/** OBS names logs "YYYY-MM-DD HH-MM-SS.txt" in local time at startup. */
export function logStartTime(entry: FileEntry): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})/.exec(entry.file);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export interface LastUpload {
  measuredAt: string;
  uploadMbps: number;
}

export function networkFile(ctx: Ctx): string {
  return path.join(ctx.dataDir, 'network.json');
}

export interface CrashCheck {
  newestCrash: FileEntry | null;
  newerThanStart: boolean;
  /**
   * The current log opens with "Crash or unclean shutdown detected" and a crash report was written
   * during the previous session. Seen on the real OBS: after a crash and a relaunch the report is
   * older than the current start, so newerThanStart alone misses it.
   */
  previousSessionCrashed: boolean;
  lastStart: Date | null;
  uncleanShutdown: boolean;
}

export async function crashCheck(ctx: Ctx, running: boolean): Promise<CrashCheck> {
  const [logs, crashes, sentinels] = await Promise.all([listLogs(ctx.paths), listCrashReports(ctx.paths), listSentinels(ctx.paths)]);
  const newestLog = logs[0] ?? null;
  const prevLog = logs[1] ?? null;
  const startOf = (l: FileEntry | null) => (l ? (logStartTime(l) ?? new Date(l.mtimeMs)) : null);
  const lastStart = startOf(newestLog);
  const prevStart = startOf(prevLog);
  const newestCrash = crashes[0] ?? null;
  const parsed = newestLog ? parseLog((await readText(newestLog.path)) ?? '') : null;
  return {
    newestCrash,
    newerThanStart: !!(newestCrash && lastStart && newestCrash.mtimeMs > lastStart.getTime()),
    previousSessionCrashed: !!(parsed?.previousSessionUnclean && newestCrash && lastStart && newestCrash.mtimeMs <= lastStart.getTime() && (!prevStart || newestCrash.mtimeMs >= prevStart.getTime())),
    lastStart,
    // While running, OBS keeps its own run_<uuid> sentinel; only meaningful when closed.
    uncleanShutdown: !running && sentinels.length > 0,
  };
}

/** Inputs whose configured device is not in the device list OBS offers right now. */
export async function missingDevices(ctx: Ctx, state: SetupState, inputSettings: Record<string, Record<string, unknown>>): Promise<Array<{ input: string; kind: string; deviceId: string; audio: boolean }>> {
  const out: Array<{ input: string; kind: string; deviceId: string; audio: boolean }> = [];
  const present = new Map<string, Set<string> | null>();
  for (const input of state.inputs) {
    const prop = deviceProperty(input.kind);
    const id = prop ? inputSettings[input.name]?.[prop] : undefined;
    if (!prop || id === undefined || id === null || id === '' || id === 'default') continue;
    if (!listQueryIsSafe(input.kind)) {
      // macOS display captures: compare with the displays macOS reports (never OBS's list).
      if (prop === 'display_uuid' && ctx.paths.platform === 'darwin') {
        if (!present.has(input.kind)) {
          try {
            present.set(input.kind, new Set((await ctx.displays.list()).map((d) => d.uuid)));
          } catch {
            present.set(input.kind, null);
          }
        }
        const set = present.get(input.kind);
        if (set && set.size > 0 && !set.has(String(id))) out.push({ input: input.name, kind: input.kind, deviceId: String(id), audio: false });
      }
      continue;
    }
    if (!present.has(input.kind)) {
      // The list on the input itself; disabled entries are how plugins mark a missing device.
      const r = await ctx.obs.tryCall('GetInputPropertiesListPropertyItems', { inputName: input.name, propertyName: prop });
      present.set(input.kind, r ? new Set((r.propertyItems as Array<Record<string, unknown>>).filter((i) => i['itemEnabled'] !== false).map((i) => String(i['itemValue']))) : null);
    }
    const set = present.get(input.kind);
    if (set && !set.has(String(id))) out.push({ input: input.name, kind: input.kind, deviceId: String(id), audio: AUDIO_KINDS.has(input.kind) });
  }
  return out;
}

const FILE_SETTINGS: Record<string, Array<{ key: string; when?: (s: Record<string, unknown>) => boolean }>> = {
  image_source: [{ key: 'file' }],
  ffmpeg_source: [{ key: 'local_file', when: (s) => s['is_local_file'] !== false }],
};

export function sceneSourceIssues(state: SetupState, inputSettings: Record<string, Record<string, unknown>>, items?: Array<{ scene: string; source: string }>): string[] {
  const issues: string[] = [];
  const names = new Set([...state.inputs.map((i) => i.name), ...state.scenes]);
  for (const it of items ?? []) {
    if (!names.has(it.source)) issues.push(`Scene '${it.scene}' has an item '${it.source}' whose source no longer exists.`);
  }
  for (const input of state.inputs) {
    const rules = FILE_SETTINGS[input.kind.replace(/_v\d+$/, '')];
    const s = inputSettings[input.name] ?? {};
    for (const r of rules ?? []) {
      const f = s[r.key];
      if (typeof f === 'string' && f && (!r.when || r.when(s)) && !existsSync(f)) issues.push(`Input '${input.name}' points at a file that is gone: ${f}`);
    }
  }
  return issues;
}

export interface DiagnoseReport {
  obs: { running: boolean; pid: number | null; version: string | null; uptimeSeconds: number | null; safeMode: boolean; crashSinceLastStart: boolean; previousSessionCrashed: boolean; uncleanShutdown: boolean };
  connection: { ok: boolean; error?: string };
  stats: Record<string, number | null> | null;
  stream: Record<string, unknown> | null;
  record: Record<string, unknown> | null;
  video: unknown;
  output: unknown;
  audio: unknown;
  streamService: unknown;
  devices: { present: Record<string, string[]> | null; missingVsSnapshot: string[]; snapshotId: string | null; notes?: string[] };
  log: { file: string | null; encoders: string[]; errors: string[]; warnings: string[] };
  findings: Finding[];
  notes: string[];
}

export async function runDiagnose(ctx: Ctx, opts: { devices?: boolean } = {}): Promise<DiagnoseReport> {
  const notes: string[] = [];
  const proc = await ctx.proc.find();
  const running = !!proc;
  if (!running) await recordClosedState(ctx).catch(() => null);
  const ws = await readWebsocketConfig(ctx.paths, ctx.secrets);
  let connectionError: string | undefined;
  if (running && !ctx.obs.connected) {
    try {
      await ctx.obs.connect();
    } catch (e) {
      connectionError = (e as Error).message;
    }
  }
  const connected = running && ctx.obs.connected;

  const logs = await listLogs(ctx.paths);
  const newest = logs[0] ?? null;
  const logText = newest ? await readText(newest.path) : null;
  const parsed: ParsedLog | null = logText ? parseLog(logText) : null;
  // Encoders: the newest log that lists them (a safe-mode log may not).
  let encoders: string[] = parsed?.encoders.video.map((e) => e.id) ?? [];
  if (encoders.length === 0) {
    for (const l of logs.slice(1, 5)) {
      const t = await readText(l.path);
      const p = t ? parseLog(t) : null;
      if (p?.encoders.video.length) {
        encoders = p.encoders.video.map((e) => e.id);
        break;
      }
    }
  }
  const crash = await crashCheck(ctx, running);

  let stats: DiagnoseReport['stats'] = null;
  let stream: DiagnoseReport['stream'] = null;
  let record: DiagnoseReport['record'] = null;
  let version: string | null = null;
  if (connected) {
    const [s, st, rc, v] = await Promise.all([ctx.obs.tryCall('GetStats'), ctx.obs.tryCall('GetStreamStatus'), ctx.obs.tryCall('GetRecordStatus'), ctx.obs.version().catch(() => null)]);
    version = v?.obsVersion ?? null;
    if (s)
      stats = {
        cpuUsage: Math.round(s.cpuUsage * 10) / 10,
        memoryMb: Math.round(s.memoryUsage),
        activeFps: Math.round(s.activeFps * 100) / 100,
        averageFrameRenderTimeMs: Math.round(s.averageFrameRenderTime * 100) / 100,
        renderSkipped: s.renderSkippedFrames,
        renderTotal: s.renderTotalFrames,
        outputSkipped: s.outputSkippedFrames,
        outputTotal: s.outputTotalFrames,
        diskFreeMb: Math.round(s.availableDiskSpace),
      };
    if (st) stream = { active: st.outputActive, reconnecting: st.outputReconnecting, congestion: Math.round(st.outputCongestion * 100) / 100, skipped: st.outputSkippedFrames, total: st.outputTotalFrames, durationSeconds: Math.round(st.outputDuration / 1000) };
    if (rc) record = { active: rc.outputActive, paused: rc.outputPaused, durationSeconds: Math.round(rc.outputDuration / 1000), bytes: rc.outputBytes };
  }

  let state: Awaited<ReturnType<typeof collectState>> | null = null;
  try {
    state = await collectState(ctx);
  } catch (e) {
    notes.push(`Could not read the current setup: ${(e as Error).message}`);
  }
  if (!stats && state?.output.recPath && existsSync(state.output.recPath)) {
    try {
      const fs = await statfs(state.output.recPath);
      stats = { diskFreeMb: Math.round((fs.bavail * fs.bsize) / (1024 * 1024)) } as DiagnoseReport['stats'];
    } catch {
      /* statfs unsupported */
    }
  }

  let inventory: DeviceInventory | null = null;
  let missing: Awaited<ReturnType<typeof missingDevices>> = [];
  if (connected && state && opts.devices !== false) {
    try {
      inventory = await enumerateDevices(ctx);
    } catch (e) {
      notes.push(`Device enumeration failed: ${(e as Error).message}`);
    }
  }
  // The per-input device check only reads existing inputs, so it runs even without enumeration.
  if (connected && state) {
    missing = await missingDevices(ctx, state, state.inputSettings);
  } else if (!connected) {
    notes.push('Not connected to OBS: devices, live stats and stream health were not checked.');
  }

  const knownGood = await latestKnownGood(ctx);
  // Only devices an input in the snapshot actually used (a Continuity Camera phone that is not
  // nearby is not "missing" unless the setup relied on it).
  const missingVsSnapshot: string[] = [];
  if (knownGood?.devices && inventory) {
    const used = referencedDeviceIds(knownGood);
    for (const bucket of ['cameras', 'microphones', 'speakers', 'displays'] as const) {
      const now = new Set(inventory[bucket].filter((d) => d.available).map((d) => d.id));
      for (const d of knownGood.devices[bucket]) if (used.has(d.id) && !now.has(d.id)) missingVsSnapshot.push(d.name);
    }
  }

  const platforms = await loadPlatforms(ctx);
  const svc = state?.streamService;
  const cap = svc ? matchPlatform(platforms, { type: svc.type, service: svc.service, server: svc.server }) : null;
  const upload = await readJson<LastUpload>(networkFile(ctx));

  let collectionItems: Array<{ scene: string; source: string }> | undefined;
  if (state && state.source === 'files' && state.active.collection) {
    collectionItems = scenesAndInputsFromCollection(await readJson(state.active.collection.path)).items;
  }

  // LOG_ERRORS: only the current OBS run's log, each line with its time, minus lines about inputs
  // this session has changed since.
  const errs = currentErrors(parsed, newest ? logStartTime(newest) : null, inputsTouched(ctx));
  const parsedForFindings: ParsedLog | null = parsed ? { ...parsed, errors: errs.kept } : null;

  // Advice for unavailable Simple-mode encoders: never available here, or lost (driver)?
  const encMap = (await loadEncoderMap(ctx)).map;
  const replacements =
    running && state?.source === 'live'
      ? encoderReplacements(await lastClosedState(ctx), {
          profile: state.profile,
          streamEncoder: state.output.mode === 'Simple' ? state.output.encoder : null,
          recEncoder: state.output.mode === 'Simple' && state.output.recQuality !== 'Stream' ? state.output.recEncoder : null,
          lastStart: crash.lastStart,
        })
      : [];
  const candidates = new Set<string>([...replacements.map((r) => r.was), ...(state?.output.mode === 'Simple' && state.output.encoder ? [state.output.encoder] : [])]);
  const encoderAdvice: Record<string, { neverAvailable: boolean; family: string; suggest: { encoder: string; family: string } }> = {};
  if (candidates.size > 0 && encoders.length > 0) {
    const everSeen = await familiesEverInLogs(ctx);
    const platformId = svc ? (matchPlatform(platforms, { type: svc.type, service: svc.service, server: svc.server })?.platform ?? null) : null;
    const suggest = await suggestEncoder(ctx, simpleEncodersAvailable(encoders, encMap), platformId);
    for (const enc of candidates) {
      const fam = SIMPLE_ENCODERS[enc]?.family;
      if (!fam) continue;
      const gpuFamilyOnMac = ctx.paths.platform === 'darwin' && (fam === 'nvenc' || fam === 'amf' || fam === 'qsv');
      encoderAdvice[enc] = { neverAvailable: gpuFamilyOnMac || !everSeen.has(fam), family: await familyName(ctx, enc), suggest };
    }
  }

  const findings = computeFindings({
    running,
    websocket: { configEnabled: ws.serverEnabled, configExists: ws.exists, connected, ...(connectionError ? { error: connectionError } : {}) },
    log: parsedForFindings,
    crashNewerThanStart: crash.newerThanStart && crash.newestCrash ? { file: crash.newestCrash.file } : null,
    previousSessionCrash: crash.previousSessionCrashed && crash.newestCrash ? { file: crash.newestCrash.file } : null,
    uncleanShutdown: crash.uncleanShutdown,
    stats:
      stats && stats['renderTotal'] !== undefined
        ? { renderSkipped: stats['renderSkipped'] ?? 0, renderTotal: stats['renderTotal'] ?? 0, outputSkipped: stats['outputSkipped'] ?? 0, outputTotal: stats['outputTotal'] ?? 0, diskFreeMb: stats['diskFreeMb'] ?? null }
        : stats
          ? { renderSkipped: 0, renderTotal: 0, outputSkipped: 0, outputTotal: 0, diskFreeMb: stats['diskFreeMb'] ?? null }
          : null,
    stream: stream ? { active: !!stream['active'], reconnecting: !!stream['reconnecting'], congestion: Number(stream['congestion'] ?? 0), skipped: Number(stream['skipped'] ?? 0), total: Number(stream['total'] ?? 0) } : null,
    state,
    missingDevices: missing,
    knownGood,
    encodersInLog: encoders,
    encoderReplacements: replacements,
    encoderAdvice,
    encoderMap: encMap,
    platformCap: cap,
    lastUploadMbps: upload?.uploadMbps ?? null,
    uploadHeadroom: uploadHeadroom(platforms),
    sceneSourceIssues: state ? sceneSourceIssues(state, state.inputSettings, collectionItems) : [],
  });

  const lastStart = crash.lastStart;
  return {
    obs: {
      running,
      pid: proc?.pid ?? null,
      version: version ?? parsed?.obsVersion ?? null,
      uptimeSeconds: running && lastStart ? Math.max(0, Math.round((ctx.now().getTime() - lastStart.getTime()) / 1000)) : null,
      safeMode: running && !!parsed?.safeMode,
      crashSinceLastStart: crash.newerThanStart,
      previousSessionCrashed: crash.previousSessionCrashed,
      uncleanShutdown: crash.uncleanShutdown,
    },
    connection: connected ? { ok: true } : { ok: false, ...(connectionError ? { error: connectionError } : running ? {} : { error: 'OBS is not running' }) },
    stats,
    stream,
    record,
    video: state?.video ?? null,
    output: state?.output ?? null,
    audio: state?.audio ?? null,
    streamService: svc ? { type: svc.type, service: svc.service ?? null, server: svc.server ?? null, key: svc.key } : null,
    devices: {
      present: inventory
        ? {
            cameras: inventory.cameras.filter((d) => d.available).map((d) => d.name),
            microphones: inventory.microphones.filter((d) => d.available).map((d) => d.name),
            speakers: inventory.speakers.filter((d) => d.available).map((d) => d.name),
            displays: inventory.displays.filter((d) => d.available).map((d) => d.name),
          }
        : null,
      missingVsSnapshot,
      snapshotId: knownGood?.id ?? null,
      ...(inventory?.notes.length ? { notes: inventory.notes } : {}),
    },
    log: {
      file: newest?.file ?? null,
      encoders,
      errors: errs.kept.slice(0, 10),
      ...(errs.dropped.length ? { errorsAlreadyAddressed: errs.dropped.slice(0, 10) } : {}),
      warnings: parsed?.warnings.slice(0, 10) ?? [],
    },
    findings,
    notes,
  };
}

/** Absolute time of a log line: the log file's start date plus the line's clock time (handles midnight). */
export function logLineTime(logStart: Date | null, clock: string | null): Date | null {
  if (!logStart || !clock) return null;
  const m = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(clock);
  if (!m) return null;
  const t = new Date(logStart);
  t.setHours(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
  if (t.getTime() < logStart.getTime() - 1000) t.setDate(t.getDate() + 1);
  return t;
}

/** Does a log line name this input? OBS prefixes source messages with "<name>: ". */
export function lineMentionsInput(line: string, name: string): boolean {
  return line.startsWith(`${name}: `) || line.includes(`'${name}'`) || line.includes(`"${name}"`);
}

/**
 * LOG_ERRORS input: the current run's error lines with their time, minus lines about an input this
 * session changed after the line was written (the problem it reports has been dealt with).
 */
export function currentErrors(parsed: ParsedLog | null, logStart: Date | null, touched: Map<string, Date>): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const e of parsed?.errorEntries ?? []) {
    const at = logLineTime(logStart, e.time);
    const shown = e.time ? `[${e.time}] ${e.line}` : e.line;
    const fixedLater = at !== null && [...touched.entries()].some(([name, t]) => t.getTime() > at.getTime() && lineMentionsInput(e.line, name));
    (fixedLater ? dropped : kept).push(shown);
  }
  return { kept, dropped };
}

/** Encoder families that appear in any OBS log on this machine (OBS keeps the last 10). */
export async function familiesEverInLogs(ctx: Ctx): Promise<Set<string>> {
  const seen = new Set<string>();
  for (const l of (await listLogs(ctx.paths)).slice(0, 10)) {
    const t = await readText(l.path);
    for (const e of t ? parseLog(t).encoders.video : []) seen.add(encoderFamily(e.id));
  }
  return seen;
}
