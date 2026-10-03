# DIPLOMAZIA — Rapporti tra Stati in Mare Nostrum

*Documento di progetto, 2 ottobre 2026. I prompt 08–12 lo citano per sezione.*

## 0. Obiettivo e vincoli

- **Tutti gli Stati del mondo**: 193 membri ONU + Santa Sede e Palestina (osservatori) + Taiwan e Kosovo = **197 Stati**. Restano gli attori non statali già presenti (LNA).
- **Realismo**: relazioni **asimmetriche** (come in Hearts of Iron IV), che cambiano solo per una causa registrata, e ogni numero ha un elenco di motivi leggibile.
- **Risorse limitate**: le decisioni le prende il motore. L'LLM è facoltativo e a budget: modelli locali (qwen3.5 4B/9B), Gemini Flash gratuito, OmniRoute. **Il gioco deve funzionare con zero chiamate LLM.**
- **Regole d'oro invariate**: motore unica fonte di verità, nebbia di guerra, tutto registrato, replay senza LLM, stesso schema di ordini per umano e IA.
- Capi di Stato **solo con la carica**, mai con il nome di una persona reale.

## 1. Cosa c'è oggi (analisi del codice)

| Aspetto | Oggi | Limite per un sistema mondiale |
|---|---|---|
| Relazioni | `relations[a][b] = { trust, tension, tradeDependency, notes }` per ogni coppia di fazioni | **Simmetriche**: il reducer applica lo stesso delta ad A→B e B→A. Nessun decadimento: una minaccia pesa per sempre. `notes` tiene solo le ultime 5 righe |
| Scala | 28 fazioni, matrice completa (756 coppie), Knowledge salvata per ogni fazione a ogni turno | Con 197 Stati: ~39.000 coppie per snapshot e 197 file di Knowledge a turno. Una campagna di 5 turni pesa già 7,5 MB con 13 fazioni |
| Azioni diplomatiche | DEMARCHE, THREAT, REASSURANCE, BACKCHANNEL, accordi, sanzioni, aiuti, ART4/UE/CdS, lettere | Nessun costo né tempo di ricarica: si possono fare all'infinito. Non c'è una risorsa diplomatica |
| Accettazione degli accordi | `trust ≥ acceptTrust` (10), tregue e migrazione anche sotto | Un solo numero: niente motivi, niente interessi, niente paura di un terzo |
| Votazioni | CdS con i soli 5 permanenti, sì se trust ≥ 20, veto se < −20; NATO e UE a maggioranza semplice | Mancano i 10 membri eletti, l'Assemblea generale, le regole vere (unanimità UE per le sanzioni, consenso NATO) |
| Propagazione | 30% agli alleati con accordi di difesa a ≤3 parti | Nessuna reazione dei paesi terzi |
| Decisori | `engine/policy.ts` a regole per tutte le fazioni IA; profilo `policy` per fazione | Buona base: va solo collegato all'opinione e alle nuove azioni |
| Mappa | `countries.geojson` con 241 territori e ISO3 | Solo le fazioni sono colorate e cliccabili; l'UE ha un colore comune |

## 2. Cosa prendiamo da Hearts of Iron IV (e cosa no)

| HOI4 | Mare Nostrum |
|---|---|
| Opinione asimmetrica con modificatori a tempo che decadono | `opinion(A→B)` = base + somma dei modificatori, da −100 a +100 (§5) |
| Tooltip con i motivi di ogni numero | `reasons[]` in ogni opinione e in ogni accettazione |
| Potere politico | **Capitale diplomatico (CD)**, una rendita per turno (§7) |
| «Migliora relazioni» con un numero limitato di diplomatici | Azione continuativa con 2–4 slot (§7) |
| Tensione mondiale | **Tensione mondiale** 0–100: rende più facili o più costose le azioni gravi (§6) |
| Garanzia, patto di non aggressione, accesso militare, lend-lease, fazioni | Nuovi tipi di trattato e istituzioni con regole di voto (§7, §9) |
| Giustificare un casus belli (tempo, visibile, alza la tensione) | **Ultimatum** con scadenza: dà legittimità alla forza, alza la tensione mondiale (§7) |
| Accettazione dell'IA con motivi elencati | Funzione deterministica `acceptance()` (§8) |
| Deriva ideologica, sfere d'influenza | **Allineamento** su tre poli (Occidente, Cina, Russia) più non allineati (§4) |

