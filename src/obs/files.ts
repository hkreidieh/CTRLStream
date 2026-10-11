/**
 * Reading OBS's own files: ini, json, logs, crash reports. Reads are always safe, even while OBS
 * runs. Nothing in this module writes to the OBS config dir; every write goes through
 * safety/file-write.ts (fileWrite), which refuses while OBS is running.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SecretRegistry } from '../safety/redact.js';
import type { ObsPaths, Platform } from './paths.js';
import { isCrashReportName } from './paths.js';

// ---------------------------------------------------------------------------------------------
// INI

export interface IniSection {
  name: string;
  entries: Array<[string, string]>;
}

export interface IniDoc {
  bom: boolean;
  eol: '\n' | '\r\n';
  sections: IniSection[];
}

/** OBS ini: `[Section]` then `Key=Value`, UTF-8, BOM on Windows (libobs util/config-file.c). */
export function parseIni(text: string): IniDoc {
  const bom = text.startsWith('﻿');
  const body = bom ? text.slice(1) : text;
  const eol: IniDoc['eol'] = body.includes('\r\n') ? '\r\n' : '\n';
  const sections: IniSection[] = [];
  let current: IniSection | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = sections.find((s) => s.name === sec[1]) ?? null;
      if (!current) {
        current = { name: sec[1]!, entries: [] };
        sections.push(current);
      }
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq <= 0 || !current) continue;
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    const existing = current.entries.find((e) => e[0] === key);
    if (existing) existing[1] = value;
    else current.entries.push([key, value]);
  }
  return { bom, eol, sections };
}

export function serializeIni(doc: IniDoc): string {
  const parts: string[] = [];
  doc.sections.forEach((s, i) => {
    if (i > 0) parts.push('');
    parts.push(`[${s.name}]`);
    for (const [k, v] of s.entries) parts.push(`${k}=${v}`);
  });
  return (doc.bom ? '﻿' : '') + parts.join(doc.eol) + doc.eol;
}

export function iniGet(doc: IniDoc | null | undefined, section: string, key: string): string | undefined {
  return doc?.sections.find((s) => s.name === section)?.entries.find((e) => e[0] === key)?.[1];
}

/** Set (or delete, with undefined) a value. Mutates `doc`. */
export function iniSet(doc: IniDoc, section: string, key: string, value: string | undefined): void {
  let sec = doc.sections.find((s) => s.name === section);
  if (value === undefined) {
    if (!sec) return;
    sec.entries = sec.entries.filter((e) => e[0] !== key);
    return;
  }
  if (!sec) {
    sec = { name: section, entries: [] };
    doc.sections.push(sec);
  }
  const e = sec.entries.find((x) => x[0] === key);
  if (e) e[1] = value;
  else sec.entries.push([key, value]);
}

export function iniToObject(doc: IniDoc): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const s of doc.sections) out[s.name] = Object.fromEntries(s.entries);
  return out;
}

// ---------------------------------------------------------------------------------------------
// generic reads

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export async function readJson<T = unknown>(file: string): Promise<T | null> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

export async function readIni(file: string): Promise<IniDoc | null> {
  const text = await readText(file);
  return text === null ? null : parseIni(text);
}

// ---------------------------------------------------------------------------------------------
// profiles and scene collections

export interface ActiveSelection {
  profileName?: string;
  profileDir?: string;
  collectionName?: string;
  collectionFile?: string;
  firstRunDone?: boolean;
  /** Which file held [Basic]: user.ini on OBS 31+, global.ini before. */
  source?: 'user.ini' | 'global.ini';
}

export async function readActiveSelection(paths: ObsPaths): Promise<ActiveSelection> {
  for (const [file, source] of [
    [paths.userIni, 'user.ini'],
    [paths.globalIni, 'global.ini'],
  ] as const) {
    const ini = await readIni(file);
    if (!ini) continue;
    const profileName = iniGet(ini, 'Basic', 'Profile');
    if (profileName === undefined) continue;
    const sel: ActiveSelection = { profileName, source };
    const pd = iniGet(ini, 'Basic', 'ProfileDir');
    if (pd !== undefined) sel.profileDir = pd;
    const cn = iniGet(ini, 'Basic', 'SceneCollection');
    if (cn !== undefined) sel.collectionName = cn;
    const cf = iniGet(ini, 'Basic', 'SceneCollectionFile');
    if (cf !== undefined) sel.collectionFile = cf.endsWith('.json') ? cf : `${cf}.json`;
    const fr = iniGet(ini, 'General', 'FirstRun');
    if (fr !== undefined) sel.firstRunDone = fr === 'true';
    return sel;
  }
  return {};
}

export interface ProfileEntry {
  name: string;
  dir: string;
  path: string;
}

