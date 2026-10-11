/** Orientation for clients without skills or prompt support: get_started and knowledge. */
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { readKnowledge } from '../knowledge.js';
import { PROMPTS } from '../prompts.generated.js';
import { defineTool } from './registry.js';

export const getStarted = defineTool({
  name: 'get_started',
  title: 'Get started with CTRLStream',
  description:
    'How to use CTRLStream: what it does, the first calls to make, and the guides (setup, troubleshoot, platforms) that are also offered as MCP prompts. If your client does not show prompts, call this with guide set to read a guide in full before setting up or fixing OBS. Changes nothing.',
  input: { guide: z.enum(['setup', 'troubleshoot', 'platforms']).optional() },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args) => {
    if (args.guide) {
      const p = PROMPTS.find((x) => x.name === args.guide)!;
      return { guide: p.name, title: p.title, text: p.text };
    }
    return {
      about: 'CTRLStream sets up OBS Studio and fixes it when it breaks, through OBS’s websocket and its config files. Every change is backed up first; most can be undone with undo_last.',
      firstSteps: [
        'obs_status: is OBS running, is the websocket on, which profile is active.',
        'To set up streaming: read the setup guide (prompt "setup", or get_started with guide "setup") and follow it.',
        'When something is broken: read the troubleshoot guide, then call diagnose.',
        'Never ask for the stream key in the chat; the user pastes it into OBS (Settings > Stream).',
      ],
      prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description })),
    };
  },
});

const FILES = { platforms: 'platforms.json', encoders: 'encoders.json' } as const;

export const knowledge = defineTool({
  name: 'knowledge',
  title: 'Platform and encoder tables',
  description:
    "Read CTRLStream's knowledge tables: platforms (per-platform bitrate caps, resolutions, keyframe rules, the 70% upload rule) and encoders (OBS encoder ids, which GPUs can encode what, presets). Give platform (e.g. twitch, youtube, kick, tiktok, facebook) or section to get just that part (dotted paths reach inside, e.g. families.apple or simpleModeEncoders.nvenc); without either you get the list of what is inside. Changes nothing.",
  input: {
    file: z.enum(['platforms', 'encoders']),
    platform: z.string().min(1).optional(),
    section: z.string().min(1).optional(),
  },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    const { data: json, from } = await readKnowledge(ctx, args.file);
    const meta = { schemaVersion: json['schemaVersion'] ?? null, checkedOn: json['checkedOn'] ?? null, from };
    if (args.platform) {
      const platforms = (json['platforms'] ?? {}) as Record<string, unknown>;
      const key = Object.keys(platforms).find((k) => k.toLowerCase() === args.platform!.toLowerCase());
      if (!key) throw new ToolError('NOT_FOUND', `No platform '${args.platform}' in ${FILES[args.file]}.`, `Platforms: ${Object.keys(platforms).join(', ') || 'none'}.`);
      return { ...meta, rules: json['rules'] ?? null, platform: key, entry: platforms[key] };
    }
    if (args.section) {
      // Dotted paths reach inside: families.apple, simpleModeEncoders.nvenc.presetValues, sources.0
      let value: unknown = json;
      const walked: string[] = [];
      for (const part of args.section.split('.')) {
        const here = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
        if (!here || !(part in here)) {
          const where = walked.length ? `'${walked.join('.')}'` : FILES[args.file];
          const keys = here ? Object.keys(here) : [];
          throw new ToolError('NOT_FOUND', `No '${part}' in ${where}.`, keys.length ? `Keys there: ${keys.slice(0, 40).join(', ')}.` : `${where} is not an object.`);
        }
        value = here[part];
        walked.push(part);
      }
      return { ...meta, section: args.section, value };
    }
    const platforms = json['platforms'] && typeof json['platforms'] === 'object' ? Object.keys(json['platforms'] as object) : undefined;
    return { ...meta, about: json['about'] ?? null, sections: Object.keys(json), ...(platforms ? { platforms } : {}), ...(json['rules'] ? { rules: json['rules'] } : {}) };
  },
});

export const metaTools = [getStarted, knowledge];
