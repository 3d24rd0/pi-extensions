# Bridge Architecture & Cleanup Refactor

Reorganize `pi-antigravity-bridge` into clean, maintainable, single-responsibility modules, drop legacy compatibility clutter, and document exact operational mechanics for uninterrupted continuity across LLM models and subscription tiers.

## Specs

- S1: Eliminate retired and dead family handling (such as `HIDDEN_FAMILY_RE = /^gpt-oss-/`) so models in the CLI catalog are discovered cleanly without artificial censorship, and streamline `models.ts` and `agy-peer.ts`.
- S2: Decouple `packages/pi-antigravity-bridge/extensions/index.ts` (>2000 LOC monolithic entrypoint) by extracting `/agy` command handlers, UI rendering, and session lifecycle into dedicated modules (`commands/`, `ui/`, `lifecycle.ts`).
- S3: Decouple `packages/pi-antigravity-bridge/src/provider.ts` (>1800 LOC) by separating prompt assembly, context digest, and tool round-trip orchestration (`tool-roundtrips.ts`, `prompt-assembly.ts`).
- S4: Standardize dual-engine mechanics (ACP for Gemini models with multimodal capability vs stream-json for Claude / CLI-only models) with explicit tests for both pathways and clear logging.
- S5: Ensure all vitest suites pass (100% test coverage preserved and updated for refactored boundaries) and typecheck succeeds with zero errors (`npm run check`).

## Tasks

- [ ] T1: (S1) Remove GPT-OSS censorship and clean up model resolution catalog.
- [ ] T2: (S2) Extract `/agy` command tree and settings UI from `extensions/index.ts` into structured helper modules.
- [ ] T3: (S3) Split `provider.ts` into focused modules (`tool-roundtrips.ts`, `prompt-digest.ts`).
- [ ] T4: (S4, S5) Validate full test suite and verify both ACP and stream-json engine dispatch.

## Log

- L1: User request: "no te preocupes por lo de argon ponle con acp y cli ni te ralles con retrocompatiblidad vamos a por algo correcto solo lo uso yo, y si agamoslo con seguridad ya que nos estamos quedando sin subscripcion que quededigamos todo registardo de que ivamos ha hacer y que hicimos para cuando nos quedemos sin sub podamos reanudar luego con otro modelo, ademas que luego pasamos a uno mas tonto por lo que si le dejamos todo masticado lo complicado mejor"
