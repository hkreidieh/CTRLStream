import { describe, expect, it } from 'vitest';
import { computeFindings } from '../../src/diagnose/findings.js';
import type { FindingInput } from '../../src/diagnose/findings.js';
import { matchPlatform, uploadHeadroom } from '../../src/diagnose/platforms.js';
import { EMBEDDED_KNOWLEDGE } from '../../src/knowledge.js';

const base = (): FindingInput => ({
  running: true,
  websocket: { configEnabled: true, configExists: true, connected: true },
  log: null,
  crashNewerThanStart: null,
  uncleanShutdown: false,
  stats: { renderSkipped: 0, renderTotal: 1000, outputSkipped: 0, outputTotal: 1000, diskFreeMb: 100000 },
  stream: { active: false, reconnecting: false, congestion: 0, skipped: 0, total: 0 },
  state: null,
  missingDevices: [],
  knownGood: null,
  encodersInLog: [],
  platformCap: null,
  lastUploadMbps: null,
  uploadHeadroom: 0.7,
  sceneSourceIssues: [],
});
const codes = (f: FindingInput) => computeFindings(f).map((x) => x.code);

describe('finding rules (DESIGN 6 thresholds)', () => {
  it('nothing on a healthy setup', () => expect(codes(base())).toEqual([]));

  it('ENCODER_OVERLOAD at > 2% encoder skips with low congestion, not at 2%', () => {
    expect(codes({ ...base(), stats: { ...base().stats!, outputSkipped: 21, outputTotal: 1000 } })).toContain('ENCODER_OVERLOAD');
    expect(codes({ ...base(), stats: { ...base().stats!, outputSkipped: 20, outputTotal: 1000 } })).not.toContain('ENCODER_OVERLOAD');
    expect(codes({ ...base(), stats: { ...base().stats!, outputSkipped: 50, outputTotal: 1000 }, stream: { active: true, reconnecting: false, congestion: 0.8, skipped: 0, total: 1 } })).not.toContain('ENCODER_OVERLOAD');
  });

  it('NETWORK_DROPS above 0.3 congestion or reconnecting', () => {
    expect(codes({ ...base(), stream: { active: true, reconnecting: false, congestion: 0.31, skipped: 5, total: 100 } })).toContain('NETWORK_DROPS');
    expect(codes({ ...base(), stream: { active: true, reconnecting: true, congestion: 0, skipped: 0, total: 100 } })).toContain('NETWORK_DROPS');
    expect(codes({ ...base(), stream: { active: true, reconnecting: false, congestion: 0.3, skipped: 0, total: 100 } })).not.toContain('NETWORK_DROPS');
  });

  it('RENDER_LAG above 1%', () => {
    expect(codes({ ...base(), stats: { ...base().stats!, renderSkipped: 11 } })).toContain('RENDER_LAG');
    expect(codes({ ...base(), stats: { ...base().stats!, renderSkipped: 10 } })).not.toContain('RENDER_LAG');
  });

  it('DISK_LOW under 5 GB with a recording path', () => {
    const state = { output: { recPath: '/x', videoBitrateKbps: 6000, effectiveVideoBitrateKbps: 6000, audioBitrateKbps: 160, mode: 'Simple', encoder: 'x264' } } as never;
    expect(codes({ ...base(), state, stats: { ...base().stats!, diskFreeMb: 5119 } })).toContain('DISK_LOW');
    expect(codes({ ...base(), state, stats: { ...base().stats!, diskFreeMb: 5120 } })).not.toContain('DISK_LOW');
  });

  it('BITRATE_ABOVE_UPLOAD uses video plus audio against 70%', () => {
    const state = { output: { recPath: null, videoBitrateKbps: 6000, effectiveVideoBitrateKbps: 6000, audioBitrateKbps: 160, mode: 'Simple', encoder: 'x264' } } as never;
    expect(codes({ ...base(), state, lastUploadMbps: 8.7 })).toContain('BITRATE_ABOVE_UPLOAD');
    expect(codes({ ...base(), state, lastUploadMbps: 8.9 })).not.toContain('BITRATE_ABOVE_UPLOAD');
  });

  it('OBS_NOT_RUNNING suppresses websocket findings', () => {
    expect(codes({ ...base(), running: false, websocket: { configEnabled: false, configExists: true, connected: false } })).toEqual(['OBS_NOT_RUNNING']);
  });
});

describe('platform caps from knowledge/platforms.json', () => {
  it('matches by service name and by custom server pattern, per the file rules', async () => {
    const file = EMBEDDED_KNOWLEDGE.platforms as never;
    expect(matchPlatform(file, { type: 'rtmp_common', service: 'Twitch' })).toMatchObject({ platform: 'twitch', maxVideoBitrateKbps: 6000 });
    expect(matchPlatform(file, { type: 'rtmp_common', service: 'YouTube - RTMPS' })).toMatchObject({ platform: 'youtube' });
    expect(matchPlatform(file, { type: 'rtmp_custom', server: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app' })).toMatchObject({ platform: 'kick', maxVideoBitrateKbps: 8000 });
    expect(matchPlatform(file, { type: 'rtmp_custom', server: 'rtmp://example.com/live' })).toBeNull();
    expect(uploadHeadroom(file)).toBe(0.7);
    expect(uploadHeadroom(null)).toBe(0.7);
  });
});
