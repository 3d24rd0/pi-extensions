# @3d24rd0/pi-extensions

> Suite personal de extensiones, skills, prompts y temas para [Pi Coding Agent](https://pi.dev) / Gentle Shell.

---

## Estructura del Repositorio

El monorepo organiza las herramientas de Pi bajo una estructura limpia sin pasos de compilación (TypeScript puro cargado en tiempo de ejecución):

```text
pi-extensions/
├── package.json              # Manifiesto raíz y paquete Pi
├── packages/                 # Extensiones independientes
│   └── pi-antigravity-bridge # Provider para Google Antigravity (ACP/CLI)
├── skills/                   # Habilidades del agente (SKILL.md)
├── prompts/                  # Plantillas de prompt (*.md)
└── themes/                   # Temas para la TUI de Pi (*.json)
```

---

## Instalación

### En Gentle Shell / Pi
Añade el repositorio directamente en tu archivo de configuración `~/.gentle-shell/agent/settings.json` (o `~/.pi/agent/settings.json`):

```json
{
  "packages": [
    "git:github.com/3d24rd0/pi-extensions"
  ]
}
```

O instala mediante la CLI de Pi:
```bash
pi install git:github.com/3d24rd0/pi-extensions
```

---

## Paquetes Incluidos

- **[`@3d24rd0/pi-antigravity-bridge`](packages/pi-antigravity-bridge):**
  Proveedor de modelos de Google Antigravity (Gemini 4 Argon, Gemini 3.8 Flash y Claude 5.5) y herramienta de delegación `AskAntigravity`. Permite alternar entre el servidor oficial ACP (imágenes, tarjetas nativas) y el motor CLI stream-json directamente al seleccionar el modelo en `/model`.

---

## Desarrollo y Verificación

```bash
# Instalar dependencias raíz
npm install

# Comprobación de tipos y ejecución de la suite completa de tests
npm run check
```

---

## Licencia

[MIT](LICENSE)
