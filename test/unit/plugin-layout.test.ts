/** The plugin folder (plugin/) as Claude Code installs it. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../helpers.js';

const P = path.join(ROOT, 'plugin');
const json = (f: string) => JSON.parse(readFileSync(path.join(P, f), 'utf8'));

describe('plugin/ layout', () => {
  it('runs the pinned npm package from the plugin folder, never through npx', () => {
    const mcp = json('.mcp.json');
    expect(mcp).toEqual({ mcpServers: { ctrlstream: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/node_modules/ctrlstream/dist/index.js'] } } });
    const pkg = json('package.json');
    expect(pkg).toEqual({ name: 'ctrlstream-plugin', private: true, dependencies: { ctrlstream: '0.1.0' } });
    expect(pkg.dependencies.ctrlstream).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the lockfile pins the same exact version from an https registry URL with an integrity hash', () => {
    const lock = json('package-lock.json');
    const pkg = json('package.json');
    const root = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
    const entry = lock.packages['node_modules/ctrlstream'];
    expect(entry.version).toBe(pkg.dependencies.ctrlstream);
    expect(entry.version).toBe(root.version);
    expect(entry.resolved).toBe(`https://registry.npmjs.org/ctrlstream/-/ctrlstream-${entry.version}.tgz`);
    expect(entry.integrity).toMatch(/^sha512-/);
    expect(Object.keys(lock.packages)).toEqual(['', 'node_modules/ctrlstream']);
  });

  it('the plugin knowledge tables are exact copies of knowledge/ (the skills read them at ${CLAUDE_PLUGIN_ROOT}/knowledge)', () => {
    for (const f of ['platforms.json', 'encoders.json']) {
      expect(readFileSync(path.join(P, 'knowledge', f), 'utf8')).toBe(readFileSync(path.join(ROOT, 'knowledge', f), 'utf8'));
    }
  });

  it('manifest, icon, skills, README and license are in place; no npx, no package-manager config, no system files', () => {
    const manifest = json('.claude-plugin/plugin.json');
    expect(manifest).toMatchObject({ name: 'ctrlstream', displayName: 'CTRLStream', version: '0.1.0', license: 'MIT', icon: './.claude-plugin/icon.png' });
    expect(readFileSync(path.join(P, '.claude-plugin', 'icon.png')).subarray(1, 4).toString()).toBe('PNG');
    for (const s of ['setup', 'troubleshoot', 'platforms']) expect(existsSync(path.join(P, 'skills', s, 'SKILL.md'))).toBe(true);
    const readme = readFileSync(path.join(P, 'README.md'), 'utf8');
    expect(readme.split('\n')[0]).toBe('# CTRLStream for OBS Studio');
    expect(readme.replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    for (const must of ['127.0.0.1', 'WebSocket password', '~/.ctrlstream', 'speed.cloudflare.com', 'redacted', 'Claude Code', 'Cowork']) expect(readme, must).toContain(must);
    expect(existsSync(path.join(P, 'LICENSE'))).toBe(true);
    const walk = (d: string): string[] => readdirSync(d).flatMap((e) => (statSync(path.join(d, e)).isDirectory() ? (e === 'node_modules' ? [] : walk(path.join(d, e))) : [path.join(d, e)]));
    const files = walk(P);
    expect(files.some((f) => /(\.DS_Store|Thumbs\.db|desktop\.ini|\.npmrc|bunfig\.toml)$/.test(f))).toBe(false);
    for (const f of files.filter((x) => !x.endsWith('.png'))) {
      expect(statSync(f).size, f).toBeLessThan(256 * 1024);
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\bnpx\b/);
    }
  });

  it('the root is only a marketplace pointing at ./plugin', () => {
    expect(existsSync(path.join(ROOT, '.claude-plugin', 'plugin.json'))).toBe(false);
    expect(existsSync(path.join(ROOT, '.mcp.json'))).toBe(false);
    const m = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0]).toMatchObject({ name: 'ctrlstream', source: './plugin' });
  });
});
