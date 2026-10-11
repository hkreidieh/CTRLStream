/** OS, CPU, RAM, GPUs and displays via systeminformation. Behind an interface so tests can fake it. */
import si from 'systeminformation';

export interface GpuInfo {
  vendor: string;
  model: string;
  vramMb: number | null;
  driverVersion: string | null;
}

export interface DisplayInfo {
  name: string;
  width: number | null;
  height: number | null;
  refreshHz: number | null;
  main: boolean;
}

export interface SystemInfo {
  os: { platform: string; distro: string; release: string; arch: string };
  cpu: { brand: string; manufacturer: string; physicalCores: number; logicalCores: number; speedGHz: number | null };
  memory: { totalMb: number; availableMb: number };
  gpus: GpuInfo[];
  displays: DisplayInfo[];
}

export interface SystemProbe {
  info(): Promise<SystemInfo>;
}

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

export const realSystemProbe: SystemProbe = {
  async info() {
    const [os, cpu, mem, gfx] = await Promise.all([si.osInfo(), si.cpu(), si.mem(), si.graphics()]);
    return {
      os: { platform: os.platform, distro: os.distro, release: os.release, arch: os.arch },
      cpu: {
        brand: cpu.brand,
        manufacturer: cpu.manufacturer,
        physicalCores: cpu.physicalCores,
        logicalCores: cpu.cores,
        speedGHz: cpu.speed || null,
      },
      memory: { totalMb: mb(mem.total), availableMb: mb(mem.available) },
      gpus: gfx.controllers.map((c) => ({
        vendor: c.vendor || 'unknown',
        model: c.model || 'unknown',
        vramMb: c.vram ?? null,
        driverVersion: c.driverVersion || null,
      })),
      displays: gfx.displays.map((d) => ({
        name: d.model || d.deviceName || 'display',
        width: d.currentResX ?? d.resolutionX ?? null,
        height: d.currentResY ?? d.resolutionY ?? null,
        refreshHz: d.currentRefreshRate ?? null,
        main: !!d.main,
      })),
    };
  },
};

/** Normalise a GPU vendor string to the families encoders care about. */
export function gpuFamily(vendor: string, model = ''): 'nvidia' | 'amd' | 'intel' | 'apple' | 'other' {
  const s = `${vendor} ${model}`.toLowerCase();
  if (s.includes('nvidia')) return 'nvidia';
  if (s.includes('amd') || s.includes('advanced micro') || s.includes('radeon') || s.includes('ati ')) return 'amd';
  if (s.includes('intel')) return 'intel';
  if (s.includes('apple')) return 'apple';
  return 'other';
}
