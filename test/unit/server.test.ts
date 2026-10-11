import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, SERVER_NAME } from '../../src/server.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { assertNoSecrets, makeHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
let client: Client;
afterEach(async () => {
  await client?.close();
  await h?.cleanup();
});

async function connect(): Promise<void> {
  h = await makeHarness();
  const server = createServer(h.ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
}

describe('MCP server', () => {
  it('is named ctrlstream and lists every tool with a schema, description and annotations', async () => {
    await connect();
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(60);
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations).toBeDefined();
    }
    expect(tools.find((t) => t.name === 'obs_status')!.annotations!.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'scene_remove')!.annotations!.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'network_test')!.annotations!.openWorldHint).toBe(true);
  });

  it('returns compact JSON text, and errors with isError', async () => {
    await connect();
    const ok = await client.callTool({ name: 'scene_list', arguments: {} });
    const text = (ok.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ ok: true, current: 'Scene' });
    expect(ok.isError).toBeFalsy();
    const bad = await client.callTool({ name: 'scene_remove', arguments: { name: 'Nope' } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('screenshot comes back as MCP image content', async () => {
    await connect();
    const r = await client.callTool({ name: 'screenshot', arguments: { width: 640 } });
    const content = r.content as Array<{ type: string; mimeType?: string }>;
    expect(content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(content[1]!.mimeType).toBe('image/jpeg');
  });

  it('never returns the stream key through the protocol', async () => {
    await connect();
    for (const name of ['stream_service_get', 'diagnose', 'output_get']) {
      const r = await client.callTool({ name, arguments: {} });
      assertNoSecrets(JSON.stringify(r), name);
    }
  });

  it('serves the setup, troubleshoot and platforms prompts', async () => {
    await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['setup', 'troubleshoot', 'platforms']);
    const p = await client.getPrompt({ name: 'troubleshoot', arguments: { details: 'my webcam is black' } });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain('my webcam is black');
    expect(text.length).toBeGreaterThan(1000);
  });
});
