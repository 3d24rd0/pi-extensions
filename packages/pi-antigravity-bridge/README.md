# pi-antigravity-bridge

> Provider de modelos de Google Antigravity (Gemini 4 Argon, Gemini 3.8 Flash y Claude 5.5) y herramienta de delegación `AskAntigravity` para [pi](https://github.com/earendil-works/pi), usando tu propia cuota de suscripción.

Soporta dos motores de ejecución seleccionables directamente desde el modelo:
- **ACP (Official Server):** Servidor oficial de Google (`agy_acp_server.par`) vía JSON-RPC. Soporta imágenes y tarjetas nativas con diffs en Pi.
- **CLI (stream-json):** Proceso persistente de la CLI `agy`. Soporta modelos Claude y puente completo de herramientas de Pi vía MCP.

---

## Inicio Rápido

### 1. Requisitos
Tener instalada y autenticada la CLI oficial de Antigravity:
```bash
# Verificar instalación y autenticación
agy models
```

### 2. Instalación en Pi
```bash
pi install git:github.com/3d24rd0/pi-extensions
```

### 3. Selección de Modelo
Abre el selector interactivo en Pi:
```bash
/model
```
Elige cualquier modelo bajo el namespace `antigravity/`:
- `Gemini 4 Argon (ACP)` o `(CLI)`
- `Gemini 3.8 Flash (ACP)` o `(CLI)`
- `Claude Opus 5.5 (CLI)`
- `Claude Sonnet 5.5 (CLI)`

*(Nota: Los modelos Gemini y Claude incluyen selector de nivel de pensamiento: `low`, `medium`, `high`).*

---

## Modelos y Motores

| Modelo | Motor | Entrada | Herramientas Pi | Características |
|---|---|---|---|---|
| **Gemini 4 Argon (ACP)** | ACP | Texto + Imagen | Sí (vía Bridge MCP) | Razonamiento profundo, tarjetas nativas con diffs |
| **Gemini 4 Argon (CLI)** | CLI | Texto | Sí (vía Bridge MCP) | Razonamiento profundo vía CLI agy |
| **Gemini 3.8 Flash (ACP)** | ACP | Texto + Imagen | Sí (vía Bridge MCP) | Máxima velocidad, bajo consumo de cuota |
| **Gemini 3.8 Flash (CLI)** | CLI | Texto | Sí (vía Bridge MCP) | Ejecución rápida stream-json |
| **Claude Opus 5.5 (CLI)** | CLI | Texto | Sí (vía Bridge MCP) | Razonamiento avanzado Claude |
| **Claude Sonnet 5.5 (CLI)** | CLI | Texto | Sí (vía Bridge MCP) | Balance velocidad/calidad Claude |

---

## Comandos `/agy`

Configura y diagnostica el proveedor en tiempo real. Los ajustes se guardan en `~/.pi/agent/antigravity-bridge/config.json`:

| Comando | Descripción |
|---|---|
| `/agy` | Abre el menú interactivo de configuración (TUI). |
| `/agy doctor` | Diagnóstico completo: estado de conexión, contadores, versiones y rutas. |
| `/agy auth` | Inicia sesión en el servidor ACP abriendo el navegador. |
| `/agy quota` | Muestra la cuota restante de tu suscripción de Antigravity. |
| `/agy mode accept-edits \| plan` | Cambia el modo de ejecución (por defecto `accept-edits`). |
| `/agy ask on \| off` | Activa/desactiva la herramienta de delegación `AskAntigravity`. |
| `/agy bridge all \| mcp \| none` | Qué herramientas de Pi se exponen a Antigravity (por defecto `all`). |
| `/agy tools [hide \| show \| reset]` | Oculta herramientas específicas de Pi del catálogo del modelo. |
| `/agy clear` | Limpia los enlaces de conversación guardados (fuerza sesión limpia). |

---

## Delegación con `AskAntigravity`

La extensión incluye la herramienta `AskAntigravity` para delegar subtareas en una instancia aislada de `agy`:
```markdown
Usa AskAntigravity para investigar o resolver un problema en segundo plano.
Parámetros: prompt, model (opcional), thinking (opcional), includeContext (opcional).
```

---

## Ubicación de Datos y Logs

Todo el almacenamiento persistente se consolida bajo un único directorio limpio:

```
~/.pi/agent/antigravity-bridge/
├── config.json           # Configuración de usuario
├── sessions.json         # Enlaces de sesión Pi <-> Conversación agy
├── models-cache.json     # Caché del catálogo de modelos agy
├── suppression.json      # Marcador de concurrencia del bridge
├── ask-context/          # Temporales para exportación de contexto
└── logs/                 # Logs diarios de diagnóstico
    └── YYYY-MM-DD.ndjson
```

- **Privacidad:** No se registran prompts, argumentos sensibles ni secretos (redacción automática activa).
- **Retención:** 14 días. Archivos antiguos se purgan automáticamente.

---

## Documentación Técnica Avanzada

Para profundizar en el diseño interno y protocolos:
- [Arquitectura del Bridge](docs/ARCHITECTURE.md): protocolo de round-trip MCP, manejo de suspensiones y timeouts.
- [Approval Gate](docs/APPROVAL-GATE.md): intercepción y control de permisos en herramientas nativas de agy.
- [Comparativa de Motores](docs/ENGINES.md): detalles entre JSON-RPC (ACP) y stream-json (CLI).
- [Guía de Desarrollo](docs/DEVELOPMENT.md): instrucciones para tests, mocks y depuración.

---

## Agradecimientos y Licencia

Basado en la extensión original desarrollada por [@EstebanForge](https://github.com/EstebanForge) en [EstebanForge/pi-extensions](https://github.com/EstebanForge/pi-extensions).

Licencia [MIT](LICENSE).
