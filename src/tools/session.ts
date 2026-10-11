/** Session tools: obs_status, obs_connect, obs_launch, obs_quit. */
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ToolError } from '../errors.js';
import { enableWebsocketConfig } from '../obs/discovery.js';
import { findProfile, findSceneCollection, listLogs, listProfiles, listSceneCollections, listSentinels, parseLog, readActiveSelection, readText, readWebsocketConfig } from '../obs/files.js';
import { recordClosedState } from '../diagnose/closed-state.js';
import { crashCheck } from '../diagnose/report.js';
import { defineTool } from './registry.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryConnect(ctx: Ctx): Promise<{ connected: boolean; error?: { code: string; message: string } }> {
  if (ctx.obs.connected) return { connected: true };
  try {
    await ctx.obs.connect();
    return { connected: true };
  } catch (e) {
    const te = e as ToolError;
    return { connected: false, error: { code: te.code ?? 'INTERNAL', message: te.message } };
  }
}

export const obsStatus = defineTool({
  name: 'obs_status',
  title: 'OBS status',
  description:
    'Start here. Reports whether OBS is running (pid), its version, whether the websocket is enabled and reachable (it connects automatically when it can), the active profile and scene collection, the config dir, the platform, when OBS last started, whether a crash report is newer than that start, and whether the last session ended uncleanly. Changes nothing. Next: if not running, obs_launch; if running but the websocket is off, obs_quit then obs_connect; if crashSinceLastStart is true, diagnose.',
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    const proc = await ctx.proc.find();
    if (!proc) await recordClosedState(ctx).catch(() => null);
    const ws = await readWebsocketConfig(ctx.paths, ctx.secrets);
    let conn: Awaited<ReturnType<typeof tryConnect>> = { connected: false };
    if (proc && (ws.serverEnabled || ctx.obs.connected)) conn = await tryConnect(ctx);
    if (!proc && ctx.obs.connected) await ctx.obs.disconnect();
    const sel = await readActiveSelection(ctx.paths);
    let profile = sel.profileName ?? null;
    let collection = sel.collectionName ?? null;
    let version: string | null = null;
    if (conn.connected) {
      const [pl, cl, v] = await Promise.all([ctx.obs.tryCall('GetProfileList'), ctx.obs.tryCall('GetSceneCollectionList'), ctx.obs.version().catch(() => null)]);
      profile = pl?.currentProfileName ?? profile;
      collection = cl?.currentSceneCollectionName ?? collection;
      version = v?.obsVersion ?? null;
    }
    const logs = await listLogs(ctx.paths);
    const newest = logs[0];
    const parsed = newest ? parseLog((await readText(newest.path)) ?? '') : null;
    const crash = await crashCheck(ctx, !!proc);
    return {
      running: !!proc,
      pid: proc?.pid ?? null,
      obsVersion: version ?? parsed?.obsVersion ?? null,
      websocket: {
        configFound: ws.exists,
        enabled: ws.serverEnabled,
        port: ws.serverPort,
        authRequired: ws.authRequired,
        connected: conn.connected,
        ...(conn.error ? { error: conn.error } : {}),
      },
      profile,
      sceneCollection: collection,
      configDir: ctx.paths.configDir,
      configFound: ctx.paths.configExists,
      configSource: ctx.paths.configSource,
      platform: ctx.paths.platform,
      obsBinary: ctx.proc.binary(),
      lastStart: crash.lastStart?.toISOString() ?? null,
      safeMode: !!proc && !!parsed?.safeMode,
      crashSinceLastStart: crash.newerThanStart,
      previousSessionCrashed: crash.previousSessionCrashed,
      newestCrashReport: crash.newestCrash ? { file: crash.newestCrash.file, at: new Date(crash.newestCrash.mtimeMs).toISOString() } : null,
      uncleanShutdown: crash.uncleanShutdown,
      firstRunDone: sel.firstRunDone ?? null,
      ...(Object.keys(parsed?.macPermissions ?? {}).length ? { macPermissions: parsed!.macPermissions } : {}),
    };
  },
});

