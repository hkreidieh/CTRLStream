import { defineConfig } from 'tsup';

// One self-contained ESM file: Claude Desktop (.mcpb) and `npx ctrlstream`
// both run dist/index.js directly. Every dependency is bundled in, so the CJS
// ones (systeminformation, ws) need a real `require`, which the banner provides.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  minify: false,
  noExternal: [/.*/],
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __ctrlstreamCreateRequire } from 'node:module';",
      'const require = __ctrlstreamCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
