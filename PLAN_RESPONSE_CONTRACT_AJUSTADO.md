# Plan ajustado — Arquitectura `responseContract`

> Versión validada contra el código real (2026-06-27). Reencuadra el plan original
> `PROMPTS_COWORK_RESPONSE_CONTRACT.md` tras leer `chatRag.ts` (1273 líneas),
> `assistant-schema.ts`, `rag-avatar.service.ts`, `intent-router.ts`,
> `number-speech.ts` y `conversation.service.ts`.
>
> Reglas transversales: NO romper funcionalidad existente; validar antes de continuar;
> **código fuente solo-ASCII** (convención del repo: incluso strings en español van sin
> acento, ej. `chatRag.ts:1118` "Cual buscas?"); no build/deploy en sandbox.

## Decisiones tomadas (usuario, 2026-06-27)

1. **Enfoque = extraer lo existente.** Grabovoi y Pastor YA están implementados
   hardcodeados en `chatRag.ts`. Se refactorizan a handlers dirigidos por contrato,
   no se reescriben. Alinea con el comentario `chatRag.ts:60` que ya anticipa este refactor.
2. **Dispatch = contrato + intención.** `responseContract.kind` selecciona una FAMILIA
   y restringe; el `intent-router`/`mode` existente sigue eligiendo el sub-camino por turno
   (saludo / capacidades / cita literal / protocolo / interpretativo).
3. **Dígito-por-dígito = cliente.** Se mantiene `lib/lipsync/number-speech.ts`
   (`DIGIT_SEQUENCE_MIN_LEN=5`). El servidor devuelve códigos verbatim; NO se reformatea
   dígito-a-dígito en el servidor para no duplicar/chocar con el path de síntesis.

## Estado actual del código (lo que YA existe)

| Capacidad | Dónde vive hoy | Implicación |
|---|---|---|
| Grabovoi: explorar categoría | `answerCategoryExplore`, `parseCategoryChunk`, `splitNameCode` | Extraer a handler |
| Grabovoi: armar protocolo | `answerProtocolAssembly`, `PROTOCOL_RE` | Extraer a handler |
| Anti-alucinación de códigos | `enforceVerbatimCodes` (reemplaza códigos ≥4 dígitos no presentes en el chunk) | Reusar como `validate` |
| Pastor: cita literal | `answerTextualQuote`, `parseScriptureRef`, `parseVerses`, mode `textual_quote` | Extraer a handler |
| Grounding | `knowledgeMode` (rag_only/hybrid/training_only) + `relevanceThreshold` | Ya es la base del Pastor |
| Forma de respuesta | `{ summary, detail, body, gestureCommands, media, sources, detailAvailable, quota }` | `segments` se agrega opcional |
| Selección de comportamiento por turno | cliente `classifyQueryMode()` -> `mode`; servidor flags `categoryExplore`/`PROTOCOL_RE` | El contrato configura; la intención sigue routeando |

## Fases ajustadas

### Fase 1 — Tipos del contrato (`rag.models.ts`) — ADITIVO, sin riesgo
Igual al plan original. Agregar `ResponseContractKind`, `ValidationRule`, `ResponseContract`,
`ResponseSegment`, campo opcional `responseContract?` en `AssistantConfig`, y
`DEFAULT_PLAIN_CONTRACT`. Solo se agrega; no se reordenan campos existentes. ASCII-only.

### Fase 2 — Migración v5 (`assistant-schema.ts`) — ADITIVO, sin riesgo
Subir `ASSISTANT_SCHEMA_VERSION` 4 -> 5. `MigrationStep {to:5}` que asigna
`DEFAULT_PLAIN_CONTRACT` si `responseContract` falta; idempotente; no toca otros campos.
Sigue el patrón exacto de los steps existentes (mutación in-place de `d`).
NOTA: `rag.models.ts` es del cliente y `assistant-schema.ts` corre tanto en cliente como
referenciado por `functions/backfill.ts`; verificar que el import de `DEFAULT_PLAIN_CONTRACT`
no cree dependencia circular ni rompa el bundle de functions.

### Fase 3 — Registro de handlers (server) — NUEVO, aislado
Crear `functions/src/lib/response-contracts/`:
- `types.ts` — `interface ResponseHandler { buildPrompt; parse; validate; normalize }`.
  Las firmas deben aceptar el contexto que `chatRag` ya arma (chunks `matched`, `query`,
  `language`, `profile`, `genContext`, `genPersona`) y producir la forma que `chatRag` ya
  devuelve (`summary`, `detail`, `media`, `sources`, y opcional `segments`).
