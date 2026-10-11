/** MCP server: registers every tool; each call goes through runTool (validation, errors, redaction). */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PROMPTS } from './prompts.generated.js';
import type { Ctx } from './context.js';
import { ALL_TOOLS } from './tools/index.js';
import { runTool } from './tools/registry.js';

export const SERVER_NAME = 'ctrlstream';
export const SERVER_VERSION = '0.1.0';

export const SERVER_INSTRUCTIONS =
  'CTRLStream controls OBS Studio on this computer. Start with obs_status. The setup, troubleshoot and platforms guides are available as prompts and through get_started. Every change is backed up first (backup_list) and most can be reversed with undo_last; save a known-good snapshot once a setup is verified with test_record. Tools that edit OBS files need OBS closed (obs_quit first). Never ask the user to paste a stream key into the chat: they paste it into OBS.';

export function toCallToolResult(out: Awaited<ReturnType<typeof runTool>>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(out.json) }, ...out.images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))],
    ...(out.isError ? { isError: true } : {}),
  };
}

export function createServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.annotations?.readOnlyHint ?? false,
          destructiveHint: tool.annotations?.destructiveHint ?? (tool.mutating || tool.fileWriting),
          openWorldHint: tool.annotations?.openWorldHint ?? false,
          ...(tool.annotations?.idempotentHint !== undefined ? { idempotentHint: tool.annotations.idempotentHint } : {}),
        },
      },
      async (args: unknown) => toCallToolResult(await runTool(ctx, tool, args)),
    );
  }
  for (const p of PROMPTS) {
    server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: { details: z.string().optional().describe('What the user asked for or what is wrong, in their words') } },
      ({ details }) => ({
        description: p.description,
        messages: [{ role: 'user', content: { type: 'text', text: details ? `${p.text}\n\n---\nThe user says: ${details}` : p.text } }],
      }),
    );
  }
  return server;
}