export async function listProfiles(paths: ObsPaths): Promise<ProfileEntry[]> {
  if (!existsSync(paths.profilesDir)) return [];
  const out: ProfileEntry[] = [];
  for (const d of await readdir(paths.profilesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = path.join(paths.profilesDir, d.name);
    const ini = await readIni(path.join(p, 'basic.ini'));
    out.push({ name: iniGet(ini, 'General', 'Name') ?? d.name, dir: d.name, path: p });
  }
  return out;
}

export async function findProfile(paths: ObsPaths, name: string): Promise<ProfileEntry | null> {
  return (await listProfiles(paths)).find((p) => p.name === name) ?? null;
}

export interface CollectionEntry {
  name: string;
  file: string;
  path: string;
}

export async function listSceneCollections(paths: ObsPaths): Promise<CollectionEntry[]> {
  if (!existsSync(paths.scenesDir)) return [];
  const out: CollectionEntry[] = [];
  for (const f of await readdir(paths.scenesDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(paths.scenesDir, f);
    const json = await readJson<{ name?: string }>(p);
    out.push({ name: json?.name ?? f.replace(/\.json$/, ''), file: f, path: p });
  }
  return out;
}

export async function findSceneCollection(paths: ObsPaths, name: string): Promise<CollectionEntry | null> {
  return (await listSceneCollections(paths)).find((c) => c.name === name) ?? null;
}

/** Resolve the active (or named) profile and collection to absolute paths. */
export async function resolveProfileAndCollection(
  paths: ObsPaths,
  names: { profile?: string | undefined; collection?: string | undefined } = {},
): Promise<{ profile: ProfileEntry | null; collection: CollectionEntry | null }> {
  const sel = await readActiveSelection(paths);
  let profile: ProfileEntry | null = null;
  const profileName = names.profile ?? sel.profileName;
  if (profileName) profile = await findProfile(paths, profileName);
  if (!profile && !names.profile && sel.profileDir) {
    const p = path.join(paths.profilesDir, sel.profileDir);
    if (existsSync(p)) profile = { name: sel.profileName ?? sel.profileDir, dir: sel.profileDir, path: p };
  }
  let collection: CollectionEntry | null = null;
  const collectionName = names.collection ?? sel.collectionName;
  if (collectionName) collection = await findSceneCollection(paths, collectionName);
  if (!collection && !names.collection && sel.collectionFile) {
    const p = path.join(paths.scenesDir, sel.collectionFile);
    if (existsSync(p)) collection = { name: sel.collectionName ?? sel.collectionFile, file: sel.collectionFile, path: p };
  }
  return { profile, collection };
}

// ---------------------------------------------------------------------------------------------
// service.json and websocket config (both hold secrets)

export interface ServiceInfo {
  type: string;
  service?: string;
  server?: string;
  key: '<set>' | '<empty>';
  /** Every other non-secret setting, already redacted. */
  settings: Record<string, unknown>;
}

const SERVICE_SECRET_FIELDS = ['key', 'password', 'bearer_token', 'token'];

/**
 * Normalise stream service settings (from service.json or GetStreamServiceSettings) into a
 * shape with no secrets. Secret values are handed to the registry so they are scrubbed from
 * any free text later.
 */
export function summarizeService(
  type: string | undefined,
  settings: Record<string, unknown> | undefined,
  registry?: SecretRegistry,
): ServiceInfo {
  const s = settings ?? {};
  for (const f of SERVICE_SECRET_FIELDS) registry?.add(s[f]);
  const key = typeof s['key'] === 'string' && s['key'].length > 0 ? '<set>' : '<empty>';
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (SERVICE_SECRET_FIELDS.includes(k) || /(_key|_token|_password)$/i.test(k)) continue;
    rest[k] = v;
  }
  const info: ServiceInfo = { type: type ?? 'unknown', key, settings: rest };
  if (typeof s['service'] === 'string') info.service = s['service'];
  if (typeof s['server'] === 'string') info.server = s['server'];
  return info;
}

export async function readServiceJson(profilePath: string, registry?: SecretRegistry): Promise<ServiceInfo | null> {
  const json = await readJson<{ type?: string; settings?: Record<string, unknown> }>(path.join(profilePath, 'service.json'));
  if (!json) return null;
  return summarizeService(json.type, json.settings, registry);
}

export interface WebsocketConfig {
  exists: boolean;
  serverEnabled: boolean;
  serverPort: number;
  authRequired: boolean;
  /** Raw password. Internal use only (connecting); never put it in a result. */
  password?: string;
}

/** plugin_config/obs-websocket/config.json, keys verified against obs-websocket 5.7.4 src/Config.cpp. */
export async function readWebsocketConfig(paths: ObsPaths, registry?: SecretRegistry): Promise<WebsocketConfig> {
  const json = await readJson<Record<string, unknown>>(paths.websocketConfig);
  if (!json) return { exists: false, serverEnabled: false, serverPort: 4455, authRequired: true };
  const password = typeof json['server_password'] === 'string' ? json['server_password'] : undefined;
  registry?.add(password);
  const cfg: WebsocketConfig = {
    exists: true,
    serverEnabled: json['server_enabled'] === true,
    serverPort: typeof json['server_port'] === 'number' ? json['server_port'] : 4455,
    authRequired: json['auth_required'] !== false,
  };
  if (password !== undefined) cfg.password = password;
  return cfg;
}

// ---------------------------------------------------------------------------------------------
// logs

export interface FileEntry {
  file: string;
  path: string;
  mtimeMs: number;
  size: number;
}

async function listFiles(dir: string, filter: (name: string) => boolean): Promise<FileEntry[]> {
  if (!existsSync(dir)) return [];
  const out: FileEntry[] = [];
  for (const f of await readdir(dir)) {
    if (!filter(f)) continue;
    const p = path.join(dir, f);
    try {
      const st = await stat(p);
      if (st.isFile()) out.push({ file: f, path: p, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* raced with deletion */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
}

export function listLogs(paths: ObsPaths): Promise<FileEntry[]> {
  return listFiles(paths.logsDir, (f) => f.endsWith('.txt'));
}

export async function listCrashReports(paths: ObsPaths): Promise<FileEntry[]> {
  const all: FileEntry[] = [];
  for (const dir of paths.crashDirs) all.push(...(await listFiles(dir, (f) => isCrashReportName(paths.platform, f))));
  return all.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** OBS leaves .sentinel/run_<uuid> behind when a session did not shut down cleanly. */
export async function listSentinels(paths: ObsPaths): Promise<FileEntry[]> {
  return listFiles(paths.sentinelDir, (f) => f.startsWith('run_'));
}

export interface EncoderEntry {
  id: string;
  name: string;
}

export interface ParsedLog {
  obsVersion?: string;
  platformTag?: string;
  startedAt?: string;
  safeMode: boolean;
  onlyBundledPlugins: boolean;
  portable?: boolean;
  encoders: { video: EncoderEntry[]; audio: EncoderEntry[] };
  loadedModules: string[];
  errors: string[];
  /** The same error lines with their log time ("HH:MM:SS.mmm"), for filtering by time. */
  errorEntries: Array<{ time: string | null; line: string }>;
  warnings: string[];
  encoderOverload: string[];
  networkDrops: string[];
  cleanShutdown: boolean;
  /** "Crash or unclean shutdown detected" at the top of the log: the previous session ended badly. */
  previousSessionUnclean: boolean;
  /** macOS permission lines OBS prints at startup ("[macOS] Permission for screen capture denied."). */
  macPermissions: Record<string, 'granted' | 'denied'>;
  lineCount: number;
}

const TS_PREFIX = /^\d{2}:\d{2}:\d{2}\.\d{3}: ?/;

/** Lines every healthy install prints. Excluded from errors so LOG_ERRORS means something. */
const BENIGN = [
  /No AJA devices found/i,
  /Failed to initialize module '(aja|aja-output-ui|decklink|decklink-output-ui|decklink-captions)'/i,
  /Failed to load '[a-z]{2}-[A-Z]{2}' text for module/i,
  /DeckLink drivers may not be installed/i,
  /A DeckLink iterator could not be created/i,
  /Number of memory leaks: 0/,
];
const ERROR_RE = /\b(error|failed|failure|unable to|could not|cannot)\b/i;
const WARN_RE = /\b(warning|warn|deprecated|timed out|timeout|denied|not found|lagged)\b/i;

export function stripTimestamp(line: string): string {
  return line.replace(TS_PREFIX, '');
}

/** Parse an OBS log. Formats checked against a real OBS 32.2.2 macOS log (test/fixtures). */
export function parseLog(text: string, maxEach = 50): ParsedLog {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const out: ParsedLog = {
    safeMode: false,
    onlyBundledPlugins: false,
    encoders: { video: [], audio: [] },
    loadedModules: [],
    errors: [],
    errorEntries: [],
    warnings: [],
    encoderOverload: [],
    networkDrops: [],
    cleanShutdown: false,
    previousSessionUnclean: false,
    macPermissions: {},
    lineCount: lines.length,
  };
  let block: 'none' | 'encoders-video' | 'encoders-audio' | 'encoders' | 'modules' = 'none';
  for (const raw of lines) {
    const line = stripTimestamp(raw).replace(/\s+$/, '');
    if (!line) continue;
    const trimmed = line.trim();

    // Block parsing: "Available Encoders:" / "Video Encoders:" / "\t- id (name)".
    if (trimmed === 'Available Encoders:') {
      block = 'encoders';
      continue;
    }
    if (block !== 'none' && block !== 'modules') {
      if (trimmed === 'Video Encoders:') {
        block = 'encoders-video';
        continue;
      }
      if (trimmed === 'Audio Encoders:') {
        block = 'encoders-audio';
        continue;
      }
      const m = /^- (\S+) \((.*)\)$/.exec(trimmed);
      if (m && block !== 'encoders') {
        (block === 'encoders-video' ? out.encoders.video : out.encoders.audio).push({ id: m[1]!, name: m[2]! });
        continue;
      }
      block = 'none';
    }
    if (trimmed === 'Loaded Modules:') {
      block = 'modules';
      continue;
    }
    if (block === 'modules') {
      if (/^[A-Za-z0-9_.-]+$/.test(trimmed) && line.startsWith('    ')) {
        out.loadedModules.push(trimmed);
        continue;
      }
      block = 'none';
    }

    let m: RegExpExecArray | null;
    if (!out.obsVersion && (m = /^OBS (\d+\.\d+\.\d+\S*) \((\w+)\)/.exec(trimmed))) {
      out.obsVersion = m[1]!;
      out.platformTag = m[2]!;
    }
    if (!out.startedAt && (m = /^Current Date\/Time: (\d{4}-\d{2}-\d{2}), (\d{2}:\d{2}:\d{2})/.exec(trimmed))) {
      out.startedAt = `${m[1]}T${m[2]}`;
    }
    if (out.portable === undefined && (m = /^Portable mode: (true|false)/.exec(trimmed))) out.portable = m[1] === 'true';
    if (trimmed === 'Safe Mode enabled.' || /^\[Safe Mode\] Safe mode launch selected/.test(trimmed)) out.safeMode = true;
    if (/Third-party plugins disabled|only-bundled-plugins/i.test(trimmed)) out.onlyBundledPlugins = true;
    if (trimmed.startsWith('==== Shutting down') || /^Number of memory leaks: \d+/.test(trimmed)) out.cleanShutdown = true;
    if (trimmed === 'Crash or unclean shutdown detected') out.previousSessionUnclean = true;
    const perm = /^\[macOS\] Permission for (.+) (granted|denied)\.$/.exec(trimmed);
    if (perm) out.macPermissions[perm[1]!.replace(/ (\w)/g, (_m, c: string) => c.toUpperCase())] = perm[2] as 'granted' | 'denied';

    const lag = /skipped frames due to encoding lag: (\d+)\/(\d+)/i.exec(trimmed);
    if ((lag && Number(lag[1]) > 0) || /encod\w* (is )?overload/i.test(trimmed)) {
      if (out.encoderOverload.length < maxEach) out.encoderOverload.push(trimmed.slice(0, 300));
    }
    const drops = /dropped frames due to insufficient bandwidth\/connection stalls: (\d+)/i.exec(trimmed);
    if (drops && Number(drops[1]) > 0 && out.networkDrops.length < maxEach) out.networkDrops.push(trimmed.slice(0, 300));

    if (BENIGN.some((re) => re.test(trimmed))) continue;
    if (ERROR_RE.test(trimmed)) {
      if (out.errors.length < maxEach) {
        out.errors.push(trimmed.slice(0, 300));
        out.errorEntries.push({ time: /^(\d{2}:\d{2}:\d{2}\.\d{3})/.exec(raw)?.[1] ?? null, line: trimmed.slice(0, 300) });
      }
    } else if (WARN_RE.test(trimmed)) {
      if (out.warnings.length < maxEach) out.warnings.push(trimmed.slice(0, 300));
    }
  }
  return out;
}

export interface NewestLog {
  entry: FileEntry;
  text: string;
  parsed: ParsedLog;
}

export async function readNewestLog(paths: ObsPaths): Promise<NewestLog | null> {
  const logs = await listLogs(paths);
  const entry = logs[0];
  if (!entry) return null;
  const text = (await readText(entry.path)) ?? '';
  return { entry, text, parsed: parseLog(text) };
}

/** The newest log that actually contains an Available Encoders block (safe-mode logs may not). */
export async function readEncodersFromLogs(paths: ObsPaths, maxLogs = 5): Promise<{ file: string; video: EncoderEntry[]; audio: EncoderEntry[] } | null> {
  const logs = (await listLogs(paths)).slice(0, maxLogs);
  for (const entry of logs) {
    const text = await readText(entry.path);
    if (!text) continue;
    const parsed = parseLog(text);
    if (parsed.encoders.video.length > 0) return { file: entry.file, ...parsed.encoders };
  }
  return null;
}

export function platformOf(paths: ObsPaths): Platform {
  return paths.platform;
}
