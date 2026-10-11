/**
 * obs-websocket v5 client: connect, reconnect, auth, typed requests.
 *
 * Zero-config: host, port and password are read from plugin_config/obs-websocket/config.json at
 * every connect (DESIGN 3.3), unless CTRLSTREAM_OBS_HOST / CTRLSTREAM_OBS_PORT / CTRLSTREAM_OBS_PASSWORD override them (the
 * .mcpb user_config). Request names and fields are typed by obs-websocket-js, which mirrors the
 * protocol document (docs/generated/protocol.md in obsproject/obs-websocket).
 */
import { OBSWebSocket, OBSWebSocketError } from 'obs-websocket-js/json';
import type { OBSRequestTypes, OBSResponseTypes } from 'obs-websocket-js/json';
import { ToolError, notConnected } from '../errors.js';
import type { SecretRegistry } from '../safety/redact.js';
import { readWebsocketConfig } from './files.js';
import type { ObsPaths } from './paths.js';

export type RequestName = keyof OBSRequestTypes;

export interface ConnectOverrides {
  host?: string | undefined;
  port?: number | undefined;
  password?: string | undefined;
}

export interface ConnectionInfo {
  url: string;
  obsVersion: string;
  obsWebSocketVersion: string;
  rpcVersion: number;
  authUsed: boolean;
  source: 'override' | 'config';
}

export interface VersionInfo {
  obsVersion: string;
  obsWebSocketVersion: string;
  rpcVersion: number;
  availableRequests: string[];
  supportedImageFormats: string[];
  platform: string;
  platformDescription: string;
}

/** obs-websocket RequestStatus codes -> our error codes (protocol.md, RequestStatus enum). */
export function mapRequestError(requestType: string, err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof OBSWebSocketError) {
    const c = err.code;
    const msg = `${requestType} failed: ${err.message || 'no comment from OBS'} (obs-websocket status ${c})`;
    if (c === 600) return new ToolError('NOT_FOUND', msg, 'Check the exact name with the matching list tool (scene_list, input_list, scene_items, filter_list).', undefined, c);
    if (c === 601) return new ToolError('ALREADY_EXISTS', msg, 'Something with that name already exists. Pick another name or reuse the existing one.', undefined, c);
    if (c === 500) return new ToolError('OUTPUT_ACTIVE', msg, 'An output (stream, recording, replay buffer or virtual camera) is running. Stop it first, or wait until it has stopped.', 'stream_status', c);
    if (c === 501) return new ToolError('OUTPUT_NOT_ACTIVE', msg, 'That output is not running.', 'stream_status', c);
    if (c === 204) return new ToolError('UNSUPPORTED', msg, 'This OBS version does not support that request. Check obs_status for the OBS version.', 'obs_status', c);
    if (c === 207) return new ToolError('OBS_REQUEST_FAILED', msg, 'OBS is busy (switching profile or scene collection). Wait a moment and retry.', undefined, c);
    if (c >= 300 && c < 500) return new ToolError('INVALID_ARGUMENT', msg, 'OBS rejected a value. Check the field named in the message against input_properties or the tool description.', undefined, c);
    if (c >= 1000 || c === -1) return notConnected(err.message);
    return new ToolError('OBS_REQUEST_FAILED', msg, 'OBS could not do that. Read the message, check the current state with the matching get/list tool, then retry once.', undefined, c);
  }
  const e = err as NodeJS.ErrnoException;
  if (e && typeof e.message === 'string' && /not connected|socket|closed/i.test(e.message)) return notConnected(e.message);
  return new ToolError('INTERNAL', `${requestType} failed: ${(err as Error)?.message ?? String(err)}`, 'Unexpected websocket failure. Call obs_status.', 'obs_status');
}

export interface ObsClientOptions {
  overrides?: ConnectOverrides;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** How long to keep retrying 207 NotReady answers. */
  notReadyRetryMs?: number;
  /** Test seam. */
  factory?: () => OBSWebSocket;
}

export class ObsClient {
  private ws: OBSWebSocket | null = null;
  private _connected = false;
  private versionCache: VersionInfo | null = null;
  private lastInfo: ConnectionInfo | null = null;
  private connecting: Promise<ConnectionInfo> | null = null;
  lastError: ToolError | null = null;

