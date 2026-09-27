# Mare Nostrum — guida rapida

Wargame geopolitico a turni (Mediterraneo allargato, 2026). Tu comandi l'Italia; ogni altro Stato è un agente LLM. Interfaccia derivata da World Monitor (AGPL-3.0).

## Installazione (≈5 minuti)
```bash
nvm use                       # Node 24 (.nvmrc)
npm ci --ignore-scripts       # dipendenze frontend
npm --prefix wargame-server install
```

## Primo turno con LLM finto (senza rete)
```bash
WARGAME_MOCK=1 npm run wargame:all    # server :8787 + frontend su http://localhost:5173/wargame.html
```
1. **Crea** una campagna.
2. Leggi il **Briefing**, poi apri **Console Ordini**: scrivi una direttiva ("Pattugliare CANALE_SICILIA con ITA-F592") → *Interpreta* → *Valida*, oppure usa il costruttore.
3. **Esegui turno**. Se un ingaggio supera la soglia CMO, apri **Coda CMO**: scarica il pacchetto, gioca su CMO e compila l'AAR (oppure *Risoluzione automatica*), poi **Prosegui**.

## Con modelli reali (OmniRoute)
```bash
export LLM_BASE_URL=http://localhost:20128/v1   # default
export LLM_API_KEY=...                           # opzionale
export LLM_MODEL=qwen2.5:14b                     # default per tutti i ruoli
export LLM_MODEL_FACTION_MAJOR=qwen2.5:32b       # override per ruolo (FACTION_MINOR, GM_NARRATOR, INTEL_ANALYST, ORDER_PARSER, REFLECTION, REPAIR)
npm run wargame:all
npm --prefix wargame-server run smoke-llm        # 1 turno headless: token e latenze
```
Modelli consigliati: un modello da 30B+ con buon JSON per `faction_major`; 7–14B per `faction_minor`, `order_parser`, `reflection`, `repair`; il narratore rende meglio con un modello più capace ma è protetto dal validatore numeri. Con modelli locali tieni `maxConcurrentAgents` a 2.

## Comandi
| Comando | Cosa fa |
|---|---|
| `npm run wargame:server` | API su `:8787` (`WARGAME_MOCK=1` per il mock, `WARGAME_DATA_DIR` per il DB) |
| `npm run dev:wargame` | frontend su `/wargame.html` |
| `npm run wargame:sim -- --turns 5 --mock` | simulazione headless |
| `npm run wargame:sim -- --replay <id>` | replay da `decisions/` e verifica di determinismo |
| `npm --prefix wargame-server test` | test del motore, agenti, API |
| `npm run test:e2e:wargame` | e2e Playwright di un turno (mock) |
| `npm --prefix wargame-server run schemas:export` | JSON Schema in `wargame-server/schemas-json/` |

Il database è in `wargame-server/data/campaigns/{id}/` (JSON/JSONL leggibili, vedi SPEC §5).

## Nuovo profilo fazione
Aggiungi `scenarios/<scenario>/factions/<ID>.md` con: interessi (riga `Interessi:` → obiettivi iniziali della memoria), dottrina, linee rosse, stile, propensione al rischio. Poi aggiungi la fazione in `world.json` (`factions`, `controller: "ai"`, `agentRole`), le sue unità e le relazioni in `relations.pairs`.

## Nuovo scenario
Copia `scenarios/med-2026/` e modifica: `scenario.json` (data, turno, indicatori), `world.json` (zone con `terrain`, basi, infrastrutture, unità compatte `{id, factionId, name, classId, count, homeBaseId}`, relazioni, crisi, accordi), `catalog.json` (classi e acquisti), `event-tables.json`, `geo/*.geojson`. Le linee rosse usano la mini-DSL di `engine/conditions.ts`.
