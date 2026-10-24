# Documento de especificación y tareas: Refactor Modelo+Motor y Limpieza en pi-antigravity-bridge

> Spec: odd/tasks/bridge-model-engine.md  
> Creado: 2026-10-25  
> Repo: ~/Documents/GitHub/pi-extensions  
> Estado: Completado con éxito (53 archivos de test, 638 tests pasando)

## Specs

- S1: "osea puedo elegir gemini acp o gemini json stream como si fueran 2 y asi no hay que estar eligiendo el motor por separado" (El usuario no quiere un selector global de motor desconectado de los modelos, sino que cada modelo exponga explícitamente sus variantes según los motores que soporta).
- S2: "no te preocupes por lo de argon ponle con acp y cli ni te ralles con retrocompatiblidad vamos a por algo correcto solo lo uso yo" (Nombrado limpio sin ataduras a retrocompatibilidad: sufijos explícitos `-acp` y `-cli`, ej: `gemini-4-argon-acp`, `gemini-4-argon-cli`, `gemini-3.8-flash-acp`, `gemini-3.8-flash-cli`, `claude-opus-5-5-cli`, `claude-sonnet-5-5-cli`).
- S3: "si gpt se va a morir ni nos preocupamos pues" (Mantener `gpt-oss` excluido/oculto ya que se retira el 2 de noviembre de 2026).
- S4: "y claro aunque estemos en un modo entiendo que si el otro nos da otras erramientas debemos dejar usarlas, mas bien seria que si hay un modelo que no soporta acp pues no dar la opcion no? pero que funcione todo lo demas posible claro" (Claude solo existe en variante CLI/stream-json. Las herramientas de pi y el MCP bridge `registerBridgeServer` deben estar siempre operativas para cualquier modelo CLI, resolviendo el bug P1.1 donde Claude bajo configuración ACP no tenía acceso a pi tools).
- S5: "Cambiamos el nombre del paquete de @estebanforge/pi-antigravity-bridge a @3d24rd0/pi-antigravity-bridge (y también author y repository)? — Sí, cambiarlo a @3d24rd0 (Recomendado)" (Renombrar manifest y dependencias correspondientes, eliminando referencias al paquete eliminado `@estebanforge/pi-ask-antigravity`).
- S6: "agamoslo con seguridad ya que nos estamos quedando sin subscripcion que quededigamos todo registardo de que ivamos ha hacer y que hicimos para cuando nos quedemos sin sub podamos reanudar luego con otro modelo, ademas que luego pasamos a uno mas tonto por lo que si le dejamos todo masticado lo complicado mejor" (Todo desglosado minuciosamente con contratos de tipos, rutas de archivos y pruebas para que cualquier modelo pueda ejecutar tarea por tarea sin perderse).

## Tasks

- [x] T1: (S1, S2, S3) Definir en `packages/pi-antigravity-bridge/src/models.ts` la tabla única de capacidades por familia y generar las entradas modelo+motor (`-acp`, `-cli`).
  - Archivos: `src/models.ts`, `tests/models.test.ts`.
  - Completado: `expandAgyModels` y `parseModelEngine` generan e interpretan variantes `-acp` y `-cli`.
- [x] T2: (S1, S4) Inicializar concurrentemente ambos motores (ACP y stream-json) en `extensions/index.ts` y enrutar en `src/provider.ts` por el motor embebido en el modelo.
  - Archivos: `extensions/index.ts`, `src/provider.ts`, `tests/provider-streaming.test.ts`.
  - Completado: `registerBridgeServer` se registra incondicionalmente para que modelos `-cli` siempre tengan acceso a tools pi. Renderers e indicadores de uso se registran de forma reactiva al modelo activo.
- [x] T3: (S1) Retirar el comando `/agy engine` y simplificar la configuración.
  - Archivos: `extensions/index.ts`, `src/commands.ts`, `src/engine-picker.ts`.
  - Completado: Se eliminó el wizard de arranque y la opción de menú `/agy engine`. `/agy engine` ahora informa al usuario que use `/model` directamente.
- [x] T4: (S5) Renombrar el paquete a `@3d24rd0/pi-antigravity-bridge` y limpiar referencias obsoletas.
  - Archivos: `packages/pi-antigravity-bridge/package.json`, `packages/pi-antigravity-bridge/src/ask-tool.ts`, `packages/pi-antigravity-bridge/README.md`, `README.md`.
  - Completado: Paquete renombrado a `@3d24rd0/pi-antigravity-bridge` con author y repository apuntando a 3d24rd0. Purgadas menciones a `@estebanforge/pi-ask-antigravity`.
- [x] T5: (S6) Verificación integral (`npm run check`) y actualización de Engram.
  - Completado: `npm run check` pasando con 53 suites y 638 tests.

## Log

- L1: Usuario solicita: "no te preocupes por lo de argon ponle con acp y cli ni te ralles con retrocompatiblidad vamos a por algo correcto solo lo uso yo, y si agamoslo con seguridad ya que nos estamos quedando sin subscripcion que quededigamos todo registardo de que ivamos ha hacer y que hicimos para cuando nos quedemos sin sub podamos reanudar luego con otro modelo, ademas que luego pasamos a uno mas tonto por lo que si le dejamos todo masticado lo complicado mejor".
- L2: Usuario pregunta si actualmente estamos con json stream tras el cambio a Gemini 3.8 Flash (Medium).
- L3: Verificación de T1 completada previamente. T2 implementada permitiendo registro universal del bridge MCP y enrutado dual según sufijo del modelo. T3 completada desactivando el engine-picker invasivo y orientando `/agy engine` hacia `/model`. T4 completada renombrando manifest a `@3d24rd0/pi-antigravity-bridge`. T5 verificada al 100% pasando `npm run check`.