export const obsConnect = defineTool({
  name: 'obs_connect',
  title: 'Connect to OBS',
  description:
    "Connect (or reconnect) to OBS's websocket, reading host, port and password from OBS's own websocket config every time, so there is nothing for the user to type. If OBS is closed and its websocket server is turned off, this turns it on in the config file (generating a strong password that stays in that file) and returns nextStep obs_launch; that branch writes an OBS config file and so only works with OBS closed. If OBS is running with the websocket off, it fails and names obs_quit. After connecting, call obs_status or the tool you needed.",
  input: {},
  mutating: false,
  fileWriting: true,
  handler: async (_args, ctx) => {
    const proc = await ctx.proc.find();
    const ws = await readWebsocketConfig(ctx.paths, ctx.secrets);
    if (!proc) {
      if (!ctx.paths.configExists) {
        throw new ToolError('CONFIG_NOT_FOUND', `No OBS config dir at ${ctx.paths.configDir}: OBS has never been started on this account.`, 'Call obs_launch once so OBS creates its config, then obs_quit and obs_connect.', 'obs_launch');
      }
      if (!ws.serverEnabled || !ws.exists) {
        const r = await enableWebsocketConfig(ctx);
        return { connected: false, websocketEnabled: true, configChanged: r.changed, passwordGenerated: r.passwordGenerated, port: r.port, nextStep: 'obs_launch', note: 'OBS is closed. The websocket is now enabled in its config; launch OBS to connect.' };
      }
      throw new ToolError('OBS_NOT_RUNNING', 'OBS is not running, so there is nothing to connect to.', 'Call obs_launch; it connects automatically once OBS is up.', 'obs_launch');
    }
    if (!ws.serverEnabled && ws.exists) {
      throw new ToolError('WEBSOCKET_DISABLED', 'OBS is running with its websocket server turned off.', 'Call obs_quit, then obs_connect (with OBS closed it enables the server in the config), then obs_launch. Or ask the user to tick Tools > WebSocket Server Settings > Enable.', 'obs_quit');
    }
    const info = await ctx.obs.connect();
    return { connected: true, url: info.url, obsVersion: info.obsVersion, obsWebSocketVersion: info.obsWebSocketVersion, rpcVersion: info.rpcVersion, authUsed: info.authUsed, settingsFrom: info.source };
  },
});

export const obsLaunch = defineTool({
  name: 'obs_launch',
  title: 'Launch OBS',
  description:
    "Start OBS and wait up to 30 s for its websocket, then connect. Options: profile and collection start OBS on that profile/scene collection (they must exist; use this after snapshot_restore); safeMode starts OBS without third-party plugins, scripts AND without the websocket (OBS's own rule), so after a safe-mode launch only obs_status, diagnose (files and logs), logs_tail and obs_quit work; onlyBundledPlugins also disables third-party plugins but keeps the websocket, which is usually the better triage mode. If OBS is already running it only connects. If it times out, OBS is probably waiting on a dialog (crash recovery question, first-run wizard): ask the user to look at the OBS window.",
  input: {
    profile: z.string().min(1).optional().describe('Profile name to start with'),
    collection: z.string().min(1).optional().describe('Scene collection name to start with'),
    safeMode: z.boolean().optional().describe('OBS --safe-mode: no third-party plugins, scripts or websocket'),
    onlyBundledPlugins: z.boolean().optional().describe('OBS --only-bundled-plugins: no third-party plugins, websocket stays on'),
  },
  mutating: false,
  fileWriting: false,
  handler: async (args, ctx) => {
    const existing = await ctx.proc.find();
    if (existing) {
      const conn = await tryConnect(ctx);
      return { launched: false, alreadyRunning: true, pid: existing.pid, connected: conn.connected, ...(conn.error ? { websocketError: conn.error } : {}), note: args.profile || args.collection || args.safeMode ? 'OBS was already running, so the launch options were not applied. obs_quit first to relaunch with them.' : undefined };
    }
    if (args.safeMode && args.onlyBundledPlugins) throw new ToolError('INVALID_ARGUMENT', 'Choose safeMode or onlyBundledPlugins, not both.', 'onlyBundledPlugins keeps the websocket; prefer it for triage.');
    if (args.profile && !(await findProfile(ctx.paths, args.profile))) {
      const names = (await listProfiles(ctx.paths)).map((p) => p.name);
      throw new ToolError('NOT_FOUND', `No OBS profile named '${args.profile}'.`, `Existing profiles: ${names.join(', ') || 'none'}.`);
    }
    if (args.collection && !(await findSceneCollection(ctx.paths, args.collection))) {
      const names = (await listSceneCollections(ctx.paths)).map((c) => c.name);
      throw new ToolError('NOT_FOUND', `No scene collection named '${args.collection}'.`, `Existing collections: ${names.join(', ') || 'none'}.`);
    }
    if (!ctx.proc.binary()) throw new ToolError('LAUNCH_FAILED', 'OBS Studio does not seem to be installed in the usual place.', 'Ask the user to install OBS Studio from obsproject.com, or to start it themselves, then call obs_connect.');
    const uncleanBefore = (await listSentinels(ctx.paths)).length > 0;
    // OBS may rewrite parts of the profile as it starts (an unloadable encoder becomes x264): keep
    // what the files said, so diagnose can still report it after the launch.
    await recordClosedState(ctx).catch(() => null);
    const ws = await readWebsocketConfig(ctx.paths, ctx.secrets);
    try {
      await ctx.proc.launch(args);
    } catch (e) {
      throw new ToolError('LAUNCH_FAILED', `Could not start OBS: ${(e as Error).message}`, 'Ask the user to start OBS themselves, then call obs_connect.');
    }
    const deadline = Date.now() + ctx.timing.launchTimeoutMs;
    let proc = null;
    while (Date.now() < deadline && !(proc = await ctx.proc.find())) await sleep(ctx.timing.pollMs);
    if (!proc) throw new ToolError('LAUNCH_FAILED', 'OBS did not start.', 'Ask the user to start OBS themselves and tell you what they see.');
    const base = { launched: true, pid: proc.pid, safeMode: !!args.safeMode, onlyBundledPlugins: !!args.onlyBundledPlugins, profile: args.profile ?? null, collection: args.collection ?? null };
    if (args.safeMode) {
      return { ...base, connected: false, websocketAvailable: false, note: 'Safe Mode disables the websocket. Use obs_status, diagnose and logs_tail for triage, then obs_quit and obs_launch normally.' };
    }
    if (!ws.serverEnabled) {
      return { ...base, connected: false, websocketAvailable: false, note: 'The websocket server is disabled in OBS. Call obs_quit, obs_connect (enables it with OBS closed), then obs_launch.', suggestedTool: 'obs_quit' };
    }
    let last: Awaited<ReturnType<typeof tryConnect>> = { connected: false };
    while (Date.now() < deadline) {
      last = await tryConnect(ctx);
      if (last.connected) {
        // The socket opens before OBS has loaded its scene collection (207 NotReady); the client
        // retries those, so this returns once OBS really answers.
        const v = await ctx.obs.version().catch(() => null);
        await ctx.obs.tryCall('GetSceneList');
        return { ...base, connected: true, obsVersion: v?.obsVersion ?? null };
      }
      if (last.error?.code === 'WEBSOCKET_AUTH_FAILED') break;
      await sleep(ctx.timing.pollMs);
    }
    throw new ToolError(
      last.error?.code === 'WEBSOCKET_AUTH_FAILED' ? 'WEBSOCKET_AUTH_FAILED' : 'TIMEOUT',
      `OBS started (pid ${proc.pid}) but its websocket did not answer within ${Math.round(ctx.timing.launchTimeoutMs / 1000)} s.`,
      uncleanBefore
        ? 'OBS did not shut down cleanly last time, so it is probably showing its "OBS Studio Crash Detected" dialog. Ask the user to click "Run in Normal Mode", then call obs_connect.'
        : 'OBS is probably showing a dialog (first-run wizard, missing files, update prompt). Ask the user to close it, then call obs_connect.',
      'obs_connect',
    );
  },
});

