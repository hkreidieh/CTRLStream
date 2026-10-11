/**
 * Copies knowledge/platforms.json and knowledge/encoders.json into plugin/knowledge/ so the plugin's
 * skills can read them at ${CLAUDE_PLUGIN_ROOT}/knowledge/... (installed plugins only get the plugin
 * folder). knowledge/ at the repository root stays the single source, the one the server embeds.
 * Runs before every build (`pnpm build`, prebuild); test/unit/plugin-layout.test.ts fails on drift.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'plugin', 'knowledge');
mkdirSync(dest, { recursive: true });
for (const f of ['platforms.json', 'encoders.json']) {
  const src = path.join(root, 'knowledge', f);
  JSON.parse(readFileSync(src, 'utf8')); // refuse to ship a broken table
  copyFileSync(src, path.join(dest, f));
}
process.stdout.write('sync-plugin-knowledge: copied platforms.json, encoders.json to plugin/knowledge\n');
