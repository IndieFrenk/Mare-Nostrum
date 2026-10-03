# RECON — WorldMonitor come base per Mare Nostrum

Base: `koala73/worldmonitor@67a1f75` importato come commit squash (AGPL-3.0, `LICENSE` invariato). Node 24 (`.nvmrc`), Vite, TS strict, Zod 4, Vitest 4, Playwright.

## Moduli rilevanti

| Area | File | Note |
|---|---|---|
| Entry SPA | `index.html`, `src/main.ts`, `src/App.ts` | `main.ts` avvia subito Sentry, analytics, web-vitals, WebMCP, service worker: import con side-effect di rete. |
| Varianti | `src/config/variant.ts` (`SITE_VARIANTS`), `src/config/variants/*.ts`, `VITE_VARIANT` in `vite.config.ts` | `SITE_VARIANTS` è legato a `/api/download` e a `tests/desktop-one-binary-model.test.mjs`. |
| Mappa | `src/components/DeckGLMap.ts`, `GlobeMap.ts`, `MapContainer.ts`, `src/config/basemap.ts` | Accoppiati a servizi dati, layer registry e premium gating. |
| Layer | `src/config/map-layer-definitions.ts` | Registry con varianti e i18n. |
| Pannelli | `src/components/Panel.ts`, `src/config/panels.ts` | `Panel` importa analytics, runtime-config, checkout, freshness. |
| Build | `vite.config.ts` (input multipli: index/embed/settings/live-channels/mcp-grant) | Già supporta più entry HTML. |
| Test | `vitest.config.mts`, `tests/*.test.mjs`, `e2e/*.spec.ts`, `playwright.config.ts` | |

## Punti di aggancio scelti

1. **Entry dedicata** `wargame.html` → `src/wargame/main.ts`, script `npm run dev:wargame` (`VITE_VARIANT=wargame`). Non passa per `src/main.ts`, quindi nessun servizio upstream viene importato: zero rete esterna per costruzione.
2. **Riuso**: `maplibre-gl` (con il worker configurato come in `DeckGLMap.ts`), i confini in `public/data/countries.geojson`, convenzioni CSS dei pannelli (`.panel`, `.panel-header`, `.panel-content`).
3. **Backend** in `wargame-server/` come package npm separato (proprie dipendenze), tipi condivisi importati dal frontend come `import type`.

## Servizi da disattivare

Tutti quelli caricati da `src/main.ts`/`App.ts` (news RSS, mercati, voli, AIS relay, CII, bootstrap cache, Sentry, Vercel analytics, Umami, WebMCP, PWA). Con l'entry dedicata non vengono mai caricati: nessuna modifica al codice condiviso.

## Rischi

- `Panel`/`DeckGLMap` troppo accoppiati per un riuso diretto senza trascinare servizi di rete → si riusa lo stack e il look, non le classi.
- Aggiungere `wargame` a `SITE_VARIANTS` romperebbe il test desktop one-binary → la variante resta solo build-time.
- `npm ci` completo pesante (postinstall genera facts): usare `--ignore-scripts` per il gioco.

## Deviazioni dalla spec

- Variante via entry HTML separata anziché `SITE_VARIANTS` (motivo sopra).
- `zod-to-json-schema` non serve: Zod 4 ha `z.toJSONSchema`.
- Mappa MapLibre con proiezione globo e confini da `public/data/countries.geojson`: nessuna tile esterna.
- `world.json` usa unità compatte idratate dal catalogo classi (evita duplicare firme/sensori).

## Piano fasi 1–7

1. `wargame-server`: schemi Zod, export JSON Schema, `JsonStore`, RNG.
2. Scenario `med-2026`, motore event-sourced (`reducer.ts`: ogni mutazione è un `GameEvent`), CLI `wargame:sim`.
3. Agenti con `LlmProvider` (OpenAI-compatible/Mock), repair+fallback, replay da `decisions/`.
4. API Fastify + SSE + GeoJSON.
5. `wargame.html` + pannelli + layer.
6. CMO/AAR, fork, post-mortem (API+UI).
7. Playwright e2e, README, `wargame:all`.
