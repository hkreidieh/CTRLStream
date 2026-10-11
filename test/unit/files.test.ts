import { describe, expect, it } from 'vitest';
import { iniGet, iniSet, parseIni, parseLog, serializeIni, summarizeService } from '../../src/obs/files.js';
import { SecretRegistry } from '../../src/safety/redact.js';
import { DUMMY_KEY, FIXTURES, read } from '../helpers.js';

describe('ini', () => {
  it('parses the real basic.ini from OBS 32.2.2', () => {
    const ini = parseIni(read(`${FIXTURES}/real/basic.ini`));
    expect(iniGet(ini, 'Output', 'Mode')).toBe('Simple');
    expect(iniGet(ini, 'SimpleOutput', 'StreamEncoder')).toBe('x264');
    expect(iniGet(ini, 'SimpleOutput', 'RecFormat2')).toBe('hybrid_mov');
    expect(iniGet(ini, 'Video', 'BaseCX')).toBe('1920');
    expect(iniGet(ini, 'Audio', 'SampleRate')).toBe('48000');
    expect(iniGet(ini, 'AdvOut', 'RecEncoder')).toBe('none');
  });

  it('round-trips byte for byte, keeps a Windows BOM and CRLF', () => {
    const text = read(`${FIXTURES}/real/basic.ini`);
    expect(serializeIni(parseIni(text))).toBe(text);
    const win = '\uFEFF[General]\r\nName=Untitled\r\n';
    const doc = parseIni(win);
    expect(doc.bom).toBe(true);
    iniSet(doc, 'Audio', 'SampleRate', '44100');
    expect(serializeIni(doc)).toBe('\uFEFF[General]\r\nName=Untitled\r\n\r\n[Audio]\r\nSampleRate=44100\r\n');
  });

  it('deletes keys with undefined and handles the fresh first-run profile', () => {
    const doc = parseIni(read(`${FIXTURES}/real/basic-fresh.ini`));
    expect(iniGet(doc, 'General', 'Name')).toBe('Untitled');
    expect(iniGet(doc, 'Output', 'Mode')).toBeUndefined();
    iniSet(doc, 'General', 'Name', undefined);
    expect(iniGet(doc, 'General', 'Name')).toBeUndefined();
  });
});

describe('log parsing (real OBS 32.2.2 logs)', () => {
  it('reads version, encoders, modules, permissions and a clean shutdown', () => {
    const p = parseLog(read(`${FIXTURES}/real/log-first-run-clean.txt`));
    expect(p.obsVersion).toBe('32.2.2');
    expect(p.platformTag).toBe('mac');
    expect(p.portable).toBe(false);
    expect(p.encoders.video.map((e) => e.id)).toEqual([
      'ffmpeg_aom_av1',
      'obs_x264',
      'com.apple.videotoolbox.videoencoder.prores-422',
      'com.apple.videotoolbox.videoencoder.appleproreshw.422',
      'com.apple.videotoolbox.videoencoder.ave.avc',
      'com.apple.videotoolbox.videoencoder.h264',
      'com.apple.videotoolbox.videoencoder.ave.hevc',
      'com.apple.videotoolbox.videoencoder.hevc.vcp',
    ]);
    expect(p.encoders.audio.map((e) => e.id)).toContain('CoreAudio_AAC');
    expect(p.loadedModules).toContain('obs-websocket');
    expect(p.macPermissions['screenCapture']).toBe('denied');
    expect(p.cleanShutdown).toBe(true);
    expect(p.safeMode).toBe(false);
    // AJA/DeckLink noise is not an error.
    expect(p.errors.some((e) => /AJA|DeckLink|decklink/i.test(e))).toBe(false);
  });

  it('finds missing devices, encoder overload and network drops', () => {
    const p = parseLog(read(`${FIXTURES}/logs/log-overload-missing-device.txt`));
    expect(p.errors.some((e) => e.includes('failed to find device uid: bogus-mic-uid'))).toBe(true);
    expect(p.encoderOverload[0]).toContain('3150/18000');
    expect(p.networkDrops[0]).toContain('412');
    expect(p.cleanShutdown).toBe(false);
  });

  it('notices the crash-recovery line on the next start', () => {
    const p = parseLog(read(`${FIXTURES}/real/log-after-unclean-shutdown.txt`));
    expect(p.previousSessionUnclean).toBe(true);
    expect(p.warnings.length + p.errors.length).toBeGreaterThan(0);
  });

  it('detects safe mode', () => {
    expect(parseLog('10:00:00.000: Safe Mode enabled.\n').safeMode).toBe(true);
    expect(parseLog('10:00:00.000: [Safe Mode] Safe mode launch selected, loading third-party plugins is disabled\n').safeMode).toBe(true);
  });
});

describe('stream service', () => {
  it('never returns the key and registers it for scrubbing', () => {
    const reg = new SecretRegistry();
    const s = summarizeService('rtmp_common', { service: 'Twitch', server: 'auto', key: DUMMY_KEY, bwtest: false }, reg);
    expect(s).toEqual({ type: 'rtmp_common', service: 'Twitch', server: 'auto', key: '<set>', settings: { service: 'Twitch', server: 'auto', bwtest: false } });
    expect(JSON.stringify(s)).not.toContain(DUMMY_KEY);
    expect(reg.list()).toContain(DUMMY_KEY);
    expect(summarizeService('rtmp_custom', { server: 'rtmp://x' }).key).toBe('<empty>');
  });
});
