# @3d24rd0/pi-extensions

> Personal suite of extensions, skills, prompts, and themes for [Pi Coding Agent](https://pi.dev) / Gentle Shell.

---

## Repository Structure

Pure TypeScript monorepo with no build step required (loaded directly by Pi at runtime):

```text
pi-extensions/
├── package.json              # Root manifest & Pi package definition
├── packages/                 # Standalone extensions
│   └── pi-antigravity-bridge # Google Antigravity provider (ACP/CLI)
├── skills/                   # Reusable agent skills (SKILL.md)
├── prompts/                  # Prompt templates (*.md)
└── themes/                   # Custom Pi TUI themes (*.json)
```

---

## Installation

### In Gentle Shell / Pi
Add the repository directly to your `~/.gentle-shell/agent/settings.json` (or `~/.pi/agent/settings.json`):

```json
{
  "packages": [
    "git:github.com/3d24rd0/pi-extensions"
  ]
}
```

Or install via the Pi CLI:
```bash
pi install git:github.com/3d24rd0/pi-extensions
```

---

## Included Packages

- **[`@3d24rd0/pi-antigravity-bridge`](packages/pi-antigravity-bridge):**
  Google Antigravity model provider (Gemini 4 Argon, Gemini 3.8 Flash, and Claude 5.5) and `AskAntigravity` delegation tool. Allows switching between the official ACP server (images, native diff cards) and the stream-json CLI engine directly by selecting the model variant in `/model`.

---

## Development & Verification

```bash
# Install root dependencies
npm install

# Run type checking and test suite
npm run check
```

---

## License

[MIT](LICENSE)