- `plain.handler.ts` — replica el path genérico actual (summary-only + split). Debe ser
  indistinguible de hoy.
- `registry.ts` — `HANDLERS: Record<ResponseContractKind, ResponseHandler>` + `getHandler(kind)`
  con fallback a `plain`.
Sin conectar a chatRag.

### Fase 4 — Conectar al dispatch existente (AJUSTE IMPORTANTE)
El plan original asume "un solo LLM call" envuelto. **No es así.** `chatRag` tiene una
escalera de ramas ANTES del path genérico: `capabilities` -> `detail` -> `suggestions`
-> `textual_quote` -> protocolo/category-explore -> summary genérico. La integración:
- Resolver `config.responseContract` (o `DEFAULT_PLAIN_CONTRACT`).
- `getHandler(kind)` se consulta DENTRO de la rama por-turno, no la reemplaza:
  el `mode`/intent decide la rama; el handler decide cómo se arma el prompt/validación/normalize
  de ESA rama según el kind.
- `kind='plain'` -> salida byte-idéntica a hoy.
- `kind!='plain'` -> `buildPrompt -> LLM -> parse -> validate -> normalize`, todo en
  `try/catch` con FALLBACK a `plain` y log del motivo (sin secretos). El usuario nunca ve error crudo.
Restricción dura: asistentes sin contrato / plain = comportamiento idéntico.

### Fase 5 — Handler `sequence_catalog` (EXTRAER Grabovoi)
Mover la lógica de `answerCategoryExplore` + `answerProtocolAssembly` + `enforceVerbatimCodes`
al handler. `validate` = `enforceVerbatimCodes` (cada código debe aparecer literal en su chunk).
`normalize` arma `segments` con `display` agrupado (ej. "520 857") y deja `spoken` con el código
**verbatim** (el dígito-por-dígito lo hace el cliente). Respetar `categoryExplore`/`PROTOCOL_RE`
existentes (el dispatch por-turno no cambia; solo se reubica el cuerpo).

### Fase 6 — Handler `cited_scripture` (EXTRAER Pastor)
Mover `answerTextualQuote` + `parseScriptureRef` + `parseVerses`. `validate` exige >=1 cita y
que `citation.text` corresponda al chunk de `sourceChunkId`; `reference` con formato
libro/capítulo/versículo. Asume `knowledgeMode='rag_only'` + `relevanceThreshold` alto
(por config del asistente, no en el handler). Fallback amable configurable vía `groundingRules`.

### Fase 7 — Cliente consume `segments` (sin romper plain)
`rag-avatar.service.normalize`: si la respuesta trae `segments`, usar `segment.spoken` para
TTS/visemas y `segment.display` para el chat; si no, derivar `spoken=display=texto` (idéntico a hoy).
NO reimplementar dígito-por-dígito: `number-speech.ts` sigue actuando en síntesis sobre el
`spoken`. Verificar karaoke + panel de media en ambos casos.

### Fase 8 — UI Assistant Manager
Sección "Contrato de respuesta": selector de `kind`, editores de `outputSchema` (JSON),
`promptFragments` (textarea), `validation` (lista), `rendering` (templates). Plantilla por
defecto al elegir kind. Persistir `assistants/{id}.responseContract` con `schemaVersion=5`.
Signals/computed (zoneless), tema oscuro/violeta, ASCII-only.

### Fase 9 — Verificación + backfill (sin deploy)
Revisión por lectura de los 3 casos (plain idéntico / Grabovoi verbatim+protocolo / Pastor exige cita).
Proponer (sin ejecutar) `backfillAssistants` para poblar `responseContract=plain`. Checklist final:
archivos por fase, pasos del usuario (`cd functions && npm install && npm run build`, deploy),
riesgos residuales y rollback por fase.

## Orden de ejecución y checkpoints
1-2 (aditivo, sin riesgo) -> **checkpoint** -> 3 (aislado) -> 4 (sensible, chatRag) -> **checkpoint**
-> 5-6 (extracción) -> 7 (cliente) -> 8 (UI) -> 9 (cierre). Build/deploy los corre el usuario.
