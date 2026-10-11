/**
 * Rewrites the `tools` and `prompts` sections of mcpb/manifest.json (and its `version`) from the
 * server's own registry, read from the built bundle with `node dist/index.js --print-catalogue`.
 * Runs after the bundle is built (`pnpm build`, postbuild). test/unit/mcpb-manifest.test.ts fails
 * if the committed manifest disagrees with the registry.
 *
 * The mcpb v0.3 schema requires `text` for each prompt, so each prompt carries the same generated
 * text the server serves, with the optional `details` argument the server also accepts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'mcpb', 'manifest.json');

interface Catalogue {
  version: string;
  tools: Array<{ name: string; description: string }>;
  prompts: Array<{ name: string; description: string; text: string }>;
}

export const DETAILS_SUFFIX = '\n\n---\nThe user says: ${arguments.details}';

const cat = JSON.parse(execFileSync(process.execPath, [path.join(root, 'dist', 'index.js'), '--print-catalogue'], { encoding: 'utf8' })) as Catalogue;
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

manifest['version'] = pkg.version;
manifest['tools'] = cat.tools.map((t) => ({ name: t.name, description: t.description }));
manifest['prompts'] = cat.prompts.map((p) => ({ name: p.name, description: p.description, arguments: ['details'], text: p.text + DETAILS_SUFFIX }));

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`gen-mcpb-manifest: ${cat.tools.length} tools, ${cat.prompts.length} prompts, version ${pkg.version}\n`);
