// Banco di prova dei modelli per il wargame: rimanda richieste VERE (dal log LLM del turno 1 di una campagna) a ciascun
// modello e misura formato E allucinazioni con le stesse regole del motore:
// - fazione: schema + validatore degli ordini (unità, zone, basi, bersagli inesistenti = allucinazione); le posture per zona
//   si traducono come nel gioco (engine/stances.ts) e per ogni modello si contano gli ordini militari per tipo e quanti
//   vengono dalle posture
// - narratore: schema + numeri non presenti nei fatti
// - riflessione: schema della memoria
// - lettera: risposta di una fazione a una lettera di esempio del giocatore (stesso prompt del gioco): schema, lunghezze e numeri
// - parser: frasi italiane del giocatore per la Console Ordini (cli/parser-cases.ts), stesso prompt e stessi controlli del
//   gioco (nomi → id, posture, parse-review); per modello: corretti / sbagliati / pericolosi (ostili verso alleati, cyber non chiesta)
// Uso: npm run bench:models -- <cartella-campagna> <modello|combo>... [--runs N] [--solo parser,fazioni,narratore,riflessione,lettera] [--mock]
// (config da wargame-server/.env; --mock usa il provider finto al posto dei modelli, per provare il banco)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z, type ZodType } from 'zod';
import '../config.js';
import { MockLLMProvider } from '../agents/mock-provider.js';
import { parserPrompt, ParsedLenient, PARSER_SCHEMA, nameAmbiguities } from '../agents/order-parser.js';
import { finishParsed } from '../engine/parse-review.js';
import { PARSER_CASES, scoreParsed, type Verdict } from './parser-cases.js';
import { AgentMemory, DecisionOutput, type DecisionOutput as DecisionOutputT, type LlmCall, type OrdersBody } from '../schemas/index.js';
import { extractJson, OpenAiCompatProvider } from '../agents/llm-client.js';
import { template } from '../agents/prompts.js';
import { legalActions, memoryText, situation } from '../agents/context-builder.js';
import { DECISION_SCHEMA, trimFormat } from '../agents/faction-agent.js';
import { translateStances } from '../engine/stances.js';
import { LETTER_SCHEMA, letterErrors, letterPrompt } from '../agents/letter-writer.js';
import { leaderOf } from '../engine/diplomacy.js';
import { LETTER_LIMITS, LetterTone } from '../schemas/index.js';
import { numbersNotInFacts } from '../agents/repair.js';
import { loadScenario } from '../engine/scenario.js';
import { validateOrders } from '../engine/validators.js';
import { JsonStore } from '../store/json-store.js';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: 'string', default: '1' }, 'all-factions': { type: 'boolean', default: false }, solo: { type: 'string', default: '' }, mock: { type: 'boolean', default: false } } });
const [dir, ...models] = positionals;
if (!dir || !models.length) { console.error('uso: bench:models -- <cartella-campagna> <modello>... [--runs N] [--solo parser,...] [--mock]'); process.exit(2); }
const only = new Set(opt.solo.split(',').map((x) => x.trim()).filter(Boolean));
const wants = (n: string) => !only.size || only.has(n);
const campaignDir = path.resolve(dir);
const store = new JsonStore(path.dirname(campaignDir));
const campaignId = path.basename(campaignDir);
const campaign = await store.getCampaign(campaignId);
const state = await store.getState(campaignId, 1).catch(() => store.getState(campaignId));
const scenario = loadScenario(campaign.scenarioId);
const needLog = ['fazioni', 'narratore', 'riflessione', 'lettera'].some(wants);
const calls = needLog ? readFileSync(path.join(campaignDir, 'llm-log/turn-0001.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LlmCall) : [];
const pick = (role: string, withFaction = true) => {
  const c = calls.find((x) => x.role === role && (!withFaction || x.factionId));
  if (!c) throw new Error(`nessuna chiamata ${role} nel log`);
  return { factionId: c.factionId ?? '', ...(c.request as { system: string; user: string }) };
};
const none = { factionId: '', system: '', user: '' };
const major = needLog ? pick('faction_major') : none;
const refl = wants('riflessione') ? pick('reflection') : none;
const narr = wants('narratore') ? pick('gm_narrator', false) : none;
const refsOf = async (f: string) => new Set(((await store.getKnowledge(campaignId, f, 1))?.contacts ?? []).map((c) => c.id));
const newFormat = template('faction', { maxLetters: '2' }).split('FORMATO')[1];
const ReflOut = AgentMemory.omit({ schemaVersion: true, factionId: true, updatedTurn: true }).extend({ lessons: z.array(z.string()) });
const NarrOut = z.object({ title: z.string(), sections: z.array(z.object({ heading: z.string(), body: z.string() })), factsRef: z.array(z.string()).default([]) });
const facts = narr.user.split('\n').filter((l) => l.startsWith('['));

type Test = { nome: string; system: string; user: string; schema: ZodType; maxTokens: number; check: (v: never) => string[]; keepLengths?: boolean; jsonSchema?: Record<string, unknown> };
/** per modello: ordini militari per tipo (espliciti + tradotti dalle posture), quanti dalle posture, posture date */
const orderStats: Record<string, { kinds: Record<string, number>; fromStance: number; stances: number; decisions: number }> = {};
let currentModel = '';
const factionTest = async (c: { factionId: string; system: string; user: string }): Promise<Test> => {
  const refs = await refsOf(c.factionId);
  // il messaggio utente si ricostruisce col codice attuale (azioni lecite, situazione), il resto viene dal log
  const k = await store.getKnowledge(campaignId, c.factionId, 1);
  const mem = await store.getMemory(campaignId, c.factionId);
  const legal = k ? legalActions(k, scenario) : null;
  const user = k && mem ? template('faction-user', { turn: '1', date: campaign.date, situation: JSON.stringify(situation(k)), memory: memoryText(mem), legal: JSON.stringify(legal) }) : c.user;
  const system = `${c.system.split('FORMATO')[0]}FORMATO${newFormat}`;
  return {
    nome: `fazione ${c.factionId}`, system: legal ? trimFormat(system, legal.orderKinds) : system, user, schema: DecisionOutput, maxTokens: 3000, jsonSchema: DECISION_SCHEMA,
    check: (v: DecisionOutputT) => {
      let n = 0; const id = () => `B-${++n}`;
      const o = { military: v.orders.military.map((x) => ({ ...x, id: id() })), diplomacy: v.orders.diplomacy.map((x) => ({ ...x, id: id() })), procurement: v.orders.procurement.map((x) => ({ ...x, id: id() })), statements: v.orders.statements.map((x) => ({ ...x, id: id() })) } as OrdersBody;
      // posture → ordini come nel gioco, poi lo stesso validatore
      const f = state.factions[c.factionId]!;
      const spent = validateOrders(state, scenario.catalog, c.factionId, o, refs, campaign.turnLength).estCost;
      const t = translateStances({ units: Object.values(state.units).filter((u) => u.factionId === c.factionId), zones: scenario.world.zones, stances: v.zoneStances, turnLength: campaign.turnLength,
        exclude: o.military.flatMap((x) => ('unitIds' in x ? x.unitIds : [])), budget: f.budget.discretionary - spent });
      o.military.push(...t.orders.map((x) => ({ ...x, id: id() })));
      const st = (orderStats[currentModel] ??= { kinds: {}, fromStance: 0, stances: 0, decisions: 0 });
      st.decisions++; st.stances += v.zoneStances.length; st.fromStance += t.orders.length;
      for (const x of o.military) st.kinds[x.kind] = (st.kinds[x.kind] ?? 0) + 1;
      return validateOrders(state, scenario.catalog, c.factionId, o, refs, campaign.turnLength).errors;
    },
  };
};
const factionCalls = opt['all-factions']
  ? [...new Map(calls.filter((x) => (x.role === 'faction_major' || x.role === 'faction_minor') && x.factionId).map((x) => [x.factionId, { factionId: x.factionId!, ...(x.request as { system: string; user: string }) }])).values()]
  : [major];
// lettera di esempio del giocatore a una potenza maggiore: la fazione risponde col suo profilo e la sua knowledge del turno 1
const letterTest = async (): Promise<Test | null> => {
  const from = major.factionId; const k = await store.getKnowledge(campaignId, from, 1);
  if (!k) return null;
  const rel = state.relations[from]?.ITA;
  const replyTo = { id: 'LT1-ITA-bench', turn: 1, date: campaign.date, from: 'ITA', to: from, fromTitle: leaderOf(state, 'ITA').title, toTitle: leaderOf(state, from).title, place: leaderOf(state, 'ITA').capital,
    subject: 'Sicurezza della navigazione e dialogo diretto', tone: 'firm' as const, visibility: 'private' as const, source: 'human' as const,
    body: 'Signor Presidente,\nil Governo italiano segue con preoccupazione le attività navali nelle aree di crisi del Mediterraneo. Le propongo un canale di dialogo diretto per evitare incidenti e chiedo che le Sue unità mantengano una condotta prudente.\nConfido nella Sua risposta.' };
  const p = letterPrompt({ campaign, factionId: from, to: 'ITA', kind: 'reply', knowledge: k, memory: await store.getMemory(campaignId, from), profile: scenario.profiles[from] ?? '',
    fromTitle: leaderOf(state, from).title, toTitle: leaderOf(state, 'ITA').title, date: campaign.date, relation: rel ? { trust: rel.trust, tension: rel.tension } : null, replyTo, intent: 'mantenere la postura' });
  return {
    nome: 'lettera', system: p.system, user: p.user, maxTokens: 1200, keepLengths: true, jsonSchema: LETTER_SCHEMA,
    // lunghezze controllate a parte (non come errore di schema) per distinguerle nel riepilogo
    schema: z.object({ subject: z.string().min(1), body: z.string().min(1), tone: LetterTone }),
    check: (v: { subject: string; body: string }) => [
      ...(v.subject.length > LETTER_LIMITS.subject ? [`oggetto ${v.subject.length} > ${LETTER_LIMITS.subject} caratteri`] : []),
      ...(v.body.length > LETTER_LIMITS.body ? [`testo ${v.body.length} > ${LETTER_LIMITS.body} caratteri`] : []),
      ...letterErrors(v, p.facts),
    ],
  };
};
const letter = wants('lettera') ? await letterTest() : null;
const tests: Test[] = [
  ...(wants('fazioni') ? await Promise.all(factionCalls.map(factionTest)) : []),
  { nome: 'narratore', system: template('narrator', { doc: 'il briefing di situazione', headings: 'Quadro strategico, Minacce, Energia e rotte, Forze proprie, Raccomandazioni' }), user: narr.user, schema: NarrOut, maxTokens: 2000,
    check: (v: { title: string; sections: unknown }) => { const bad = numbersNotInFacts(JSON.stringify([v.title, v.sections]), facts); return bad.length ? [`numeri inventati: ${bad.join(', ')}`] : []; } },
  { nome: 'riflessione', system: template('reflection', { factionId: refl.factionId }), user: refl.user, schema: ReflOut, maxTokens: 2000, check: () => [] },
  ...(letter ? [letter] : []),
].filter((t) => wants(t.nome.startsWith('fazione') ? 'fazioni' : t.nome));
const p = opt.mock ? new MockLLMProvider() : new OpenAiCompatProvider();
const summary: Record<string, { ok: number; schema: number; halluc: number; err: number; secs: number; n: number }> = {};
for (const model of models) {
  for (let run = 0; run < Number(opt.runs); run++) {
    for (const t of tests) {
      const t0 = Date.now();
      const secs = () => (Date.now() - t0) / 1000;
      const s = (summary[`${model} · ${t.nome.startsWith('fazione') ? 'fazioni' : t.nome}`] ??= { ok: 0, schema: 0, halluc: 0, err: 0, secs: 0, n: 0 });
      s.n++; currentModel = model;
      try {
        const r = await p.complete({ role: 'faction_major', model, temperature: 0.3, maxTokens: t.maxTokens, timeoutMs: 300_000, system: t.system, user: t.user, schemaName: 'Bench', jsonSchema: t.jsonSchema ?? z.toJSONSchema(t.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>, keepLengths: t.keepLengths, meta: {} });
        s.secs += secs();
        let esito = 'OK';
        try {
          const v = t.schema.safeParse(extractJson(r.text));
          if (!v.success) { s.schema++; esito = `SCHEMA ${v.error.issues.length}: ${v.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join(' | ')}`; } else {
            const errs = t.check(v.data as never);
            if (errs.length) { s.halluc++; esito = `ALLUCINA ${errs.length}: ${errs.slice(0, 3).join(' | ')}`; } else s.ok++;
          }
        } catch (e) { s.schema++; esito = `NO JSON (${(e as Error).message}, ${r.text.length} car.): …${r.text.slice(-90).replace(/\n/g, ' ')}`; }
        console.log(`${model.padEnd(28)} ${t.nome.padEnd(11)} ${secs().toFixed(0).padStart(4)}s  in ${r.usage.promptTokens} out ${r.usage.completionTokens}  ${esito.slice(0, 200)}`);
      } catch (e) {
        s.err++; s.secs += secs();
        console.log(`${model.padEnd(28)} ${t.nome.padEnd(11)} ${secs().toFixed(0).padStart(4)}s  ERRORE ${String((e as Error).message).slice(0, 160)}`);
      }
    }
  }
}
// ——— parser: frasi del giocatore → bozza finale (stesso percorso di POST /orders/parse) → confronto con l'atteso ———
const parserStats: Record<string, Record<Verdict | 'secs', number>> = {};
if (wants('parser')) {
  const player = campaign.playerFaction;
  const k = await store.getKnowledge(campaignId, player, 1);
  if (!k) throw new Error(`knowledge ${player} del turno 1 mancante`);
  const cfg = campaign.config.llm.order_parser;
  for (const model of models) {
    for (let run = 0; run < Number(opt.runs); run++) {
      for (const [n, c] of PARSER_CASES.entries()) {
        const st = (parserStats[model] ??= { corretto: 0, sbagliato: 0, pericoloso: 0, secs: 0 });
        const t0 = Date.now();
        const pr = parserPrompt(k, scenario, c.text);
        let verdict: Verdict = 'sbagliato'; let why: string[] = [];
        try {
          const r = await p.complete({ role: 'order_parser', model, temperature: cfg.temperature, maxTokens: cfg.maxTokens, timeoutMs: 300_000, system: pr.system, user: pr.user, schemaName: 'ParsedOrders', jsonSchema: PARSER_SCHEMA,
            meta: { text: pr.recognition.text, original: c.text, legal: pr.legal, recognized: pr.recognition.hits } });
          const v = ParsedLenient.safeParse(extractJson(r.text));
          if (!v.success) why = [`schema: ${v.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join(' | ')}`];
          else {
            const d = finishParsed({ state, scenario, factionId: player, knowledge: k, turnLength: campaign.turnLength, text: c.text,
              parsed: { ...v.data, ambiguities: [...v.data.ambiguities, ...nameAmbiguities(pr.recognition)], recognized: pr.recognition.hits } });
            ({ verdict, reasons: why } = scoreParsed(c, d));
          }
        } catch (e) { why = [`errore: ${(e as Error).message}`]; }
        st[verdict]++; st.secs += (Date.now() - t0) / 1000;
        console.log(`${model.padEnd(28)} parser #${String(n + 1).padStart(2)} ${verdict.toUpperCase().padEnd(10)} ${c.text.slice(0, 60).padEnd(60)} ${why.slice(0, 2).join(' | ').slice(0, 160)}`);
      }
    }
  }
}

console.log('\nRIEPILOGO (ok / schema sbagliato / allucinazioni / errori · secondi medi)');
for (const [k, s] of Object.entries(summary)) console.log(`${k.padEnd(42)} ${s.ok}/${s.n} ok · ${s.schema} schema · ${s.halluc} alluc. · ${s.err} err · ${(s.secs / s.n).toFixed(0)} s`);
console.log('\nORDINI MILITARI DELLE FAZIONI (espliciti + tradotti dalle posture, per tipo)');
const UNIT_KINDS = ['PATROL', 'PRESENCE', 'SHOW_OF_FORCE', 'ESCORT', 'BLOCKADE', 'AIR_DEFENSE', 'MOVE', 'RETURN_TO_BASE', 'REPAIR'];
for (const [m, st] of Object.entries(orderStats)) {
  const withUnits = UNIT_KINDS.reduce((a, k) => a + (st.kinds[k] ?? 0), 0);
  console.log(`${m.padEnd(28)} ${st.decisions} decisioni · ${st.stances} posture → ${st.fromStance} ordini · ordini con unità ${withUnits} · ${Object.entries(st.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'nessun ordine'}`);
}
if (Object.keys(parserStats).length) {
  console.log(`\nPARSER — Console Ordini (${PARSER_CASES.length} frasi × ${opt.runs}: corretti / sbagliati / pericolosi · secondi medi)`);
  for (const [m, st] of Object.entries(parserStats)) {
    const n = st.corretto + st.sbagliato + st.pericoloso;
    console.log(`${m.padEnd(28)} ${st.corretto} corretti · ${st.sbagliato} sbagliati · ${st.pericoloso} pericolosi su ${n} · ${(st.secs / Math.max(1, n)).toFixed(1)} s`);
  }
}
