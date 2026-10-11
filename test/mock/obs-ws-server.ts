/**
 * A mock obs-websocket v5 server over `ws` (DESIGN 8): Hello (op 0, with optional auth challenge
 * and salt), Identify (op 1, validates the sha256 base64 chain), Identified (op 2), Request (op 6)
 * and RequestResponse (op 7), RequestBatch (op 8/9) and Events (op 5). Backed by ObsModel.
 * Close codes follow protocol.md WebSocketCloseCode.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { ObsModel } from './obs-model.js';

const sha256b64 = (s: string) => createHash('sha256').update(s).digest('base64');

export interface MockServerOptions {
  password?: string | null;
  model?: ObsModel;
}

export class MockObsServer {
  readonly model: ObsModel;
  password: string | null;
  port = 0;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  identified = new Set<WebSocket>();
  connections = 0;
  authFailures = 0;

  constructor(opts: MockServerOptions = {}) {
    this.model = opts.model ?? new ObsModel();
    this.password = opts.password === undefined ? 'dummyWsPassw0rd-NotReal' : opts.password;
  }

  get running(): boolean {
    return this.wss !== null;
  }

  async start(port = 0): Promise<number> {
    if (this.wss) return this.port;
    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port: port || this.port || 0,
      handleProtocols: (protocols) => (protocols.has('obswebsocket.json') ? 'obswebsocket.json' : false),
    });
    await new Promise<void>((resolve, reject) => {
      this.wss!.once('listening', resolve);
      this.wss!.once('error', reject);
    });
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on('connection', (ws) => this.onConnection(ws));
    return this.port;
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    this.wss = null;
    for (const c of this.clients) c.terminate();
    this.clients.clear();
    this.identified.clear();
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
  }

  /** Drop every connection as a crash would. */
  crash(): void {
    for (const c of this.clients) c.terminate();
  }

  emit(eventType: string, eventData: Record<string, unknown> = {}, eventIntent = 64): void {
    for (const c of this.identified) c.send(JSON.stringify({ op: 5, d: { eventType, eventIntent, eventData } }));
  }

  private onConnection(ws: WebSocket): void {
    this.connections++;
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      this.identified.delete(ws);
    });
    const salt = randomBytes(32).toString('base64');
    const challenge = randomBytes(32).toString('base64');
    const hello: Record<string, unknown> = { obsStudioVersion: this.model.version.obsVersion, obsWebSocketVersion: this.model.version.obsWebSocketVersion, rpcVersion: 1 };
    if (this.password !== null) hello['authentication'] = { challenge, salt };
    ws.send(JSON.stringify({ op: 0, d: hello }));
    ws.on('message', (raw) => {
      let msg: { op: number; d: Record<string, unknown> };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.close(4002, 'MessageDecodeError');
        return;
      }
      if (msg.op === 1) {
        if (this.identified.has(ws)) return ws.close(4008, 'AlreadyIdentified');
        if (this.password !== null) {
          const expected = sha256b64(sha256b64(this.password + salt) + challenge);
          if (msg.d['authentication'] !== expected) {
            this.authFailures++;
            return ws.close(4009, 'Authentication failed.');
          }
        }
        if (msg.d['rpcVersion'] !== 1) return ws.close(4010, 'UnsupportedRpcVersion');
        this.identified.add(ws);
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (!this.identified.has(ws)) return ws.close(4007, 'NotIdentified');
      if (msg.op === 6) {
        const { requestType, requestId, requestData } = msg.d as { requestType: string; requestId: string; requestData?: Record<string, unknown> };
        let reply;
        try {
          reply = this.model.handle(requestType, requestData ?? {});
        } catch {
          // The model asked for a crash (see ObsModel.crashOnListKinds).
          this.crash();
          return;
        }
        ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: reply.status, ...(reply.data ? { responseData: reply.data } : {}) } }));
        return;
      }
      if (msg.op === 8) {
        const { requestId, requests } = msg.d as { requestId: string; requests: Array<{ requestType: string; requestId?: string; requestData?: Record<string, unknown> }> };
        const results = requests.map((r) => {
          const reply = this.model.handle(r.requestType, r.requestData ?? {});
          return { requestType: r.requestType, requestId: r.requestId, requestStatus: reply.status, ...(reply.data ? { responseData: reply.data } : {}) };
        });
        ws.send(JSON.stringify({ op: 9, d: { requestId, results } }));
        return;
      }
      ws.close(4006, 'UnknownOpCode');
    });
  }
}
