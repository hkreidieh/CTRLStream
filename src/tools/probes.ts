/** Probe tools: system_info, obs_encoders, obs_devices, network_test. */
import { z } from 'zod';
import { networkFile } from '../diagnose/report.js';
import { encoderReport } from '../probes/encoders.js';
import { enumerateDevices } from '../probes/devices.js';
import { UPLOAD_URL } from '../probes/network.js';
import { writePrivateJson } from '../safety/store.js';
import { ToolError } from '../errors.js';
import { defineTool } from './registry.js';

export const systemInfo = defineTool({
  name: 'system_info',
  title: 'System info',
  description:
    "The machine OBS runs on: OS, CPU, RAM, GPUs (vendor, model, VRAM, driver where available) and displays (from OBS's GetMonitorList when connected, else from the OS). Changes nothing. Use it with obs_encoders to choose an encoder and with the knowledge tables to pick resolution and fps.",
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    const info = await ctx.system.info();
    let displays: unknown = info.displays;
    let displaysFrom = 'os';
    if (ctx.obs.connected) {
      const m = await ctx.obs.tryCall('GetMonitorList');
      if (m?.monitors?.length) {
        displaysFrom = 'obs';
        displays = m.monitors.map((x) => ({ index: x['monitorIndex'], name: x['monitorName'], width: x['monitorWidth'], height: x['monitorHeight'], x: x['monitorPositionX'], y: x['monitorPositionY'] }));
      }
    }
    return { os: info.os, cpu: info.cpu, memory: info.memory, gpus: info.gpus, displays, displaysFrom };
  },
});

export const obsEncoders = defineTool({
  name: 'obs_encoders',
  title: 'Available encoders',
  description:
    "Video and audio encoders OBS actually loaded on this machine, read from the 'Available Encoders' block of the newest OBS log, grouped by family (nvenc, amf, qsv, videotoolbox, x264, av1) with a one-line hint each, plus simpleStreamEncoders: the values output_set_simple accepts here. Cross-checks the GPUs and notes when a GPU's encoder is missing (usually a driver problem). Changes nothing. Needs OBS to have been launched at least once.",
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => ({ ...(await encoderReport(ctx)) }),
});

export const obsDevices = defineTool({
  name: 'obs_devices',
  title: 'Cameras, microphones, speakers, displays',
  description:
    "Devices OBS can see right now, with the ids input_create's deviceId expects: cameras, microphones, speakers and displays. It reuses an existing input of the right kind, or briefly creates a hidden probe input in a scratch scene (__ctrlstream_scratch) and removes it again; a camera light may blink. That cleanup means this does not count as a change and needs no backup. Needs a websocket connection.",
  input: {},
  mutating: false,
  fileWriting: false,
  handler: async (_args, ctx) => {
    await ctx.obs.ensure();
    return { ...(await enumerateDevices(ctx)) };
  },
});

export const networkTest = defineTool({
  name: 'network_test',
  title: 'Upload speed test (network)',
  description:
    'OPTIONAL and the only tool that uses the internet: it POSTs random bytes to https://speed.cloudflare.com/__up (Cloudflare) for about 10 seconds and reports the sustained upload speed in Mbps. No personal data is sent, but ask the user for consent first and say it will use some bandwidth. The result is remembered locally so diagnose can flag a bitrate above 70% of the upload.',
  input: {
    durationSeconds: z.number().int().min(5).max(20).optional().describe('Default 10'),
  },
  mutating: false,
  fileWriting: false,
  annotations: { openWorldHint: true },
  handler: async (args, ctx) => {
    const r = await ctx.network.uploadTest({ durationMs: (args.durationSeconds ?? 10) * 1000, url: UPLOAD_URL });
    if (r.bytes === 0 || r.seconds <= 0) throw new ToolError('NETWORK_ERROR', `The upload test sent nothing (${r.errors} failed requests).`, 'Check the internet connection, or skip the test and use the conservative defaults.');
    const uploadMbps = Math.round(((r.bytes * 8) / r.seconds / 1e6) * 10) / 10;
    const measuredAt = ctx.now().toISOString();
    await writePrivateJson(ctx, networkFile(ctx), { measuredAt, uploadMbps, seconds: r.seconds, bytes: r.bytes });
    return { uploadMbps, seconds: Math.round(r.seconds * 10) / 10, bytesSent: r.bytes, requests: r.requests, failedRequests: r.errors, seventyPercentKbps: Math.floor(uploadMbps * 700), endpoint: UPLOAD_URL, measuredAt };
  },
});

export const probeTools = [systemInfo, obsEncoders, obsDevices, networkTest];
