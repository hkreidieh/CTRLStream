# CTRLStream for OBS Studio: Claude Desktop extension

`manifest.json` here is the extension manifest. Its `tools`, `prompts` and `version` are generated from the server's own registry by `scripts/gen-mcpb-manifest.ts`, which `pnpm build` runs after bundling; `test/unit/mcpb-manifest.test.ts` fails if they drift. Edit the other fields by hand.

The server is one self-contained file, `dist/index.js`, with its dependencies and the knowledge tables built in, so the extension needs no `node_modules` and no `knowledge/` folder. Stage exactly these four files, validate, and pack:

```sh
pnpm install && pnpm build
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/dist"
cp dist/index.js "$STAGE/dist/index.js"
cp mcpb/manifest.json "$STAGE/manifest.json"
cp mcpb/README.md "$STAGE/README.md"
cp LICENSE "$STAGE/LICENSE"
mkdir -p build
(cd "$STAGE" && npx -y @anthropic-ai/mcpb validate manifest.json && npx -y @anthropic-ai/mcpb pack . "$OLDPWD/build/ctrlstream.mcpb")
```

`build/` and `*.mcpb` are git-ignored. The `user_config` fields map to the environment variables the server reads: `CTRLSTREAM_DIR`, `CTRLSTREAM_OBS_HOST`, `CTRLSTREAM_OBS_PORT` and `CTRLSTREAM_OBS_PASSWORD`. An optional field left empty arrives as a literal `${user_config...}` string, which the server treats as unset. The extension also serves the setup, troubleshoot and platforms guides as MCP prompts and through the `get_started` tool, so it works without the CTRLStream plugin's skills.
