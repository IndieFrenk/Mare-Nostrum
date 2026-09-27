# PROGRESS

## Fatto
- **Fase 0** — Import di WorldMonitor, `RECON.md`, `SPEC.md`, `CLAUDE.md`.
- **Fasi 1–4** — `wargame-server/`: schemi Zod + `schemas-json/`, `JsonStore` (scritture atomiche, lock, snapshot, fork), RNG mulberry32 con cursore e log dei tiri, scenario `med-2026`, motore event-sourced, agenti (OmniRoute/mock/replay), API Fastify + SSE + GeoJSON, CLI `sim`. 23 test Vitest verdi.
- **Fase 5** — `wargame.html` + `src/wargame/` (mappa maplibre+deck.gl, simboli `milsymbol`, 11 pannelli, SSE). Typecheck root pulito; biome e safe-html ok.
- **Fase 6** — Coda CMO (pacchetto .txt/.json, form AAR, risoluzione automatica), fork dai turni chiusi, post-mortem con decisioni, tiri e rami.
- **Fase 7** — `e2e-wargame/turn.spec.ts` (un turno con mock, verifica che non ci siano richieste esterne), `docs/wargame/README.md`, `npm run wargame:all`.
- **Interfaccia grand strategy** (richiesta successiva): mappa a tutto schermo con globo 3D (MapLibre `globe`, commutabile in mappa piana), paesi colorati per fazione da `public/data/countries.geojson` (nessuna tile esterna), modalità mappa politica/diplomazia/tensione/crisi, barra risorse, menu a icone con pannelli sovrapposti, avvisi, scheda paese con azioni diplomatiche rapide, pedine NATO impilate per vicinanza, selezione multipla e ordine di pattugliamento col tasto destro (linea tratteggiata sul piano).

## Decisioni
- Ogni mutazione dello stato è un `GameEvent` applicato da `engine/reducer.ts`: `state(N) = snapshot(N-1) + events(N)` (test dedicato).
- Aggiunti campi/tipi (ammessi dalla spec): `WorldState.rngCursor`, `Faction.crossedRedLines`, `Base.zoneId`, `Infrastructure.zoneId`, `Zone.center`, `Contact.zoneId`, `CatalogItem.platformClassId`, eventi `UNIT_CREATED`, `FACTION_CHANGED`, `INDICATORS_CHANGED`, `TURN_ADVANCED`, `TURN_CLOSED`, `STATEMENT`.
- Verità dei contatti salvata a parte in `truth/turn-N.json` (solo motore; serve a STRIKE/CMO dopo una pausa).
- `memory/history/{F}-turn-N.json` versiona la memoria per fork e replay.
- Munizioni "lead time 0–1": consegna al turno successivo se il tiro di disponibilità industriale riesce, altrimenti +1 turno; penalità per ordini ripetuti.
- `Unit.currentTask` tipizzato come record generico (evita un ciclo tra schemi).
- Ordini del giocatore mancanti ad `advance` → ordini vuoti (source `human`).
- Zone con `terrain` (sea/land): le unità navali non possono essere mandate in zone terrestri.
- Eventi casuali: al massimo una variazione per crisi per turno.
- Mappa solo MapLibre (niente deck.gl nella variante): i layer funzionano identici su globo e mappa piana.
- Frontend: nessuna modifica a `src/main.ts`/`vite.config.ts`; la variante è solo in dev (`npm run dev:wargame`).
- Rotta extra `POST /campaigns/:id/end` e `GET /campaigns/:id/overview` (indicatori, relazioni ITA, consegne).

## Debiti tecnici
- Minacce non mantenute: registrate (`pendingThreat`) ma la penalità di credibilità non è ancora applicata.
- Obiettivi (`Objective.metric`) non valutati; solo le linee rosse usano la DSL.
- Nessuna migrazione dello schema (`store/migrations/`): `schemaVersion` = 1 ovunque.
- Nessun `build:wargame` di produzione (serve aggiungere `wargame.html` agli input di `vite.config.ts`).
- Bilanciamento: con il mock le crisi tendono a salire; da tarare con partite reali.
- Poligoni delle zone marittime approssimati (rettangoli): le crisi sconfinano sulla terraferma.
- La Libia è divisa con un poligono approssimato per l'area LNA.
- Modello di combattimento volutamente semplice (salve 2d6); parametri in `engine/params.ts`.
