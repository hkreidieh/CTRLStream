/**
 * The registry as plain data: tool names and descriptions, prompt names, descriptions and text.
 * Printed by `ctrlstream --print-catalogue` for scripts/gen-mcpb-manifest.ts, and compared with
 * mcpb/manifest.json by test/unit/mcpb-manifest.test.ts.
 */
import { PROMPTS } from './prompts.generated.js';
import { SERVER_NAME, SERVER_VERSION } from './server.js';
import { ALL_TOOLS } from './tools/index.js';

export interface Catalogue {
  name: string;
  version: string;
  tools: Array<{ name: string; description: string }>;
  prompts: Array<{ name: string; description: string; text: string }>;
}

export function catalogue(): Catalogue {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description, text: p.text })),
  };
}