Non prendiamo: produzione, fronte terrestre, ideologie anni '30, annessioni, Stati fantoccio, dichiarazioni di guerra formali (resta la scala di escalation delle crisi).

## 3. Due livelli di attori, tre livelli di IA

- **Attori** = le fazioni di oggi (28, possono crescere): unità, basi, crisi, `FactionKnowledge`, profilo `policy`.
- **Stati del mondo** = tutti gli altri Stati del registro: niente unità, niente Knowledge su file. Hanno dati, opinioni, trattati, voti, reazioni, sanzioni e possono ricevere lettere. Uno Stato si può «promuovere» ad attore nello scenario.
- **Identificatori**: le fazioni tengono il loro id; gli Stati senza fazione usano l'ISO3. Il registro collega `iso3 ↔ factionId` (DZA ↔ ALG; LBY ↔ LBY_GNU, governo riconosciuto dall'ONU; LBY_LNA resta attore non statale senza ISO3).
- **Livelli di IA**:
  - **A — grandi potenze** (USA, CHN, RUS; facoltativi FRA, GBR, TUR): regole di `policy.ts` + direttiva strategica LLM ogni 3–6 turni, facoltativa (§11).
  - **B — attori regionali** (le altre fazioni): regole di `policy.ts`, che leggono l'opinione al posto di `trust`.
  - **C — Stati del mondo**: «IA mondiale» a regole, guidata dagli eventi, sfalsata nei turni (§10).

## 4. Dati del mondo (`wargame-server/scenarios/_world/`, comuni a tutti gli scenari)

**`nations.json`** — uno per Stato:

| Campo | Contenuto |
|---|---|
| `iso3`, `iso2`, `nameIt`, `capital`, `leaderTitle` | es. «Il Presidente della Repubblica del Kenya» (solo carica) |
| `region`, `subregion` | classificazione ONU M49 |
| `government` | `democracy` · `hybrid` · `authoritarian` · `absolute_monarchy` · `theocracy` · `military` · `transitional` |
| `democracyScore` | 0–10 |
| `population` (milioni), `gdpUsdB`, `milexUsdB`, `activePersonnelK` | ultimo anno disponibile (2024–2025) |
| `nuclear` | `none` · `latent` · `declared` · `nato_sharing` |
| `alignment` | `{ west, china, russia }` 0–1 con somma ≤ 1; il resto è non allineamento |
| `unIdealPoint` | punto ideale nelle votazioni dell'Assemblea generale (se disponibile) |
| `energy` | `{ role: exporter|importer|mixed, oil, gas }` |
| `topTrade` | fino a 5 `{ iso3, share }`, quota sul commercio totale |
| `memberships` | id delle istituzioni |
| `sources`, `confidence` | fonte per campo e affidabilità 0–1 dei valori stimati |

**`institutions.json`** — NATO, UE, ONU (AG e CdS con i 15 membri del 2026), Unione Africana, Lega Araba, CCG, ASEAN, SCO, BRICS, CSTO, OPEC+, OSA, Commonwealth, G7, G20, Consiglio d'Europa, OSCE, ecc. Per ognuna:
- `kind` (`alliance` · `union` · `regional` · `economic` · `security` · `un`);
- `members`, eventuali `leaders`;
- `decision` (`consensus` · `unanimity` · `majority` · `qmv` · `unsc`);
- `cohesion` 0–1 (quanto i membri votano insieme);
- `effects` (difesa collettiva, regime di sanzioni comune, mercato unico).

CdS 2026: i 5 permanenti + Danimarca, Grecia, Pakistan, Panama, Somalia (2025–26) e Bahrein, Colombia, RD Congo, Lettonia, Liberia (2026–27).

