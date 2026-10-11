/** The full tool catalogue (DESIGN section 4), in catalogue order. */
import { diagnosisTools } from './diagnosis.js';
import { layoutTools } from './layout.js';
import { metaTools } from './meta.js';
import { outputTools } from './outputs.js';
import { probeTools } from './probes.js';
import type { ToolSpec } from './registry.js';
import { sceneTools } from './scenes.js';
import { sessionTools } from './session.js';
import { settingsTools } from './settings.js';
import { snapshotTools } from './snapshots.js';

export const ALL_TOOLS: ToolSpec[] = [
  ...metaTools,
  ...sessionTools,
  ...probeTools,
  ...sceneTools,
  ...layoutTools,
  ...settingsTools,
  ...outputTools,
  ...snapshotTools,
  ...diagnosisTools,
] as unknown as ToolSpec[];

export function toolByName(name: string): ToolSpec | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}
