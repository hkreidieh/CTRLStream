/**
 * DESIGN 8 redaction test: with the dummy stream key set in OBS, in the profile's service.json and
 * leaked into a log line, and the websocket password in its config, call every tool and grep every
 * output, plus every file ctrlstream wrote (manifests, undo log, backup metadata, network result),
 * for the secrets. The byte-exact profile copies inside backups/ and snapshots/ are excluded on
 * purpose: they are restore material (DESIGN 5) and never appear in a tool result.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { DUMMY_KEY, SECRET_MARKERS, filesUnder, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

const ARGS: Record<string, Record<string, unknown>> = {
  get_started: { guide: 'setup' },
  knowledge: { file: 'platforms', platform: 'twitch' },
  obs_launch: {},
  obs_quit: {},
  network_test: { durationSeconds: 5 },
  scene_create: { name: 'BRB' },
  scene_remove: { name: 'BRB' },
  scene_set_current: { name: 'Live' },
  input_list: {},
  input_create: { name: 'Overlay', scene: 'Live', role: 'browser', settings: { url: `https://overlay.example/?token=${DUMMY_KEY}`, password: DUMMY_KEY } },
  input_remove: { name: 'Overlay' },
  input_settings_get: { name: 'Webcam' },
  input_settings_set: { name: 'Background', settings: { color: 1 } },
  input_properties: { name: 'Webcam' },
  input_audio_set: { name: 'Mic/Aux', volumeDb: -2 },
  scene_items: { scene: 'Live' },
  scene_item_transform_set: { scene: 'Live', source: 'Webcam', anchor: 'bottom-right', margin: 20, widthFraction: 0.25 },
  scene_item_visible_set: { scene: 'Live', source: 'Webcam', visible: true },
  scene_item_order_set: { scene: 'Live', source: 'Webcam', position: 'top' },
  filter_list: { source: 'Mic/Aux' },
  filter_add: { source: 'Mic/Aux', name: 'NS', kind: 'noise_suppress_filter_v2' },
  filter_set: { source: 'Mic/Aux', name: 'NS', enabled: false },
  filter_remove: { source: 'Mic/Aux', name: 'NS' },
  screenshot: { width: 320 },
  video_set: { fps: 60 },
  output_set_simple: { videoBitrateKbps: 5000 },
  output_set_advanced: { target: 'stream', settings: { bitrate: 6000 } },
  record_set: { format: 'mkv' },
  audio_set: { sampleRate: 48000 },
  stream_service_set: { type: 'rtmp_common', service: 'Twitch', key: DUMMY_KEY },
  replay_buffer_set: { active: false },
  virtual_camera_set: { active: false },
  test_record: { seconds: 3 },
  snapshot_save: { label: 'known-good' },
  snapshot_restore: { snapshotId: '__latest__' },
  logs_tail: { lines: 400 },
};

let h: Harness;
afterAll(async () => h?.cleanup());

describe('no secret leaves through any tool', () => {
  it('calls every tool and finds no key or password in any output or written file', async () => {
    h = await makeHarness();
    const log = path.join(h.configDir, 'logs', '2026-10-11 01-50-57.txt');
    appendFileSync(log, `12:00:00.000: [rtmp stream: 'simple_stream'] Connecting to RTMP URL rtmp://live.twitch.tv/app/${DUMMY_KEY}...\n`);
    let snapshotId = '';
    const order = ALL_TOOLS.map((t) => t.name).filter((n) => n !== 'obs_quit' && n !== 'obs_launch' && n !== 'snapshot_restore' && n !== 'output_set_advanced' && n !== 'audio_set' && n !== 'obs_connect');
    for (const name of order) {
      const out = await h.callRaw(name, ARGS[name] ?? {});
      if (name === 'snapshot_save') snapshotId = String(out.json['id']);
    }
    // File tools and the session tools need OBS closed / restarted.
    await h.callRaw('obs_quit');
    await h.callRaw('obs_connect');
    await h.callRaw('output_set_advanced', ARGS['output_set_advanced']!);
    await h.callRaw('audio_set', ARGS['audio_set']!);
    await h.callRaw('snapshot_restore', { snapshotId });
    await h.callRaw('undo_last');
    await h.callRaw('diagnose');
    await h.callRaw('obs_status');
    await h.callRaw('obs_launch');
    await h.callRaw('diagnose');

    // Every tool was called.
    expect(h.outputs.length).toBeGreaterThanOrEqual(ALL_TOOLS.length);
    // callRaw already throws on a leak; check the whole transcript once more.
    const all = h.outputs.join('\n');
    for (const m of SECRET_MARKERS) expect(all.includes(m), m.slice(0, 8)).toBe(false);
    // The leaked log line came back scrubbed rather than missing.
    expect(all).toContain('rtmp://live.twitch.tv/app/<redacted>');

    // Files ctrlstream wrote: everything except byte-exact profile/scene copies.
    const written = filesUnder(h.dataDir).filter((f) => !/[/\\](profile|scenes)[/\\]/.test(f));
    expect(written.some((f) => f.endsWith('manifest.json'))).toBe(true);
    expect(written.some((f) => f.endsWith('.jsonl'))).toBe(true);
    expect(written.some((f) => f.endsWith('backup.json'))).toBe(true);
    for (const f of written) {
      const text = readFileSync(f, 'utf8');
      for (const m of SECRET_MARKERS) expect(text.includes(m), `${path.basename(f)} contains a secret`).toBe(false);
    }
  });
});
