/** Tests for the fixes from the end-to-end QA run on the real Mac (2026-10-11). */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext } from '../../src/context.js';
import { encoderReplacements, lastClosedState } from '../../src/diagnose/closed-state.js';
import { currentErrors, lineMentionsInput, logLineTime } from '../../src/diagnose/report.js';
import { EMBEDDED_KNOWLEDGE } from '../../src/knowledge.js';
import { iniSet, parseIni, parseLog, serializeIni } from '../../src/obs/files.js';
import { displayLabel, parseDisplays, pickDefaultDisplay } from '../../src/probes/displays.js';
import { isSecretKey } from '../../src/safety/redact.js';
import { FAKE_DISPLAYS, expectOk, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});
const codes = (r: Record<string, unknown>) => (r['findings'] as Array<{ code: string }>).map((f) => f.code);

describe('1. macOS display selection without OBS listing displays', () => {
  const two = [
    { uuid: '11111111-1111-1111-1111-111111111111', label: 'LG UltraFine: 2560x1440 @ -2560,0', name: 'LG UltraFine', width: 2560, height: 1440, x: -2560, y: 0, main: false },
    ...FAKE_DISPLAYS,
  ];

  it('labels displays the way OBS does and parses the JXA output', () => {
    expect(displayLabel({ name: 'Built-in Retina Display', width: 1800, height: 1169, x: 0, y: 0 })).toBe('Built-in Retina Display: 1800x1169 @ 0,0');
    const parsed = parseDisplays('[{"uuid":"37D8832A-2D66-02CA-B9F7-8F30A301B230","name":"Built-in Retina Display","width":1800,"height":1169,"x":0,"y":0,"main":true},{"uuid":"bad","name":"x","width":1,"height":1,"x":0,"y":0,"main":false}]');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.label).toBe('Built-in Retina Display: 1800x1169 @ 0,0');
  });

  it("defaults to the display matching OBS's primary monitor, else the macOS main display, else the first", () => {
    const monitors = [{ monitorIndex: 0, monitorName: 'Built-in Retina Display(0)', monitorPositionX: 0, monitorPositionY: 0, monitorWidth: 1800, monitorHeight: 1169 }];
    expect(pickDefaultDisplay(two, monitors)).toMatchObject({ display: { uuid: '37D8832A-2D66-02CA-B9F7-8F30A301B230' }, chosenBy: 'obs-primary-monitor' });
    expect(pickDefaultDisplay(two, [])).toMatchObject({ display: { main: true }, chosenBy: 'macos-main' });
    expect(pickDefaultDisplay(two.map((d) => ({ ...d, main: false })), [])).toMatchObject({ display: { uuid: '11111111-1111-1111-1111-111111111111' }, chosenBy: 'first' });
    expect(pickDefaultDisplay([], monitors)).toBeNull();
  });

  it('input_create role display: sets display_uuid and says which display; warns when none could be chosen', async () => {
    h = await makeHarness({ displays: { list: async () => two } });
    const r = expectOk(await h.call('input_create', { name: 'Screen', scene: 'Live', role: 'display' }));
    expect(r['display']).toMatchObject({ uuid: '37D8832A-2D66-02CA-B9F7-8F30A301B230', chosenBy: 'obs-primary-monitor' });
    expect(r['warning']).toBeUndefined();
    expectOk(await h.call('input_create', { name: 'Screen 2', scene: 'Live', role: 'display', deviceId: '11111111-1111-1111-1111-111111111111' }));
    expect(h.model.inputs.get('Screen 2')!.settings['display_uuid']).toBe('11111111-1111-1111-1111-111111111111');
    await h.cleanup();
    h = await makeHarness({ displays: { list: async () => [] } });
    expect(expectOk(await h.call('input_create', { name: 'Screen', scene: 'Live', role: 'display' }))['warning']).toContain('black');
    expect(h.model.crashed).toBe(false);
  });

  it('screenshot says why a never-shown macOS display capture is black, and stops saying it once live', async () => {
    h = await makeHarness();
    expectOk(await h.call('input_create', { name: 'Screen', scene: 'Live', role: 'display' }));
    expect(String(expectOk(await h.call('screenshot', { source: 'Screen' }))['note'])).toContain('scene_set_current');
    expect(String(expectOk(await h.call('screenshot', { source: 'Live' }))['note'])).toContain("'Screen'");
    expectOk(await h.call('scene_set_current', { name: 'Live' }));
    expect(expectOk(await h.call('screenshot', { source: 'Screen' }))['note']).toBeUndefined();
  });

  it('diagnose flags a display capture whose display is gone, without asking OBS for the list', async () => {
    h = await makeHarness();
    h.model.addInput('Live', 'Old screen', 'screen_capture', { type: 0, display_uuid: '99999999-9999-9999-9999-999999999999' });
    const r = expectOk(await h.call('diagnose', { checkDevices: false }));
    const f = (r['findings'] as Array<Record<string, unknown>>).find((x) => x['code'] === 'DEVICE_MISSING')!;
    expect(String(f['evidence'])).toContain('Old screen');
    expect(h.model.crashed).toBe(false);
  });
});

