# @3d24rd0/pi-extensions

Personal suite of [Pi Coding Agent](https://pi.dev) extensions, skills, and prompts.

## Architecture

This repository is structured following Pi's conventional package layout:

```text
pi-extensions/
├── package.json              # Monorepo root & Pi package manifest
├── packages/                 # Standalone Pi extensions
│   └── pi-antigravity-bridge # Gemini & Claude provider via Antigravity ACP/CLI (includes AskAntigravity)
├── skills/                   # Reusable skills (SKILL.md)
├── prompts/                  # Markdown prompt templates (*.md)
└── themes/                   # Custom Pi TUI themes (*.json)
```

## Installation in Pi / Gentle Shell

Add to your `~/.gentle-shell/agent/settings.json` (or `.pi/settings.json`):

```json
{
  "packages": [
    "git:github.com/3d24rd0/pi-extensions"
  ]
}
```

Or install via Pi CLI:

```bash
pi install git:github.com/3d24rd0/pi-extensions
```

## Packages & Dependencies

- **`@3d24rd0/pi-antigravity-bridge`**: Gemini provider for Pi on the Antigravity ACP server (official Google ACP) or the stream-json `agy` CLI. Supports `gemini-4-argon`, `gemini-3.8-flash`, and Claude 5.5 models with reasoning effort toggles, conversation token estimation, and the built-in `AskAntigravity` delegation tool.
- **`@estebanforge/pi-tui-dialogs`**: Consumed directly from npm as a standard dependency (monitored via Dependabot).

## Development

```bash
npm install
npm run typecheck
npm test
```

## Acknowledgements

Based on the original monorepo and extensions developed by [@EstebanForge](https://github.com/EstebanForge):
- Source repository: [EstebanForge/pi-extensions](https://github.com/EstebanForge/pi-extensions)
- Special thanks to Esteban for creating the foundational Pi extensions and tooling ecosystem.

## License

MIT
