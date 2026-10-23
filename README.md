# @3d24rd0/pi-extensions

Personal suite of [Pi Coding Agent](https://pi.dev) extensions, skills, and prompts.

## Architecture

This repository is structured following Pi's conventional package layout:

```text
pi-extensions/
├── package.json              # Monorepo root & Pi package manifest
├── packages/                 # Standalone Pi extensions
│   ├── pi-antigravity-bridge # Gemini & Claude provider via Antigravity ACP/CLI
│   ├── pi-ask-antigravity    # AskAntigravity delegation tool
│   ├── pi-ask-shared         # Shared runtime for delegation & peer consults
│   └── pi-tui-dialogs        # TUI dialog components for Pi extensions
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

## Included Packages

- **`@estebanforge/pi-antigravity-bridge`**: Gemini provider for Pi on the Antigravity ACP server (official Google ACP) or the stream-json `agy` CLI. Supports `gemini-4-argon`, `gemini-3.8-flash`, and Claude 5.5 models with reasoning effort toggles and conversation token estimation.
- **`@estebanforge/pi-ask-antigravity`**: `AskAntigravity` delegation tool to delegate isolated tasks to `agy`.
- **`@estebanforge/pi-ask-shared`**: Common peer consult, argv parsing, and model alias resolution runtime.
- **`@estebanforge/pi-tui-dialogs`**: TUI dialog helpers and interactive settings menus for Pi.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
