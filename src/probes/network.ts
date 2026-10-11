/**
 * The only network call ctrlstream makes, and only when network_test is called: POST random
 * bytes to Cloudflare's speed test endpoint for about 10 seconds and report sustained upload.
 */
import { randomBytes } from 'node:crypto';

export const UPLOAD_URL = 'https://speed.cloudflare.com/__up';

export interface UploadResult {
  bytes: number;
  seconds: number;
  requests: number;
  errors: number;
}

export interface NetworkProbe {
  uploadTest(opts: { durationMs: number; url: string }): Promise<UploadResult>;
}

const CHUNK = 2 * 1024 * 1024;
const WORKERS = 3;

export const realNetworkProbe: NetworkProbe = {
  async uploadTest({ durationMs, url }) {
    const body = randomBytes(CHUNK);
    const start = Date.now();
    const deadline = start + durationMs;
    let bytes = 0;
    let requests = 0;
    let errors = 0;
    const worker = async () => {
      while (Date.now() < deadline && errors < 6) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now() + 2000));
        try {
          const res = await fetch(url, { method: 'POST', body, signal: ctrl.signal, headers: { 'content-type': 'application/octet-stream' } });
          await res.arrayBuffer().catch(() => undefined);
          if (res.ok) {
            bytes += CHUNK;
            requests++;
          } else errors++;
        } catch {
          errors++;
        } finally {
          clearTimeout(t);
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    return { bytes, seconds: (Date.now() - start) / 1000, requests, errors };
  },
};