**`pairs.json`** — solo le coppie con una storia nota, con etichetta: rivalità e dispute (es. India–Pakistan, Grecia–Turchia «Egeo e Cipro», Marocco–Algeria «Sahara occidentale», Israele–Iran, Coree, Armenia–Azerbaigian, Russia–Ucraina, Cina–Taiwan, Arabia Saudita–Iran) e amicizie storiche. Formato `[a, b, valore, etichetta]`; il valore entra nella base dell'opinione.

**Fonti**: Banca Mondiale (CC BY 4.0), SIPRI (spese militari, con citazione), Wikidata (CC0) per capitali e appartenenze, dati delle votazioni ONU (Voeten / Bailey–Strezhnev–Voeten, licenza da verificare). Uno script `npm --prefix wargame-server run world:build` rigenera i file; nel repo c'è l'istantanea già generata e **a runtime non serve la rete**. I valori stimati a mano hanno `confidence` < 0,7 e sono elencati nella PR.

## 5. Opinione

`opinion(A→B)` = quanto A apprezza B, da −100 a +100 = `clamp(base(A,B) + Σ modificatori(A→B))`.

### 5.1 Base (statica)
Funzione pura dei dati del §4, calcolata all'avvio e tenuta in cache: **non va nello snapshot**. Ogni componente è un motivo (`reasons[]`). Pesi in `PARAMS.opinion`:

| Componente | Intervallo indicativo |
|---|---|
| Alleanza difensiva in comune | +25 |
| Stessa unione (UE) / stessa organizzazione regionale | +15 / +5 |
| Blocchi contrapposti (es. NATO e CSTO) | −10 |
| Distanza di allineamento (o di punto ideale ONU) | −25 … +25 |
| Somiglianza di regime | −10 … +10 |
| Dipendenza commerciale di A da B | 0 … +15 |
| Coppia storica (`pairs.json`) | il valore della coppia |

### 5.2 Modificatori (dinamici)
```ts
interface OpinionModifier {
  id: string; from: ActorId; to: ActorId;   // modifica opinion(from→to)
  kind: string; label: string;               // «Minaccia formale», «Sanzioni in vigore»…
  value: number; decayPerWeek: number;       // verso 0; 0 = finché dura la causa
  floor?: number;                            // valore sotto cui non scende finché la causa è attiva
  expiresTurn?: Turn; causeRef: string;      // evento, ordine o accordo
  visibility: Visibility;
}
```
**Asimmetria**: un'azione di A verso B crea un modificatore su `opinion(B→A)`, cioè su come B vede A. Gli alleati stretti di B ne ricevono una quota (30%, come oggi). Le reazioni dei terzi (§10) creano i propri modificatori.

Valori iniziali (da tarare con `balance`):

| Causa | Valore | Decadimento/settimana |
|---|---|---|
| Minaccia formale | −10 | 1 |
| Démarche | −3 | 0,5 |
| Rassicurazione / canale riservato | +3 / +2 | 0,5 |
| Lettera | dal tono (oggi `LETTER_TONE_EFFECTS`) | 0,5 |
| Sanzioni in vigore | −20 | 0 finché attive, poi −10 che decade di 0,5 |
| Aiuto economico/militare | min(15, importo/10) | 0,5 |
| Trattato attivo | +10 | 0 finché attivo |
| Trattato violato | −30 | 0,5 |
| Strike o scontro subiti | −40 | 0,5 |
| Voto contrario in un'istituzione | −3 | 1 |
| Condanna / sostegno pubblico | −5 / +5 | 1 |
| Migliorare le relazioni (in corso) | +2 per turno, fino a +30 | 0 finché attiva, poi 0,5 |

Il decadimento si scala sulla durata del turno (mese = 4 settimane). I modificatori scaduti si tolgono nella fase OPEN con **un solo evento aggregato** (`OPINION_DECAYED`).

### 5.3 Tensione di coppia
Resta simmetrica (è un fatto della coppia, non un sentimento). Sale con gli incidenti, scende ogni turno verso un valore di fondo dato dalle crisi in comune. Memorizzata **solo dove è diversa dal fondo**.