  constructor(
    private readonly paths: ObsPaths,
    private readonly secrets: SecretRegistry,
    private readonly opts: ObsClientOptions = {},
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  get info(): ConnectionInfo | null {
    return this._connected ? this.lastInfo : null;
  }

  async target(): Promise<{ url: string; password?: string; source: 'override' | 'config'; serverEnabled: boolean; configExists: boolean }> {
    const cfg = await readWebsocketConfig(this.paths, this.secrets);
    const o = this.opts.overrides ?? {};
    const host = o.host || '127.0.0.1';
    const port = o.port || cfg.serverPort || 4455;
    const password = o.password ?? (cfg.authRequired ? cfg.password : undefined);
    if (o.password) this.secrets.add(o.password);
    const source = o.host || o.port || o.password ? 'override' : 'config';
    const t: { url: string; password?: string; source: 'override' | 'config'; serverEnabled: boolean; configExists: boolean } = {
      url: `ws://${host}:${port}`,
      source,
      serverEnabled: cfg.serverEnabled,
      configExists: cfg.exists,
    };
    if (password) t.password = password;
    return t;
  }

  /** Connect (or reconnect). Rejects with a ToolError; never leaks the password. */
  async connect(): Promise<ConnectionInfo> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<ConnectionInfo> {
    await this.disconnect();
    const t = await this.target();
    const ws = this.opts.factory ? this.opts.factory() : new OBSWebSocket();
    ws.on('ConnectionClosed', () => {
      if (this.ws === ws) {
        this._connected = false;
        this.versionCache = null;
      }
    });
    // Without a listener eventemitter3 is fine, but keep errors from surfacing as unhandled.
    ws.on('ConnectionError', () => undefined);
    const timeoutMs = this.opts.connectTimeoutMs ?? 4000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const hello = await Promise.race([
        ws.connect(t.url, t.password, { rpcVersion: 1 }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ToolError('TIMEOUT', `Timed out after ${timeoutMs} ms connecting to ${t.url}`, 'OBS may be starting up or stuck on a dialog. Wait a few seconds and call obs_connect again.', 'obs_status')), timeoutMs);
        }),
      ]);
      this.ws = ws;
      this._connected = true;
      this.lastError = null;
      this.lastInfo = {
        url: t.url,
        obsVersion: (hello as { obsStudioVersion?: string }).obsStudioVersion ?? '',
        obsWebSocketVersion: hello.obsWebSocketVersion,
        rpcVersion: hello.negotiatedRpcVersion,
        authUsed: !!t.password,
        source: t.source,
      };
      return this.lastInfo;
    } catch (err) {
      try {
        await ws.disconnect();
      } catch {
        /* ignore */
      }
      const te = this.connectError(err, t.url, t.serverEnabled, t.configExists);
      this.lastError = te;
      throw te;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private connectError(err: unknown, url: string, serverEnabled: boolean, configExists: boolean): ToolError {
    if (err instanceof ToolError) return err;
    const code = err instanceof OBSWebSocketError ? err.code : undefined;
    if (code === 4009) {
      return new ToolError(
        'WEBSOCKET_AUTH_FAILED',
        'OBS rejected the websocket password.',
        'The password in OBS (Tools > WebSocket Server Settings) no longer matches its config file, or CTRLSTREAM_OBS_PASSWORD is wrong. Ask the user to open that dialog and click Apply, then call obs_connect again.',
        'obs_connect',
        code,
      );
    }
    if (!serverEnabled && configExists) {
      return new ToolError(
        'WEBSOCKET_DISABLED',
        `The OBS websocket server is turned off, so ${url} is not reachable.`,
        'Call obs_quit, then obs_connect: with OBS closed it turns the server on in the config file. Then obs_launch.',
        'obs_quit',
        code,
      );
    }
    return new ToolError(
      'WEBSOCKET_UNREACHABLE',
      `Could not reach OBS at ${url}${err instanceof Error && err.message ? `: ${err.message}` : ''}.`,
      'Call obs_status to see whether OBS is running and the websocket is enabled.',
      'obs_status',
      code,
    );
  }

  async disconnect(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    this._connected = false;
    this.versionCache = null;
    if (ws) {
      try {
        await ws.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  /** Connect if needed (once). Throws OBS_NOT_CONNECTED style errors. */
  async ensure(): Promise<void> {
    if (this._connected) return;
    await this.connect();
  }

  async call<T extends RequestName>(requestType: T, data?: OBSRequestTypes[T]): Promise<OBSResponseTypes[T]> {
    await this.ensure();
    const ws = this.ws!;
    const timeoutMs = this.opts.requestTimeoutMs ?? 15_000;
    // Right after the websocket opens, OBS answers 207 NotReady while it is still loading the
    // scene collection (seen on the real OBS 32.2.2), and again while switching profile or
    // collection. Retry those for a few seconds before giving up.
    const notReadyUntil = Date.now() + (this.opts.notReadyRetryMs ?? 8_000);
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      try {
        return (await Promise.race([
          (ws.call as (t: string, d?: unknown) => Promise<unknown>)(requestType, data),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ToolError('TIMEOUT', `${requestType} did not answer within ${timeoutMs} ms`, 'OBS may be frozen, busy, or showing a dialog. Call obs_status.', 'obs_status')), timeoutMs);
          }),
        ])) as OBSResponseTypes[T];
      } catch (err) {
        if (err instanceof OBSWebSocketError && err.code === 207 && Date.now() < notReadyUntil) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        throw mapRequestError(requestType, err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  /** Same as call() but resolves undefined instead of throwing. For best-effort probes. */
  async tryCall<T extends RequestName>(requestType: T, data?: OBSRequestTypes[T]): Promise<OBSResponseTypes[T] | undefined> {
    try {
      return await this.call(requestType, data);
    } catch {
      return undefined;
    }
  }

  async version(): Promise<VersionInfo> {
    if (this.versionCache) return this.versionCache;
    const v = await this.call('GetVersion');
    this.versionCache = {
      obsVersion: v.obsVersion,
      obsWebSocketVersion: v.obsWebSocketVersion,
      rpcVersion: v.rpcVersion,
      availableRequests: v.availableRequests,
      supportedImageFormats: v.supportedImageFormats,
      platform: v.platform,
      platformDescription: v.platformDescription,
    };
    return this.versionCache;
  }

  /** Subscribe to an event for the lifetime of the current connection. */
  on(event: string, handler: (data: unknown) => void): () => void {
    const ws = this.ws;
    if (!ws) return () => undefined;
    (ws.on as (e: string, h: (d: unknown) => void) => void)(event, handler);
    return () => (ws.off as (e: string, h: (d: unknown) => void) => void)(event, handler);
  }
}
