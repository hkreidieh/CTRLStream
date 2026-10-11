/** Snapshots, backups and undo. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { findProfile } from '../obs/files.js';
import { copyActiveState, listBackups } from '../safety/backup.js';
import { fileWrite } from '../safety/file-write.js';
import { mutate } from '../safety/mutate.js';
import { undoHistory, undoLast } from '../safety/undo.js';
import { diffAgainst } from '../snapshots/diff.js';
import { buildManifest, latestKnownGood, listSnapshots, loadSnapshot, saveSnapshot } from '../snapshots/store.js';
import { defineTool } from './registry.js';

export const snapshotSave = defineTool({
  name: 'snapshot_save',
  title: 'Save snapshot',
  description:
    "Save a labelled copy of the current setup: the whole profile (settings, stream service) and the scene collection, plus a manifest of video, output, audio, scenes, inputs, devices and encoders for later comparison. Label it known-good once a setup is confirmed working (test_record clean): the troubleshoot flow compares against the newest known-good. List anything the user still has to do in pending (for example: paste stream key, pick display); the snapshot is then marked complete: false, so a later restore is not mistaken for a finished setup and you know which steps the user may have done after it. Works while OBS runs: it first makes OBS write its pending scene changes to disk (by adding and removing the hidden scratch scene), reads scenes and inputs over the websocket, and marks takenWhileRunning. Writes only to ~/.ctrlstream, never to OBS's files.",
  input: {
    label: z.string().min(1).max(60),
    note: z.string().max(500).optional(),
    pending: z.array(z.string().min(1).max(200)).max(20).optional().describe('Steps the user still has to do, e.g. "paste stream key", "pick display"'),
  },
  mutating: false,
  fileWriting: false,
  handler: async (args, ctx) => {
    const { manifest, copied, flush } = await saveSnapshot(ctx, args.label, args.note, args.pending ?? []);
    return {
      id: manifest.id,
      label: manifest.label,
      pending: manifest.pending ?? [],
      complete: manifest.complete ?? null,
      takenWhileRunning: manifest.takenWhileRunning,
      profile: manifest.profile,
      sceneCollection: manifest.sceneCollection,
      copied,
      ...(manifest.takenWhileRunning ? { sceneFileFlushed: flush.flushed, flushWaitMs: flush.waitedMs } : {}),
      summary: { scenes: manifest.scenes.length, inputs: manifest.inputs.length, video: manifest.video, output: { mode: manifest.output.mode, encoder: manifest.output.encoder, videoBitrateKbps: manifest.output.videoBitrateKbps }, devicesCaptured: !!manifest.devices },
    };
  },
});

export const snapshotList = defineTool({
  name: 'snapshot_list',
  title: 'List snapshots',
  description: 'Saved snapshots, newest first, with id, label, note, pending steps and complete flag, date, profile and collection, optionally filtered by label (known-good is the one the troubleshoot flow compares against). Use an id with snapshot_diff or snapshot_restore. Changes nothing.',
  input: { label: z.string().optional().describe('Only this label, e.g. known-good') },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    const list = (await listSnapshots(ctx)).filter((m) => !args.label || m.label === args.label);
    return {
      snapshots: list.map((m) => ({ id: m.id, label: m.label, note: m.note ?? null, pending: m.pending ?? [], complete: m.complete ?? null, createdAt: m.createdAt, takenWhileRunning: m.takenWhileRunning, profile: m.profile, sceneCollection: m.sceneCollection, obsVersion: m.obsVersion })),
    };
  },
});

export const snapshotDiff = defineTool({
  name: 'snapshot_diff',
  title: 'Compare with a snapshot',
  description:
    'What changed since a snapshot: video, output, audio, stream destination (never the key), scenes added or removed, inputs added, removed or changed (kind, scenes, device, settings), devices the snapshot\'s inputs used that are missing now, encoders then vs now, and the steps that were still pending when it was saved. Default snapshot: the newest known-good. Changes nothing (device listing may briefly use the scratch scene).',
  input: { snapshotId: z.string().min(1).optional() },
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    let id = args.snapshotId;
    if (!id) {
      const kg = await latestKnownGood(ctx);
      if (!kg) throw new ToolError('NOT_FOUND', 'No snapshot labelled known-good exists yet.', 'Pass snapshotId from snapshot_list, or save one with snapshot_save once the setup works.', 'snapshot_list');
      id = kg.id;
    }
    const { manifest, dir } = await loadSnapshot(ctx, id);
    if (ctx.proc && !ctx.obs.connected && (await ctx.proc.find())) await ctx.obs.connect().catch(() => undefined);
    const running = !!(await ctx.proc.find());
    const { manifest: current, state } = await buildManifest(ctx, 'current', 'current', undefined, running);
    return { ...(await diffAgainst(ctx, manifest, dir, current, state.inputSettings, state.source)) };
  },
});

export const snapshotRestore = defineTool({
  name: 'snapshot_restore',
  title: 'Restore snapshot',
  description:
    "Put a snapshot back: replaces the profile folder (all settings, including the stream key saved in it) and the scene collection file with the snapshot's copies. OBS must be closed (obs_quit first) because OBS rewrites these files on exit. The current state is copied aside first, so undo_last (with OBS still closed) reverses it. Next: obs_launch with the returned profile and collection, then test_record.",
  input: { snapshotId: z.string().min(1) },
  mutating: true,
  fileWriting: true,
  annotations: { destructiveHint: true },
  handler: async (args, ctx) => {
    const { manifest, dir } = await loadSnapshot(ctx, args.snapshotId);
    return fileWrite(ctx, 'snapshot_restore', async (w) => {
      const snapProfile = path.join(dir, 'profile');
      const snapScenes = manifest.sceneCollectionFile ? path.join(dir, 'scenes', manifest.sceneCollectionFile) : null;
      if (!existsSync(snapProfile) && !(snapScenes && existsSync(snapScenes))) throw new ToolError('NOT_FOUND', `Snapshot ${manifest.id} has no profile or scene files to restore.`, 'Pick another snapshot from snapshot_list.', 'snapshot_list');
      const existingProfile = manifest.profile ? await findProfile(ctx.paths, manifest.profile) : null;
      const targetProfile = existingProfile?.path ?? (manifest.profileDir ? path.join(ctx.paths.profilesDir, manifest.profileDir) : null);
      const targetScenes = manifest.sceneCollectionFile ? path.join(ctx.paths.scenesDir, manifest.sceneCollectionFile) : null;
      const asideDir = path.join(ctx.dataDir, 'backups', ctx.session.id, `pre-restore-${Date.now()}`);
      const restored = await mutate(ctx, {
        tool: 'snapshot_restore',
        args,
        before: async () => {
          await copyActiveState(ctx, asideDir, { profile: manifest.profile, collection: manifest.sceneCollection });
          return {
            profileSaved: targetProfile && existsSync(path.join(asideDir, 'profile')) ? path.join(asideDir, 'profile') : null,
            scenesSaved: targetScenes && manifest.sceneCollectionFile && existsSync(path.join(asideDir, 'scenes', manifest.sceneCollectionFile)) ? path.join(asideDir, 'scenes', manifest.sceneCollectionFile) : null,
          };
        },
        apply: async () => {
          const done: string[] = [];
          if (targetProfile && existsSync(snapProfile)) {
            await w.remove(targetProfile);
            await w.copyDir(snapProfile, targetProfile);
            done.push(`profile ${manifest.profile}`);
          }
          if (targetScenes && snapScenes && existsSync(snapScenes)) {
            await w.copyFile(snapScenes, targetScenes);
            done.push(`scene collection ${manifest.sceneCollection}`);
          }
          return done;
        },
        inverse: (b) => ({
          kind: 'files',
          files: [...(targetProfile ? [{ target: targetProfile, saved: b.profileSaved, dir: true }] : []), ...(targetScenes ? [{ target: targetScenes, saved: b.scenesSaved }] : [])],
          note: 'restore the state from before snapshot_restore',
        }),
      });
      return { snapshotId: manifest.id, label: manifest.label, restored, launchWith: { profile: manifest.profile, collection: manifest.sceneCollection }, next: 'obs_launch' };
    });
  },
});

export const backupList = defineTool({
  name: 'backup_list',
  title: 'Backups and undo history',
  description:
    "Automatic backups (one per session, taken before the first change, newest 10 kept) and this session's change history with what undo_last would reverse next. A backup folder can be restored by hand, or use snapshots for labelled restore points. Changes nothing.",
  input: {},
  mutating: false,
  fileWriting: false,
  annotations: { readOnlyHint: true },
  handler: async (_args, ctx) => {
    const backups = await listBackups(ctx);
    const history = undoHistory(ctx);
    const next = [...history].reverse().find((h) => h.undoable && !h.undone && h.tool !== 'undo_last');
    return { backups: backups.map((b) => ({ sessionId: b.sessionId, createdAt: b.createdAt, profile: b.profile, collection: b.collection, files: b.files, current: b.current, dir: b.dir })), sessionHistory: history, nextUndo: next ? { seq: next.seq, tool: next.tool } : null };
  },
});

export const undoLastTool = defineTool({
  name: 'undo_last',
  title: 'Undo last change',
  description:
    "Reverse the most recent undoable change made through ctrlstream in this session (scenes, inputs, transforms, filters, settings, stream destination, file edits). Starting or stopping outputs is skipped. File changes (output_set_advanced, audio_set, snapshot_restore) can only be undone with OBS closed. Call repeatedly to step back further; backup_list shows what is next.",
  input: {},
  mutating: true,
  fileWriting: false,
  handler: async (_args, ctx) => {
    const r = await undoLast(ctx);
    return { undid: { seq: r.undone.seq, tool: r.undone.tool, at: r.undone.ts }, ...r.result, ...(r.skippedNotUndoable.length ? { skippedNotUndoable: r.skippedNotUndoable } : {}) };
  },
});

export const snapshotTools = [snapshotSave, snapshotList, snapshotDiff, snapshotRestore, backupList, undoLastTool];