describe('2. encoder evidence survives OBS rewriting it at startup', () => {
  it('records the closed-state encoders, then reports the replacement after a launch', async () => {
    h = await makeHarness({ running: false });
    const ini = path.join(h.profileDir, 'basic.ini');
    const doc = parseIni(readFileSync(ini, 'utf8'));
    iniSet(doc, 'SimpleOutput', 'StreamEncoder', 'nvenc');
    writeFileSync(ini, serializeIni(doc));
    // Closed: the file evidence is visible directly...
    expect(codes(expectOk(await h.call('diagnose')))).toContain('ENCODER_UNAVAILABLE');
    const saved = JSON.parse(readFileSync(path.join(h.dataDir, 'closed-state.json'), 'utf8'));
    expect(saved.encoders[0]).toMatchObject({ setting: 'StreamEncoder', value: 'nvenc', loadedByObs: false });
    // ...then OBS starts and rewrites it to x264 (CheckForSimpleModeX264Fallback).
    h.model.params.set('SimpleOutput.StreamEncoder', 'x264');
    expectOk(await h.call('obs_launch'));
    const r = expectOk(await h.call('diagnose', { checkDevices: false }));
    const f = (r['findings'] as Array<Record<string, unknown>>).find((x) => x['code'] === 'ENCODER_UNAVAILABLE')!;
    expect(String(f['evidence'])).toContain("was 'nvenc' on disk while OBS was closed");
    expect(String(f['evidence'])).toContain("replaced it with 'x264'");
  });

  it('a new session sees the last closed-state read from ~/.ctrlstream; setting the encoder clears it', async () => {
    h = await makeHarness({ running: false });
    await h.call('obs_status');
    const fresh = createContext({ pathEnv: h.ctx.pathEnv, dataDir: h.dataDir, proc: h.proc });
    expect((await lastClosedState(fresh))?.profile).toBe('Untitled');
    await h.call('obs_launch');
    expectOk(await h.call('output_set_simple', { encoder: 'apple_h264' }));
    expect(existsSync(path.join(h.dataDir, 'closed-state.json'))).toBe(false);
  });

  it('only fires for an encoder OBS could not load, replaced by x264, before the current start', () => {
    const last = { readAt: '2026-10-11T06:00:00.000Z', profile: 'P', mode: 'Simple', encoders: [{ setting: 'StreamEncoder' as const, value: 'nvenc', loadedByObs: false }], encodersLogFile: null };
    const live = { profile: 'P', streamEncoder: 'x264', recEncoder: null, lastStart: new Date('2026-10-11T06:01:00.000Z') };
    expect(encoderReplacements(last, live)).toHaveLength(1);
    expect(encoderReplacements(last, { ...live, streamEncoder: 'apple_h264' })).toHaveLength(0);
    expect(encoderReplacements(last, { ...live, profile: 'Other' })).toHaveLength(0);
    expect(encoderReplacements(last, { ...live, lastStart: new Date('2026-10-11T05:59:00.000Z') })).toHaveLength(0);
    // Same second as the start (log names have second resolution): still counts.
    expect(encoderReplacements({ ...last, readAt: '2026-10-11T06:01:00.400Z' }, live)).toHaveLength(1);
    expect(encoderReplacements({ ...last, encoders: [{ ...last.encoders[0]!, loadedByObs: true }] }, live)).toHaveLength(0);
  });
});