### 5.4 Compatibilità
- `relations[a][b].trust` resta per le coppie di fazioni come **valore derivato** = `opinion(a→b)`, ricalcolato dal reducer, così `policy.ts`, Console Ordini e UI continuano a funzionare. Il codice nuovo usa l'helper `opinionOf(state, a, b)`.
- `ctx.relate()` diventa un costruttore di modificatori.
- **Migrazione delle campagne vecchie**: `trust` attuale − base = un modificatore permanente «Storia recente».

### 5.5 Memorizzazione
`WorldState.diplomacy = { modifiers, tension, improving, worldTension, capital, cooldowns, ultimatums }`: tutto sparso, mai la matrice completa. Obiettivo: **≤ 300 KB in più per snapshot** con 197 Stati.

### 5.6 Nebbia
- Ogni Stato conosce **la propria riga** (la sua opinione degli altri).
- L'opinione degli altri verso di me si vede **a fasce** (ostile · fredda · neutra · cordiale · stretta), esatta con un accordo di intelligence o un'ambasciata con fiducia alta.
- Le coppie tra terzi si vedono solo dagli atti pubblici (trattati, voti, dichiarazioni).

## 6. Tensione mondiale

`worldTension` 0–100, in `globalIndicators`. Sale con: escalation massima delle crisi, scontri, strike, blocchi, ultimatum, segnali nucleari. Scende da sola ogni turno senza incidenti.

| Fascia | Effetti |
|---|---|
| 0–24 | Le azioni coercitive delle democrazie costano il doppio di CD e danno −opinione con le altre democrazie |
| 25–49 | Normale |
| 50–74 | Garanzie e alleanze più facili da accettare; sanzioni multilaterali più probabili |
| 75–100 | Tutti più difensivi; gli Stati del mondo si stringono ai propri blocchi; Brent, TTF e rischio navale salgono |

## 7. Capitale diplomatico e azioni

- **CD per turno** dalla potenza: PIL, seggio permanente, `credibility`. Esempio: Italia ~3 a settimana, USA ~6, Malta ~1. Tetto di accumulo 100.
- **Azioni** (catalogo in `engine/diplo-actions.ts`), ognuna con costo, ricarica, prerequisiti e soglie di tensione mondiale:

| Azione | Note |
|---|---|
| Migliorare le relazioni | Continuativa, 1 CD a turno, slot da 2 a 4 secondo la potenza |
| Démarche · Rassicurazione · Minaccia · Canale riservato · Dichiarazione · Lettera | Esistono già: aggiungere costo e ricarica |
| Proposta di trattato | Nuovi tipi: patto di non aggressione, garanzia d'indipendenza, accesso militare, cooperazione di difesa, accordo commerciale (oltre a quelli di oggi) |
| Sanzioni unilaterali o tramite istituzione · embargo sulle armi · revoca | |
| Aiuto economico o militare | Esiste già |
| Richiamo dell'ambasciatore · espulsione di diplomatici · rottura delle relazioni | Scala di escalation diplomatica |
| Ultimatum | Scadenza di N turni. Scaduto: le azioni di forza contro il destinatario non pagano il costo di legittimità; tensione mondiale +5 |
| Risoluzione | CdS (veto), AG ONU (197 voti, non vincolante), Consiglio UE, NATO art. 4, Lega Araba, Unione Africana |
| Mediazione in una crisi | Solo un terzo con opinione ≥ 0 verso entrambe le parti |

- **Legittimità**: una BLOCKADE o una EXCLUSION_ZONE senza risoluzione, ultimatum scaduto o tensione mondiale ≥ 50 costa CD, credibilità e opinione presso i terzi.

## 8. Accettazione

`acceptance(target, proposta, proponente) → { score, accept, reasons: [{ label, value }] }`, **deterministica** (niente dadi: deve essere spiegabile). Motivi:
- base per tipo di trattato;
- opinione del destinatario verso il proponente × peso;
- allineamento;
- **minaccia comune** (il destinatario teme X e il proponente è rivale di X);
- dipendenza commerciale;
- tensione mondiale;
- istituzioni in comune;
- conflitto con trattati esistenti (accordo con un rivale);
- potenza relativa (i piccoli accettano garanzie);
- credibilità del proponente;
- proposta già respinta di recente.

