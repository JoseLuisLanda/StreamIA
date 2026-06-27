# responseContract — verificación y checklist final

> Integración completa de las 9 fases (reencuadradas). Estado: editado y revisado por
> LECTURA (no se puede build/deploy en el sandbox). NUL=0 en todos los archivos; código
> fuente ASCII-only. Build/deploy los corres tú.

## Archivos tocados por fase

**Fase 1 — tipos (cliente)**
- `src/app/lib/rag/rag.models.ts`: + `ResponseContractKind`, `ValidationRule`, `ResponseContract`, `ResponseSegment`, `DEFAULT_PLAIN_CONTRACT`, campo `AssistantConfig.responseContract?`, y `RagResponse.segments?` (Fase 7).

**Fase 2 — migración v5 (cliente)**
- `src/app/lib/rag/assistant-schema.ts`: `ASSISTANT_SCHEMA_VERSION` 4 -> 5; `MigrationStep {to:5}` que asigna `DEFAULT_PLAIN_CONTRACT` (clon profundo) si falta.

**Fase 3 — registro de handlers (server, nuevo)**
- `functions/src/lib/response-contracts/types.ts`: interfaces + `ResponseHandler` + `DEFAULT_PLAIN_CONTRACT` (server).
- `functions/src/lib/response-contracts/plain-core.ts`: helpers puros extraídos verbatim de chatRag (directivas + `extractSummaryDetail` + `extractMediaSelection`).
- `functions/src/lib/response-contracts/plain.handler.ts`: handler `plain` (byte-idéntico al path actual).
- `functions/src/lib/response-contracts/registry.ts`: `getHandler(kind)` con fallback a plain.

**Fase 4 — integración en chatRag (server, sensible)**
- `functions/src/chatRag.ts`: lee `responseContract` del doc; gate Grabovoi ahora `categoryExplore || kind==='sequence_catalog'`; el bloque genérico STAGE-1 usa el handler (`buildPrompt -> LLM -> parse -> validate -> normalize`) con fallback a plain en error/validación; `segments` opcional en `res.json`; se eliminaron las copias locales ya duplicadas en plain-core (`SUMMARY_ONLY_DIRECTIVE`, `TRAINING_DIRECTIVE`, `MEDIA_DIRECTIVE`, `extractMediaSelection`).

**Fase 5 — sequence_catalog (server, nuevo)**
- `functions/src/lib/response-contracts/sequence-catalog.handler.ts`: extiende plain + guarda de fidelidad numérica (`enforceVerbatimCodes` portado). Códigos verbatim; dígito-por-dígito se queda en cliente.
- `registry.ts`: registrado.

**Fase 6 — cited_scripture (server, nuevo)**
- `functions/src/lib/response-contracts/cited-scripture.handler.ts`: extiende plain + exige respaldo RAG; si no hay chunks/sources, declina amablemente (texto configurable vía `groundingRules`).
- `registry.ts`: registrado.

**Fase 7 — cliente consume segments**
- `src/app/services/rag-avatar.service.ts`: `normalize` pasa `segments` cuando vienen; fallback idéntico cuando no.

**Fase 8 — UI Assistant Manager**
- `src/app/services/assistant-config.service.ts`: persiste/lee `responseContract` (save + mapDoc).
- `src/app/pages/assistant-manager/assistant-manager.component.ts`: sección "Contrato de respuesta" (selector de kind + editores + plantillas por kind + validación JSON), helper `defaultContractFor`.

**Fase 9 — backfill**
- `functions/src/backfill.ts`: espejo `ASSISTANT_SCHEMA_VERSION=5` + puebla `responseContract=DEFAULT_PLAIN_CONTRACT` en docs viejos.

## Verificación por lectura (los 3 casos)

1. **Asistente plain / sin contrato** -> `chatRag` usa `DEFAULT_PLAIN_CONTRACT`; el handler plain reproduce el path actual (mismas directivas, mismo parse `<<MEDIA>>`/`<<SUMMARY>>/<<DETAIL>>`, misma forma de `res.json`). Sin `segments`. **Comportamiento idéntico a hoy.**
2. **sequence_catalog (Grabovoi)** -> EXPLORE/PROTOCOL siguen en las funciones probadas (gate ahora incluye el kind); el fall-through genérico aplica la guarda de códigos verbatim. Dígito-por-dígito en cliente sobre los códigos verbatim.
3. **cited_scripture (Pastor)** -> cita literal sigue por `answerTextualQuote` (intent); el path interpretativo declina si no hay respaldo RAG (asumiendo `rag_only` + threshold alto por config).

## Lo que TÚ debes correr (en tu máquina)

1. Functions: `cd functions && npm install && npm run build` (compila TS; verifica que `noUnusedLocals`/strict pasen — aquí no se pudo compilar).
2. Cliente: `ng build` (o `ng serve`) para validar el componente y los tipos.
3. Deploy cuando compile: `firebase deploy --only functions` y hosting según tu flujo.
4. **Git:** `functions/src/lib/` está bajo la regla `lib/` de `functions/.gitignore` (no anclada). Los archivos nuevos NO se trackean por defecto. Para versionarlos: `git add -f functions/src/lib/response-contracts/` o cambia la regla a `/lib/` (ancla solo el build output `functions/lib/`).
5. Backfill opcional (tras deploy): invoca la callable `backfillAssistants` para poblar `responseContract=plain` en los docs viejos (o deja que se auto-migren en lectura cliente).

## Riesgos residuales y rollback

- **No compilado aquí.** El riesgo principal es un error de tipos que `tsc` detecte (especialmente `noUnusedLocals`/strict en functions). Revisa el primer `npm run build`.
- **`segments` aún no se renderiza en el TTS/chat.** Ningún handler emite `segments` hoy (todos devuelven sin ellos), así que el dato fluye pero el wiring de render en `conversation.service`/`tts-lipsync` quedó deferido a propósito (cambiarlo sin emisor ni test era riesgo puro). Cuando un handler emita segments, hay que consumir `spoken`/`display` ahí.
- **chatRag tenía WIP tuyo sin commitear** antes de esta sesión; las ediciones se hicieron sobre ese estado en disco.
- **Rollback por fase:** todo es aditivo salvo Fase 4 (chatRag). Para revertir solo la arquitectura sin perder otro WIP: (a) en `chatRag.ts` restaurar el bloque STAGE-1 a la versión inline (git diff del archivo), (b) borrar `functions/src/lib/response-contracts/`, (c) revertir el import. Fases 1-2-7-8 son inertes si el server no envía/usa contrato. La forma más simple: tu punto de retorno seguro.

## Decisiones aplicadas
1. Extraer lo existente (no construir en paralelo). 2. Dispatch híbrido: kind = familia, intención = sub-camino. 3. Dígito-por-dígito en cliente.
