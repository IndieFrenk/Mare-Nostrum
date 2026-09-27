# PROGRESS

## Fatto
- **Fase 0** — Import di WorldMonitor, `RECON.md`, `SPEC.md`, `CLAUDE.md`.
- **Fasi 1–4** — `wargame-server/`: schemi Zod + `schemas-json/`, `JsonStore` (scritture atomiche, lock, snapshot, fork), RNG mulberry32 con cursore e log dei tiri, scenario `med-2026`, motore event-sourced, agenti (OmniRoute/mock/replay), API Fastify + SSE + GeoJSON, CLI `sim`. 22 test Vitest verdi.

## Decisioni
- Ogni mutazione dello stato è un `GameEvent` applicato da `engine/reducer.ts`: `state(N) = snapshot(N-1) + events(N)` (test dedicato).
- Aggiunti campi/tipi (ammessi dalla spec): `WorldState.rngCursor`, `Faction.crossedRedLines`, `Base.zoneId`, `Infrastructure.zoneId`, `Zone.center`, `Contact.zoneId`, `CatalogItem.platformClassId`, eventi `UNIT_CREATED`, `FACTION_CHANGED`, `INDICATORS_CHANGED`, `TURN_ADVANCED`, `TURN_CLOSED`, `STATEMENT`.
- Verità dei contatti salvata a parte in `truth/turn-N.json` (solo motore; serve a STRIKE/CMO dopo una pausa).
- `memory/history/{F}-turn-N.json` versiona la memoria per fork e replay.
- Munizioni "lead time 0–1": consegna al turno successivo se il tiro di disponibilità industriale riesce, altrimenti +1 turno; penalità per ordini ripetuti.
- `Unit.currentTask` tipizzato come record generico (evita un ciclo tra schemi).
- Ordini del giocatore mancanti ad `advance` → ordini vuoti (source `human`).
- Rotta extra `POST /campaigns/:id/end` e `GET /campaigns/:id/overview` (indicatori, relazioni ITA, consegne).

## Debiti tecnici
- Minacce non mantenute: registrate (`pendingThreat`) ma la penalità di credibilità non è ancora applicata.
- Obiettivi (`Objective.metric`) non valutati; solo le linee rosse usano la DSL.
- Nessuna migrazione dello schema (`store/migrations/`): `schemaVersion` = 1 ovunque.
- Modello di combattimento volutamente semplice (salve 2d6); parametri in `engine/params.ts`.