Accetta se `score ≥ 0`. Il giocatore vede punteggio e motivi **prima** di inviare, nel dry-run di `validate` (come il tooltip di HOI4). Le stesse regole valgono per le fazioni IA e per gli Stati del mondo.

## 9. Istituzioni e votazioni

- **AG ONU**: votano tutti (sì · no · astensione). Il voto dipende da opinione verso proponente e bersaglio, allineamento, coesione del blocco e tema.
- **CdS**: 15 membri, veto dei 5 permanenti.
- **UE**: unanimità per sanzioni e PESC, maggioranza qualificata (55% degli Stati, 65% della popolazione) per il resto.
- **NATO**: consenso.
- **Effetti di ogni voto**: modificatori verso chi ha votato contro, credibilità del proponente, legittimità (§7), un evento `INSTITUTION_VOTE` con l'esito per Stato (serve alla mappa).
- **Test di realismo**: una risoluzione dell'AG che condanna l'invasione di uno Stato da parte di un membro permanente deve dare un esito vicino a quello di marzo 2022 (141 sì, 5 no, 35 astenuti): sì tra 120 e 160, no ≤ 15.

## 10. IA mondiale (livello C, `engine/world-ai.ts`)

A ogni turno, solo da eventi **pubblici** e da quanto riguarda lo Stato stesso (nebbia):
1. **Reazioni** agli eventi pubblici gravi (soglia di gravità): sostegno, condanna o silenzio, da una formula su opinioni e allineamento. Un solo evento aggregato `INTERNATIONAL_REACTIONS` per evento grave, con l'elenco degli Stati, e i modificatori relativi.
2. **Voti** nelle istituzioni (§9).
3. **Risposte** alle proposte ricevute, con `acceptance()`.
4. **Sanzioni di blocco**: si adeguano alle decisioni delle istituzioni in base alla coesione.
5. **Agenda lenta**, sfalsata: ogni Stato agisce un turno su quattro (indice % 4): migliorare le relazioni con i partner prioritari, accordi commerciali, raffreddamento con i rivali. Tetto globale (es. 20 azioni a turno), perché il registro resti leggibile.

**Prestazioni**: O(Stati × eventi pubblici). Obiettivo: **turno del motore ≤ 3 s** sul server (4 core, senza GPU) con 197 Stati.

## 11. Agenti LLM a budget

**Principio**: l'LLM non decide mai un esito. Propone **intenzioni** (direttive) o scrive **testi**; il motore li valida, li limita, li registra, e il replay li rilegge senza LLM.

