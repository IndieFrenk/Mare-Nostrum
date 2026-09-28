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
2. Leggi il **Briefing**, poi apri **Console Ordini**: scrivi una direttiva ("Manda la Bergamini a pattugliare il Canale di Sicilia e chiedi alla Tunisia più controlli") → *Interpreta* → *Valida*, oppure usa il costruttore.
3. **Esegui turno**. Se un ingaggio supera la soglia CMO, apri **Coda CMO**: scarica il pacchetto, gioca su CMO e compila l'AAR (oppure *Risoluzione automatica*), poi **Prosegui**.

## Comandi dell'interfaccia
- **Clic su una pedina**: seleziona (pila: apre l'elenco). **Maiusc+clic**: selezione multipla.
- **Tasto destro su una zona di mare** con unità selezionate: ordine di pattugliamento (tratteggio oro sulla mappa).
- **Clic su un paese**: scheda con fiducia/tensione, stime e azioni diplomatiche rapide.
- In basso a destra: modalità mappa (politica, diplomazia, tensione, crisi) e globo/mappa piana. Menu a icone a sinistra per tutti i pannelli; **▶** in alto a destra esegue il turno.

## Con modelli reali (OmniRoute)
Gli agenti parlano con un solo endpoint OpenAI-compatible (OmniRoute); per ogni ruolo scegli un modello, un alias o una combo di OmniRoute.
```bash
cp wargame-server/.env.example wargame-server/.env   # imposta LLM_BASE_URL, LLM_MODEL e gli override per ruolo
npm run wargame:llm-check      # raggiungibilità, modelli per ruolo, JSON strutturato e latenza di ciascun modello
npm run wargame:smoke-llm      # 1 turno headless: chiamate, ok%, token e latenza per ruolo
npm run wargame:all
```
- Ruoli: `FACTION_MAJOR` (USA, FRA, TUR, RUS, CHN), `FACTION_MINOR` (gli altri 9), `GM_NARRATOR` (briefing, debriefing, notizie), `INTEL_ANALYST`, `ORDER_PARSER`, `REFLECTION`, `REPAIR`, `DIPLOMAT` (lettere; senza `LLM_MODEL_DIPLOMAT` usa il modello di `FACTION_MAJOR`). Variabili: `LLM_MODEL` (default), `LLM_MODEL_<RUOLO>`, `LLM_TEMPERATURE_<RUOLO>`, `LLM_MAX_TOKENS_<RUOLO>`, `LLM_TIMEOUT_MS`.
- I modelli vengono copiati nella campagna alla creazione; per cambiarli in corsa: `POST /api/wg/campaigns/:id/config {"llm": {"faction_major": {"model": "..."}}}`.
- Se il modello non supporta `response_format: json_schema`, il client passa da solo a `json_object`; JSON invalido → 2 tentativi di repair → ordini di dottrina.
- `WARGAME_ALLOW_OFFLINE=1`: turni anche con i modelli spenti (dottrina); senza, ▶ risponde 503 se i modelli non rispondono (vedi «Stato dei modelli»).
- Consigli: un modello da 30B+ con buon JSON per `FACTION_MAJOR` e `GM_NARRATOR`; 7–14B per gli altri ruoli. Con modelli locali tieni `maxConcurrentAgents` a 2 (ogni turno: 14 decisioni di fazione + 14 riflessioni + 3–4 chiamate di narrazione e intel).

## Stato dei modelli (pallino accanto a ▶)
Il server prova `LLM_BASE_URL/models` (timeout 3 s, risultato in cache 30 s) e la UI lo mostra nella barra in alto, aggiornato ogni 60 s e prima di ▶; clic sul pallino = ricontrolla subito.
- **Verde** «LLM»: i modelli rispondono e quelli configurati ci sono. **Giallo** «N mancanti»: il server risponde ma non elenca N modelli configurati (o la latenza supera 2 s): controlla i nomi nel tooltip (`ollama list`). **Rosso** «LLM spenti»: il server non risponde (PC con Ollama spento, indirizzo sbagliato, chiave rifiutata); ▶ è disattivato. «mock»: `WARGAME_MOCK=1`, nessuna rete.
- Tooltip: indirizzo, latenza, errore, modello per ruolo (quelli della campagna), modelli mancanti, ora del controllo.
- Se i modelli non rispondono, `advance` (▶), la creazione di una campagna, *Interpreta* e la bozza di lettera rispondono subito **503 `LLM_UNREACHABLE`** («I modelli non rispondono: accendi il PC con Ollama…») invece di giocare un turno tutto in dottrina.
- `WARGAME_ALLOW_OFFLINE=1`: si gioca lo stesso (le fazioni usano gli ordini di dottrina); il pallino resta rosso ma ▶ è attivo. Con `WARGAME_MOCK=1` il controllo è spento.
- API: `GET /api/wg/llm/status[?campaignId=…&fresh=1]` → `{ reachable, baseUrl, models: { ruolo: modello }, missing, listed, latencyMs, error, enforced, offlineAllowed }`.

## Console Ordini: da testo a ordini
*Interpreta* (`POST /campaigns/:id/orders/parse`) passa per tre fasi; le prime e l'ultima sono deterministiche.
1. **Nomi → id, prima dell'LLM** (`engine/names.ts`): unità proprie per nome, nome breve, sigla e classe («Bergamini» → ITA-F590, «Cavour» → ITA-CAVOUR, «F 590»), zone e paesi con gli alias italiani di `scenarios/<scenario>/names.json` («Mar Ionio»/«Ionio» → IONIO, «Tunisia» → TUN). Il modello riceve il testo con l'id tra parentesi quadre («la Bergamini [ITA-F590]») e una tabella nome → id. Gli alias di più voci non si sostituiscono («Libia» → ambiguità GNU/LNA).
2. **LLM** (ruolo `ORDER_PARSER`): stesso elenco di campi degli ordini delle fazioni (`prompts/order-fields.md`), solo id delle AZIONI LECITE, cyber solo se il testo parla di cyber/hacking. Se il testo chiede forze in una zona senza nominare le unità («più presenza nel Canale di Sicilia») risponde con `zoneStances` e il motore sceglie le unità come per le fazioni IA.
3. **Controlli del motore** (`engine/parse-review.ts`), come avvisi (non bloccano la bozza): verbo di movimento («pattuglia», «porta», «manda», «schiera», «dimostrazione di forza») senza un ordine con unità, zona o unità nominate e non usate; **⚠ azione ostile verso un alleato** (CYBER_OP disruption, THREAT, SANCTION, BLOCKADE, STRIKE verso NATO/UE o fiducia ≥ 40); **⚠ CYBER_OP non richiesta**; verbo diplomatico senza l'azione corrispondente. Un `target` che non è una fazione (es. una zona) resta un errore del validatore.
Sotto il pulsante compaiono i nomi riconosciuti; le ambiguità in basso, gli avvisi nella validazione.

## Come le fazioni IA usano le forze: posture per zona
Un modello piccolo (es. `qwen3.5:4b`) non riesce a scrivere ordini con gli id di unità giusti; per questo la decisione di fazione ha il campo `zoneStances`: l'IA dice **dove** e **come**, il motore sceglie **quali** unità (`engine/stances.ts`, deterministico).
- `zoneStances: [{ zoneId, stance, intensity }]`, al massimo 4 per turno. `stance` → ordine: `patrol` → PATROL (WEAPONS_TIGHT), `presence` → PRESENCE (WEAPONS_HOLD), `show_of_force` → SHOW_OF_FORCE, `escort_shipping` → ESCORT «convoglio ZONA», `blockade` → BLOCKADE, `air_defense` → AIR_DEFENSE (alert high), `withdraw` → RETURN_TO_BASE delle unità schierate in quella zona. `intensity` 1/2/3 → al massimo 1/3/5 unità.
- Il motore sceglie unità pronte o già schierate lì, non impegnate altrove, con prontezza ≥ 50 e del dominio giusto (navi in mare, `sam_battery` per prima nella difesa aerea, niente navi nelle zone terrestri): prima quelle già nella zona, poi le più vicine, poi per id; nel budget (costano solo le unità che partono dalla base). Le unità logorate (prontezza < 35) rientrano e quelle danneggiate vanno in riparazione comunque.
- Gli ordini tradotti si aggiungono agli ordini militari **prima** della validazione: stesso validatore e stesso scarto degli ordini impossibili del giocatore. `orders.military` resta per chi vuole un ordine preciso a un'unità (il giocatore, modelli grandi).
- Registro: `decisions/…/{F}.json` contiene `zoneStances` e `stanceOrders` (quale ordine viene da quale postura; `worn` = rientro dei logorati); le posture non tradotte sono in `validation.errors` («postura — …»). Il replay rilegge gli ordini già tradotti.
- **Tra un turno e l'altro** un'unità con un compito (PATROL, PRESENCE, SHOW_OF_FORCE, ESCORT, BLOCKADE, AIR_DEFENSE, MOVE) **continua quel compito** finché un ordine non la richiama: resta `deployed` nella zona con `currentTask`, paga la quota operativa (`chargeOperations`), perde 4 punti di prontezza a turno (`applyAttrition`) e, sotto 35, il traduttore la fa rientrare comunque (`worn`); le avarie per usura la mandano in riparazione. Se un'unità non arriva in un turno resta `transit` e **prosegue da sola** verso la zona del compito all'apertura del turno dopo (`continueTransit` in `engine/movement.ts`). Per le posture: un'unità fuori base impegnata in un'altra zona (anche se ancora in viaggio) non viene distolta (`busyElsewhere`); una postura nella zona del suo compito la **conferma** (è la prima scelta, costo zero) e `withdraw` richiama anche chi ci sta ancora andando. Per questo gli ordini alle unità calano nei primi turni: molte unità restano impegnate nel compito del turno prima e le nuove posture in altre zone trovano meno unità libere (nel playtest: «unità IA impegnate» e «posture emesse / tradotte / senza unità»).
- Nel prompt le AZIONI LECITE includono `unitsPerSeaZone` (quante unità la fazione può impiegare in ogni zona di mare). Parametri in `PARAMS.stances`.

## Crisi: escalation e distensione
Le crisi (0–10) salgono per deriva casuale (2d6), eventi casuali della zona e ordini (blocchi, strike, ingaggi) e scendono con la calma, gli accordi e la diplomazia (`engine/crises.ts`, parametri in `engine/params.ts`).
- **Tetto dagli ordini**: al massimo +1 per crisi per turno dovuto agli ordini (`crisisOrderCapPerTurn`), qualunque sia il numero di blocchi, strike e ingaggi; le singole azioni continuano a spostare fiducia e tensione.
- **Saturazione degli eventi casuali**: un incidente alza la crisi con probabilità 1 − escalation/12 (`randomEventSaturation`); l'evento resta nelle notizie e negli indicatori.
- **Distensione**: ogni REASSURANCE, BACKCHANNEL, lettera cordiale o conciliante e accordo accettato tra due fazioni coinvolte in una crisi aggiunge +15% (fino a 3 azioni, `detenteCoolBonus`) alla probabilità che la crisi scenda di 1 nel turno dopo, anche se nel turno precedente era salita.
- **Pressione migratoria**: tende a 15 + 6 × escalation di SAHEL_MIG, −10 per ogni accordo migratorio attivo (`PARAMS.migration`); le ondate casuali la spingono su per un turno e poi rientra.

## Lettere tra capi di Stato
Pannello **✉ Lettere**: corrispondenza per interlocutore (con le non lette), lettere impaginate come lettere vere (carica del mittente, «Roma, 9 marzo 2026», oggetto, testo, firma con la carica, riservata/pubblica) e **Rispondi**.
- **Scrivere**: destinatario, tono (cordiale, formale, conciliante, ferma, minacciosa), oggetto (≤ 120 caratteri), testo (≤ 1.800), riservata o pubblica. *Fai scrivere una bozza* chiede al consigliere (ruolo `DIPLOMAT`) un testo da rivedere. La lettera entra negli ordini del turno (al massimo 2 per turno) e parte con ▶.
- **Effetti** (li decide il motore, non l'LLM): il tono sposta fiducia e tensione (conciliante e cordiale le distendono, ferma e minacciosa le alzano); una lettera minacciosa è una minaccia e, se non ha seguito entro due turni, costa credibilità; una lettera pubblica è anche una dichiarazione e finisce nelle notizie.
- **Risposte**: ogni fazione IA risponde nel turno successivo alle lettere del giocatore (una per fazione per turno, anche le minori nei turni «senza IA»), coerente con profilo, memoria e decisione del turno. Le fazioni scrivono anche di propria iniziativa: al massimo `WARGAME_LETTERS_PER_TURN` lettere per turno (predefinito 3; si cambia anche in corsa con `POST /config {"agentCadence": {"lettersPerTurn": 1}}`).
- **Iniziative innescate dal motore**: i modelli piccoli compilano di rado `letterIntents`, quindi il motore (`engine/letter-triggers.ts`, senza LLM) fa scrivere una fazione IA quando nel turno precedente ha ricevuto una minaccia (THREAT), un blocco navale o sanzioni, o ha avuto uno scontro con un'altra fazione (tono `firm`); quando la sua tensione verso un'altra è salita di almeno 10 punti in un turno (`formal`, `PARAMS.letterTriggers.tensionJump`); quando ha appena accettato un accordo (alla controparte, `cordial`). Il `gist` viene dai fatti dell'evento. Gli inneschi si aggiungono a `letterIntents` (prima gli intenti, poi gli inneschi; una lettera per destinatario, 1 per le minori e 2 per le maggiori) e restano nel tetto `lettersPerTurn`, prima le maggiori e poi per id. Nel registro `decisions/…/{F}.json` → `letters[].trigger` dice quale innesco l'ha fatta scrivere.
- **Niente numeri inventati**: il testo può citare solo numeri presenti nella situazione del mittente; altrimenti 1 repair e poi una lettera-modello breve e cortese. I capi di Stato sono indicati solo con la carica (`leaderTitle` e `capital` in `world.json`), mai con nomi di persona.
- **Registro e replay**: le lettere sono in `letters/turn-N.jsonl`; quelle delle fazioni IA sono azioni `LETTER` nei loro ordini e decisioni, e il replay le rilegge senza LLM.
- API: `GET /api/wg/campaigns/:id/letters?turn=` (lettere visibili al giocatore) · `POST /api/wg/campaigns/:id/letters/draft {target, gist, tone, inReplyTo?}` (bozza; non cambia lo stato).

## Comandi
| Comando | Cosa fa |
|---|---|
| `npm run wargame:server` | API su `:8787` (`WARGAME_MOCK=1` per il mock, `WARGAME_DATA_DIR` per il DB) |
| `npm run dev:wargame` | frontend su `/wargame.html` |
| `npm run build:wargame` | build statica in `dist-wargame/` |
| `npm --prefix wargame-server run geo:build` | rigenera zone marittime e confini da `geo-src.json` |
| `npm run wargame:sim -- --turns 5 --mock` | simulazione headless |
| `npm run wargame:sim -- --replay <id>` | replay da `decisions/` e verifica di determinismo |
| `npm --prefix wargame-server test` | test del motore, agenti, API |
| `npm run test:e2e:wargame` | e2e Playwright di un turno (mock) |
| `npm --prefix wargame-server run schemas:export` | JSON Schema in `wargame-server/schemas-json/` |
| `npm --prefix wargame-server run playtest -- --turns 6` | partita automatica via API (con lettere ogni 2 turni) e report dei problemi, degli ordini IA alle unità (quanti dalle posture) e degli ingaggi |
| `npm --prefix wargame-server run balance -- --seeds 10 --turns 20` | statistica di bilanciamento delle crisi su N seed (IA mock, giocatore moderato del playtest): escalation finale per crisi, turno medio del primo 10/10, pressione migratoria media |
| `npm --prefix wargame-server run bench:models -- <cartella-campagna> <modello>… [--solo parser,fazioni,…] [--mock]` | banco dei modelli: fazioni (con ordini militari per tipo e quanti dalle posture), narratore, riflessione, lettera e **parser** (14 direttive del giocatore: corretti / sbagliati / pericolosi) |

Il database è in `wargame-server/data/campaigns/{id}/` (JSON/JSONL leggibili, vedi SPEC §5).

## Nuovo profilo fazione
Aggiungi `scenarios/<scenario>/factions/<ID>.md` con: interessi (riga `Interessi:` → obiettivi iniziali della memoria), dottrina, linee rosse, stile, propensione al rischio. Poi aggiungi la fazione in `world.json` (`factions`, `controller: "ai"`, `agentRole`), le sue unità e le relazioni in `relations.pairs`.

## Nuovo scenario
Copia `scenarios/med-2026/` e modifica: `scenario.json` (data, turno, indicatori), `geo-src.json` (linee di separazione dei mari, poi `geo:build`), `world.json` (zone con `terrain`, obiettivi e linee rosse delle fazioni, basi, infrastrutture, unità compatte `{id, factionId, name, classId, count, homeBaseId}`, relazioni, crisi, accordi), `catalog.json` (classi e acquisti), `event-tables.json`, `geo/*.geojson`. Le linee rosse usano la mini-DSL di `engine/conditions.ts`.
