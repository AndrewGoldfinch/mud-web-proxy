# Documentation Changelog

## 2026-02-08 — Documentation Audit & Update

### README.md
- Updated project description from "node.js microserver" to "Bun / TypeScript microserver"
- Fixed installation commands: replaced `sudo bun wsproxy.js` with `bun dev` (development) and `bun run build && bun start` (production)
- Fixed certificate error example: replaced `sudo node wsproxy.js` with `bun dev`
- Updated file listing: replaced `wsproxy.js`, `node_modules`, `package-lock.json` with `wsproxy.ts`, `dist/`, `src/`, `tsconfig.json`
- Changed configuration section from "In `wsproxy.js`" to "In `wsproxy.ts`" with TypeScript code block
- Added environment variables table (`WS_PORT`, `TN_HOST`, `TN_PORT`, `DISABLE_TLS`)

### docs/MOCK_MUD.md
- Updated file structure section to include all actual files: `proxy-launcher.ts`, `connection-helper.ts`, `config-loader.ts`, `run-mock-tests.ts`, `achaea.test.ts`, and other test/doc files

### tests/e2e/README.md
- Added Achaea row to Supported MUDs table (`achaea.test.ts`, GMCP)

### E2E_TESTS_SUMMARY.md
- Added `tests/e2e/achaea.test.ts` to MUD-Specific Tests list

### docs/mud-proxy-prd.md
- Removed non-existent CLI arguments (`--config`, `--port`, `--buffer-size`, `--log-level`) from Command Line Usage section
- Added Achaea to MUD compatibility checklist
