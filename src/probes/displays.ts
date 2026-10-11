/**
 * macOS displays, read from the OS rather than from OBS.
 *
 * Why not OBS: ScreenCaptureKit's display list (plugins/mac-capture/mac-sck-common.m, OBS 32.2.2,
 * line 88) always starts with a placeholder entry whose value is NULL, and obs-websocket 5.7.4
 * builds a std::string from it, so GetInputPropertiesListPropertyItems on screen_capture crashes
 * OBS (SIGSEGV in strlen) whatever the Screen Recording permission. Seen twice on the real OBS:
 * 02:30 with permission denied and 06:52 with it granted, same stack.
 *
 * What OBS stores is the CoreGraphics display UUID (CGDisplayCreateUUIDFromDisplayID ->
 * CFUUIDCreateString) and it labels the display "<NSScreen localizedName>: WxH @ x,y". The
 * built-in JavaScript-for-Automation bridge (`osascript -l JavaScript`, on every Mac) gives
 * exactly those, so nothing has to be installed. Verified on macOS 26.2: same UUID as OBS used,
 * and a screen_capture with that display_uuid showed the desktop in a screenshot.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface MacDisplay {
  uuid: string;
  /** The label OBS shows: "<name>: WxH @ x,y". */
  label: string;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  main: boolean;
}

export interface DisplayProbe {
  list(): Promise<MacDisplay[]>;
}

const JXA = `
ObjC.import('AppKit'); ObjC.import('CoreGraphics'); ObjC.import('ColorSync'); ObjC.import('CoreFoundation');
function run() {
  var out = []; var screens = $.NSScreen.screens; var mainId = $.CGMainDisplayID();
  for (var i = 0; i < screens.count; i++) {
    var s = screens.objectAtIndex(i);
    var id = ObjC.unwrap(s.deviceDescription.objectForKey('NSScreenNumber'));
    var u = $.CGDisplayCreateUUIDFromDisplayID(id);
    var str = $.CFUUIDCreateString($.kCFAllocatorDefault, u);
    var f = s.frame;
    out.push({ uuid: ObjC.castRefToObject(str).js, name: s.localizedName.js, width: f.size.width, height: f.size.height, x: f.origin.x, y: f.origin.y, main: id === mainId });
  }
  return JSON.stringify(out);
}`;

export function displayLabel(d: { name: string; width: number; height: number; x: number; y: number }): string {
  return `${d.name}: ${Math.trunc(d.width)}x${Math.trunc(d.height)} @ ${Math.trunc(d.x)},${Math.trunc(d.y)}`;
}

export function parseDisplays(json: string): MacDisplay[] {
  const raw = JSON.parse(json) as Array<Omit<MacDisplay, 'label'>>;
  return raw
    .filter((d) => typeof d.uuid === 'string' && /^[0-9A-F-]{36}$/i.test(d.uuid))
    .map((d) => ({ ...d, label: displayLabel(d) }));
}

export const realDisplayProbe: DisplayProbe = {
  async list() {
    if (process.platform !== 'darwin') return [];
    const { stdout } = await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA], { timeout: 10_000 });
    return parseDisplays(stdout.trim());
  },
};

/**
 * The display a new display capture should use: the one matching OBS's primary monitor
 * (GetMonitorList: the monitor at 0,0, else index 0) by name, else the macOS main display,
 * else the first.
 */
export function pickDefaultDisplay(displays: MacDisplay[], monitors: Array<Record<string, unknown>>): { display: MacDisplay; chosenBy: 'obs-primary-monitor' | 'macos-main' | 'first' } | null {
  if (displays.length === 0) return null;
  const primary = monitors.find((m) => m['monitorPositionX'] === 0 && m['monitorPositionY'] === 0) ?? monitors[0];
  if (primary) {
    const base = String(primary['monitorName'] ?? '').replace(/\(\d+\)\s*$/, '').trim();
    const byName = displays.filter((d) => d.name === base);
    const hit = byName.find((d) => d.x === primary['monitorPositionX'] && d.y === primary['monitorPositionY']) ?? (byName.length === 1 ? byName[0] : undefined);
    if (hit) return { display: hit, chosenBy: 'obs-primary-monitor' };
  }
  const main = displays.find((d) => d.main);
  if (main) return { display: main, chosenBy: 'macos-main' };
  return { display: displays[0]!, chosenBy: 'first' };
}