export const obsQuit = defineTool({
  name: 'obs_quit',
  title: 'Quit OBS',
  description:
    "Close OBS gracefully (macOS: quit request, then SIGTERM, which OBS also handles cleanly; Windows: a normal close request; Linux: SIGTERM) and wait for it to exit, so its config is saved and files can be edited. Refuses while streaming or recording unless force is true. force also allows a hard kill as the last step, which can make OBS ask about Safe Mode on next launch; use it only if the user agrees. Returns escalated: none, sigterm or force. Next: the file tool you needed, then obs_launch.",
  input: {
    force: z.boolean().optional().describe('Quit even if outputs are active, and kill OBS if it will not close'),
    timeoutSeconds: z.number().int().min(5).max(120).optional(),
  },
  mutating: false,
  fileWriting: false,
  annotations: { destructiveHint: true },
  handler: async (args, ctx) => {
    const proc = await ctx.proc.find();
    if (!proc) {
      await ctx.obs.disconnect();
      return { wasRunning: false, exited: true, escalated: 'none' };
    }
    if (!args.force && (ctx.obs.connected || (await tryConnect(ctx)).connected)) {
      const [st, rc] = await Promise.all([ctx.obs.tryCall('GetStreamStatus'), ctx.obs.tryCall('GetRecordStatus')]);
      const active = [st?.outputActive ? 'stream' : null, rc?.outputActive ? 'recording' : null].filter(Boolean);
      if (active.length) {
        throw new ToolError('OUTPUT_ACTIVE', `OBS is ${active.join(' and ')} right now; quitting would end it.`, 'Ask the user first. Then stream_stop / record_stop, or obs_quit with force: true.', active[0] === 'stream' ? 'stream_stop' : 'record_stop');
      }
    }
    await ctx.obs.disconnect();
    const r = await ctx.proc.quit(proc, { timeoutMs: (args.timeoutSeconds ?? ctx.timing.quitTimeoutMs / 1000) * 1000, force: !!args.force });
    if (!r.exited) {
      throw new ToolError('QUIT_FAILED', `OBS (pid ${proc.pid}) did not exit after ${Math.round(r.waitedMs / 1000)} s${r.detail ? ` (${r.detail})` : ''}.`, 'OBS is probably showing a dialog asking to confirm. Ask the user to look at OBS, or call obs_quit with force: true if they agree.', 'obs_quit');
    }
    return { wasRunning: true, exited: true, escalated: r.escalated, waitedMs: r.waitedMs, ...(r.escalated === 'force' ? { warning: 'OBS was killed; it may offer Safe Mode on next launch. Choose Launch Normally.' } : {}) };
  },
});

export const sessionTools = [obsStatus, obsConnect, obsLaunch, obsQuit];
