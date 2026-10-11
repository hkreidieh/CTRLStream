/** Entry point: `ctrlstream` (npx) and the .mcpb both run this file over stdio. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext } from './context.js';
import { catalogue } from './catalogue.js';
import { createServer } from './server.js';

/**
 * `ctrlstream --print-catalogue` prints the tool and prompt registry as JSON and exits without
 * starting the server (used by scripts/gen-mcpb-manifest.ts).
 */
async function main(): Promise<void> {
  if (process.argv.includes('--print-catalogue')) {
    process.stdout.write(`${JSON.stringify(catalogue())}\n`);
    return;
  }
  const ctx = createContext();
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await ctx.obs.disconnect().catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
  await server.connect(transport);
}

main().catch((err) => {
  // stdout belongs to the MCP protocol; diagnostics go to stderr, without secrets.
  process.stderr.write(`ctrlstream failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