describe('3. LOG_ERRORS: current run only, timestamped, minus inputs this session fixed', () => {
  it('turns log clock times into dates, across midnight', () => {
    const start = new Date(2026, 9, 11, 23, 59, 0);
    expect(logLineTime(start, '23:59:30.000')!.getDate()).toBe(11);
    expect(logLineTime(start, '00:00:05.000')!.getDate()).toBe(12);
    expect(logLineTime(null, '00:00:05.000')).toBeNull();
  });

  it('matches OBS source-prefixed lines', () => {
    expect(lineMentionsInput("Webcam: Unable to initialize device with unique ID 'X'", 'Webcam')).toBe(true);
    expect(lineMentionsInput("Failed to create source 'Webcam'!", 'Webcam')).toBe(true);
    expect(lineMentionsInput('Webcam2: something failed', 'Webcam')).toBe(false);
  });

  it('drops an error about an input changed after it was logged and keeps the rest with times', () => {
    const parsed = parseLog("06:31:00.000: Webcam: Unable to initialize device with unique ID 'DEAD'\n06:31:01.000: [hotkeys-cocoa]: No event permissions, could not add global hotkeys.\n");
    const start = new Date(2026, 9, 11, 6, 30, 0);
    const touched = new Map([['Webcam', new Date(2026, 9, 11, 6, 35, 0)]]);
    const r = currentErrors(parsed, start, touched);
    expect(r.kept).toEqual(['[06:31:01.000] [hotkeys-cocoa]: No event permissions, could not add global hotkeys.']);
    expect(r.dropped[0]).toContain('Webcam');
    // Changed before the error was logged: still an error.
    expect(currentErrors(parsed, start, new Map([['Webcam', new Date(2026, 9, 11, 6, 30, 30)]])).kept).toHaveLength(2);
  });

  it('end to end: after input_settings_set on Webcam, diagnose no longer blames it', async () => {
    h = await makeHarness();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const t = new Date(Date.now() - 60_000);
    const name = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}-${p2(t.getMinutes())}-${p2(t.getSeconds())}.txt`;
    const clock = `${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}.500`;
    writeFileSync(path.join(h.configDir, 'logs', name), `${clock}: OBS 32.2.2 (mac)\n${clock}: Webcam: Unable to initialize device with unique ID 'DEADBEEF'\n`);
    expect(codes(expectOk(await h.call('diagnose', { checkDevices: false })))).toContain('LOG_ERRORS');
    expectOk(await h.call('input_settings_set', { name: 'Webcam', settings: { device: 'cam-facetime-uuid' } }));
    const r = expectOk(await h.call('diagnose', { checkDevices: false }));
    expect(codes(r)).not.toContain('LOG_ERRORS');
    expect((r['log'] as Record<string, unknown>)['errorsAlreadyAddressed']).toEqual([expect.stringContaining('Webcam: Unable to initialize')]);
  });
});

describe('4. snapshots record what the user still had to do', () => {
  it('pending is stored with complete: false and surfaced by list and diff', async () => {
    h = await makeHarness();
    const s = expectOk(await h.call('snapshot_save', { label: 'known-good', pending: ['paste stream key', 'pick display'] }));
    expect(s).toMatchObject({ pending: ['paste stream key', 'pick display'], complete: false });
    const m = JSON.parse(readFileSync(path.join(h.dataDir, 'snapshots', String(s['id']), 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ pending: ['paste stream key', 'pick display'], complete: false });
    expect((expectOk(await h.call('snapshot_list'))['snapshots'] as Array<Record<string, unknown>>)[0]).toMatchObject({ complete: false, pending: ['paste stream key', 'pick display'] });
    expect(expectOk(await h.call('snapshot_diff'))).toMatchObject({ snapshotPending: ['paste stream key', 'pick display'], snapshotComplete: false });
    expect(expectOk(await h.call('snapshot_save', { label: 'done' }))).toMatchObject({ pending: [], complete: true });
  });
});

describe('5. only devices the snapshot used count as missing', () => {
  it('a phone camera the setup never used is not missing; the used webcam is', async () => {
    h = await makeHarness();
    h.model.listItems['macos-avcapture']!['device']!.push({ itemName: 'iPhone Camera', itemValue: 'iphone-uuid', itemEnabled: true });
    expectOk(await h.call('snapshot_save', { label: 'known-good' }));
    const cams = h.model.listItems['macos-avcapture']!['device']!;
    h.model.listItems['macos-avcapture']!['device'] = cams.filter((d) => d.itemValue !== 'iphone-uuid');
    let r = expectOk(await h.call('diagnose'));
    expect((r['devices'] as Record<string, unknown>)['missingVsSnapshot']).toEqual([]);
    const d = expectOk(await h.call('snapshot_diff'));
    expect(d['devices']).toMatchObject({ missingNow: {}, otherMissingNow: { cameras: ['iPhone Camera'] } });
    expect(d['identical']).toBe(true);
    h.model.listItems['macos-avcapture']!['device'] = cams.filter((d2) => d2.itemValue !== 'cam-facetime-uuid' && d2.itemValue !== 'iphone-uuid');
    r = expectOk(await h.call('diagnose'));
    expect((r['devices'] as Record<string, unknown>)['missingVsSnapshot']).toEqual(['FaceTime HD Camera']);
  });
});

describe('6 and 7. knowledge tool paths and field names', () => {
  it('dotted section paths reach inside the tables', async () => {
    h = await makeHarness();
    const r = expectOk(await h.call('knowledge', { file: 'encoders', section: 'families.apple' }));
    expect(r['section']).toBe('families.apple');
    expect(r['value']).toBeTruthy();
    const p = expectOk(await h.call('knowledge', { file: 'encoders', section: 'simpleModeEncoders.nvenc.presetSetting' }));
    expect(p['value']).toBe('NVENCPreset2');
    const e = await h.call('knowledge', { file: 'encoders', section: 'families.amiga' });
    expect((e['error'] as Record<string, unknown>)['hint']).toContain('apple');
  });

  it('no field in either knowledge file is masked by the redactor (no names ending in Key, Token, Password)', () => {
    const bad: string[] = [];
    const walk = (v: unknown, at: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (isSecretKey(k) || /(Key|Token|Password)$/.test(k)) bad.push(`${at}.${k}`);
          walk(x, `${at}.${k}`);
        }
      }
    };
    walk(EMBEDDED_KNOWLEDGE.platforms, 'platforms');
    walk(EMBEDDED_KNOWLEDGE.encoders, 'encoders');
    expect(bad).toEqual([]);
  });
});