| Ruolo | Cosa fa | Quando |
|---|---|---|
| `strategist` (nuovo) | Direttiva strategica di una grande potenza | Una potenza per turno, a rotazione: ognuna ogni 3–6 turni |
| `chancery` (nuovo) | Frasi brevi delle cancellerie: 1 chiamata scrive le reazioni dei 6–8 Stati più rilevanti | Solo per gli eventi gravi del turno |
| `diplomat` | Lettere (c'è già) | Come oggi |
| `gm_narrator`, `intel_analyst`, `order_parser` | Come oggi | Come oggi |

**Direttiva** (schema con tetti, validata e limitata dal motore):
```ts
{ horizonTurns: 3..6,
  priorities: { kind: 'improve'|'court'|'deter'|'isolate'|'contain'; target: ActorId; weight: 0..1 }[] /* max 4 */,
  zoneInterestDelta: Record<ZoneId, -0.2..0.2> /* max 3 */,
  seekAgreements: { type: AgreementType; with: ActorId }[] /* max 2 */,
  avoid: ActorId[] /* max 2 */, rationale: string /* ≤ 60 parole */ }
```
La direttiva diventa un bonus di punteggio in `policy.ts` e in `world-ai.ts`. Si salva in `directives/turn-N/F.json`. Senza LLM la direttiva è quella deterministica (nessun cambiamento). Contesto ≤ 1.200 token, costruito dal motore (le 10 righe di opinione più rilevanti, crisi, incidenti recenti, trattati propri): sta negli 8k token dei modelli locali.

**Gestore del budget** (`agents/budget.ts`):
- `LLM_BUDGET_CALLS` (chiamate per turno, default 10), `LLM_RPM` (default 8);
- coda a priorità: P0 Console Ordini e briefing → P1 lettere con il giocatore → P2 notizie → P3 direttive → P4 reazioni → P5 lettere tra IA;
- fuori budget: testo deterministico da modello di frase;
- cache per `promptHash`.

**Profili di provider** (`LLM_PROFILE`):
- `locale`: Ollama, qwen3.5 4B/9B, come oggi;
- `gemini`: Flash / Flash-Lite, diretto o via OmniRoute. Il piano gratuito a settembre 2026 è di circa 10–15 richieste al minuto e 1.000–1.500 al giorno per modello (da verificare in AI Studio: i limiti cambiano). Con 10 chiamate a turno sono oltre 100 turni al giorno. Nel piano gratuito Google può usare richieste e risposte per migliorare i modelli;
- `omniroute`: combo con ripiego a cascata (es. Gemini Flash → Mistral → qwen locale).

## 12. Interfaccia

- **Modalità mappa**: Opinione (da/verso il paese selezionato), Allineamento, Trattati, Tensione, Voto (ultimo voto ONU).
- **Scheda paese** per tutti i 197 Stati:
  - dati;
  - opinione nei due sensi con i motivi e i modificatori, con i turni che mancano;
  - trattati e appartenenze;
  - azioni con costo in CD, ricarica e accettazione stimata con i motivi.
- **Barra in alto**: tensione mondiale e CD.
- **Pannello Istituzioni**: votazioni in corso e passate.
- **Registro «Reazioni internazionali»**.

## 13. Misure di realismo e di costo

- **Plausibilità iniziale**: 40 coppie di riferimento con il segno atteso (es. USA→ISR > +40, IRN→ISR < −60, IND→PAK < −30, FRA→DEU > +40, GRC→TUR < 0). È un test.
- **Correlazione** tra base dell'opinione e somiglianza di voto ONU ≥ 0,5, se i dati ci sono.
- **Voto AG di riferimento** (§9).
- **Deriva**: senza eventi, l'opinione media non si sposta di oltre ±10 in 20 turni; la tensione mondiale non resta a 100.
- **Costo**: turno del motore ≤ 3 s; snapshot ≤ +300 KB; ≤ 10 chiamate LLM per turno con `LLM_BUDGET_CALLS=10`; replay «IDENTICO».

## 14. Piano a settori (prompt per Claude Code)

| # | Ramo | Settore | Dipende da |
|---|---|---|---|
| 07 | `claude/stati-del-mondo` | Registro dei 197 Stati, istituzioni, coppie storiche; scheda paese in sola lettura; questo documento nel repo | merge di `claude/stati-a-regole` |
| 08 | `claude/opinione` | Opinione asimmetrica, modificatori con decadimento, tensione di coppia sparsa, tensione mondiale, compatibilità e migrazione | 07 |
| 09 | `claude/azioni-diplomatiche` | Capitale diplomatico, catalogo delle azioni, nuovi trattati, accettazione con motivi, istituzioni e votazioni, legittimità | 08 |
| 10 | `claude/ia-mondiale` | IA di livello C, collegamento di `policy.ts` all'opinione, bilanciamento e prestazioni | 09 |
| 11 | `claude/agenti-a-budget` | Gestore del budget, profili di provider, `strategist` e `chancery`, banco | 10 |
| 12 | `claude/interfaccia-diplomatica` | Modalità mappa, scheda paese completa, CD e tensione mondiale in barra, pannello Istituzioni | 09 (in parallelo a 10–11: tocca quasi solo il frontend) |

Un prompt alla volta, una PR alla volta, verifica sul server prima del merge, come per i prompt 01–06.
