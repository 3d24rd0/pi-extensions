# Bridge Architecture & Cleanup Refactor

Reorganize `pi-antigravity-bridge` into clean, maintainable, single-responsibility modules, drop legacy compatibility clutter, and document exact operational mechanics for uninterrupted continuity across LLM models and subscription tiers.

## Specs

- S1: Eliminate retired and dead family handling (such as `HIDDEN_FAMILY_RE = /^gpt-oss-/`) so models in the CLI catalog are discovered cleanly without artificial censorship, and streamline `models.ts` and `agy-peer.ts`.
- S2: Decouple `packages/pi-antigravity-bridge/extensions/index.ts` (>2000 LOC monolithic entrypoint) by extracting `/agy` command handlers, UI rendering, and session lifecycle into dedicated modules (`commands/`, `ui/`, `lifecycle.ts`).
- S3: Decouple `packages/pi-antigravity-bridge/src/provider.ts` (>1800 LOC) by separating prompt assembly, context digest, and tool round-trip orchestration (`tool-roundtrips.ts`, `prompt-digest.ts`).
- S4: Standardize dual-engine mechanics (ACP for Gemini models with multimodal capability vs stream-json for Claude / CLI-only models) with explicit tests for both pathways and clear logging.
- S5: Ensure all vitest suites pass (100% test coverage preserved and updated for refactored boundaries) and typecheck succeeds with zero errors (`npm run check`).

## Tasks

- [x] T1: (S1) Remove GPT-OSS censorship and clean up model resolution catalog. (`84df3bb`)
- [x] T2: (S2) Extract `/agy` command tree and settings UI from `extensions/index.ts` into structured helper modules (`src/commands.ts`). (`b029920`)
- [x] T3: (S3) Split `provider.ts` into focused modules (`tool-roundtrips.ts`, `prompt-digest.ts`). (`193b317`)
- [x] T4: (S4, S5) Validate full test suite, update architecture docs, and verify dual-engine dispatch.

## Continuity & Handover Guide for Future Models

> [!IMPORTANT]
> If you are an LLM resuming work on this repository (even a smaller/cheaper model after subscription rollover): read this section first! Everything is organized and tested.

### 1. Dual-Engine Architecture
The package supports two backend engines for executing Antigravity turns:
1. **ACP (`agy_acp_server.par`)**: Google's official Agent Client Protocol JSON-RPC server.
   - Used for **Gemini models** (e.g. `gemini-3-8-flash`).
   - Supports multimodal inputs (images sent in prompt arrays).
   - **Crucial limitation**: The ACP server (v1.4.1) under Google AI Pro OAuth rejects non-Gemini models with RPC error `-32602`.
2. **Stream-JSON CLI (`agy -p` / `--input-format stream-json --output-format stream-json`)**:
   - Used for **Claude models** (`claude-sonnet-5-5`, `claude-opus-5-5`) and **GPT-OSS models**.
   - Accepts prompt text on stdin and streams NDJSON events on stdout.
3. **Automatic Routing**:
   - In `packages/pi-antigravity-bridge/src/provider.ts`, `streamTurn` dynamically resolves the engine:
     ```ts
     const activeEngine = resolvedEngine === "acp" && !isAcpCapableModel(model.id)
         ? "stream-json"
         : resolvedEngine;
     ```
   - When the user selects Claude in Pi, it routes to `stream-json`. When selecting Gemini, it uses `acp`.

### 2. Module Boundaries
- `extensions/index.ts`: Pi extension entry point. Registers provider, models, slash commands (`registerAgyCommand`), and shadow tools.
- `src/commands.ts`: The `/agy` command tree (settings UI, login, engine picker, doctor).
- `src/provider.ts`: Core provider implementation (`antigravityProvider`, `streamTurn`).
- `src/prompt-digest.ts`: User prompt extraction, image extraction, system prompt framing, and G1 context delta digest.
- `src/tool-roundtrips.ts`: G9 no-patch tool execution (`ToolRoundTrips`), `EscalationRegistry`, fast-ack & polling (`bridge_poll_result`), `WrapperReplay`.
- `src/models.ts`: Full model catalog, thinking effort mappings, `isAcpCapableModel`.
- `src/acp/`: ACP JSON-RPC client, connection, driver, and event mapping.
- `src/driver.ts`: CLI stream-json process management.
- `src/mcp-server.ts`: Local MCP server bridging Pi tools to Antigravity.

### 3. How to Run Checks
Always run checks from the repository root (`~/Documents/GitHub/pi-extensions`):
```bash
npm run check
```
This executes:
- `tsc --noEmit` (TypeScript typecheck across all workspaces)
- `vitest run` (53 test files, 636 tests - all must pass)

### 4. How to Sync with Gentle Shell
When changes are committed to `main` and pushed:
```bash
gentle-shell update --extensions
```
If Gentle Shell ever reports `Cannot find module '@estebanforge/...'`, check for orphaned symlinks in `~/.gentle-shell/agent/git/.../node_modules/@estebanforge/`.

## Log

- L1: User request: "no te preocupes por lo de argon ponle con acp y cli ni te ralles con retrocompatiblidad vamos a por algo correcto solo lo uso yo, y si agamoslo con seguridad ya que nos estamos quedando sin subscripcion que quededigamos todo registardo de que ivamos ha hacer y que hicimos para cuando nos quedemos sin sub podamos reanudar luego con otro modelo, ademas que luego pasamos a uno mas tonto por lo que si le dejamos todo masticado lo complicado mejor"
- L2: T1 completed (commit `84df3bb`): Removed artificial `HIDDEN_FAMILY_RE = /^gpt-oss-/` filtering from `models.ts` and `agy-peer.ts`. Updated tests.
- L3: T2 completed (commit `b029920`): Extracted `/agy` command handlers and interactive settings UI into `src/commands.ts`.
- L4: T3 completed (commit `193b317`): Extracted `src/prompt-digest.ts` and `src/tool-roundtrips.ts` from `src/provider.ts`. Re-exported symbols to preserve 100% test compatibility. All 636 tests pass.
- L5: T4 completed: Updated `packages/pi-antigravity-bridge/docs/ARCHITECTURE.md` and added continuity guide for future LLM models.
