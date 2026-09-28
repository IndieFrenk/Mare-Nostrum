// Banco di prova dei modelli per il wargame: rimanda richieste VERE (dal log LLM del turno 1 di una campagna) a ciascun
// modello e misura formato E allucinazioni con le stesse regole del motore:
// - fazione: schema + validatore degli ordini (unità, zone, basi, bersagli inesistenti = allucinazione)
// - narratore: schema + numeri non presenti nei fatti
// - riflessione: schema della memoria
// Uso: npm run bench:models -- <cartella-campagna> <modello|combo>... [--runs N]   (config da wargame-server/.env)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z, type ZodType } from 'zod';
import '../config.js';
import { AgentMemory, DecisionOutput, type LlmCall, type OrdersBody } from '../schemas/index.js';
import { extractJson, OpenAiCompatProvider } from '../agents/llm-client.js';
import { template } from '../agents/prompts.js';
import { legalActions, memoryText, situation } from '../agents/context-builder.js';
import { trimFormat } from '../agents/faction-agent.js';
import { numbersNotInFacts } from '../agents/repair.js';
import { loadScenario } from '../engine/scenario.js';
import { validateOrders } from '../engine/validators.js';
import { JsonStore } from '../store/json-store.js';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: 'string', default: '1' }, 'all-factions': { type: 'boolean', default: false } } });
const [dir, ...models] = positionals;
if (!dir || !models.length) { console.error('uso: bench:models -- <cartella-campagna> <modello>... [--runs N]'); process.exit(2); }
const campaignDir = path.resolve(dir);
const store = new JsonStore(path.dirname(campaignDir));
const campaignId = path.basename(campaignDir);
const campaign = await store.getCampaign(campaignId);
const state = await store.getState(campaignId, 1).catch(() => store.getState(campaignId));
const scenario = loadScenario(campaign.scenarioId);
const calls = readFileSync(path.join(campaignDir, 'llm-log/turn-0001.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LlmCall);
const pick = (role: string, withFaction = true) => {
  const c = calls.find((x) => x.role === role && (!withFaction || x.factionId));
  if (!c) throw new Error(`nessuna chiamata ${role} nel log`);
  return { factionId: c.factionId ?? '', ...(c.request as { system: string; user: string }) };
};
const major = pick('faction_major');
const refl = pick('reflection');
const narr = pick('gm_narrator', false);
const refsOf = async (f: string) => new Set(((await store.getKnowledge(campaignId, f, 1))?.contacts ?? []).map((c) => c.id));
const newFormat = readFileSync(new URL('../agents/prompts/faction.md', import.meta.url), 'utf8').split('FORMATO')[1];
const ReflOut = AgentMemory.omit({ schemaVersion: true, factionId: true, updatedTurn: true }).extend({ lessons: z.array(z.string()) });
const NarrOut = z.object({ title: z.string(), sections: z.array(z.object({ heading: z.string(), body: z.string() })), factsRef: z.array(z.string()).default([]) });
const facts = narr.user.split('\n').filter((l) => l.startsWith('['));

type Test = { nome: string; system: string; user: string; schema: ZodType; maxTokens: number; check: (v: never) => string[] };
const factionTest = async (c: { factionId: string; system: string; user: string }): Promise<Test> => {
  const refs = await refsOf(c.factionId);
  // il messaggio utente si ricostruisce col codice attuale (azioni lecite, situazione), il resto viene dal log
  const k = await store.getKnowledge(campaignId, c.factionId, 1);
  const mem = await store.getMemory(campaignId, c.factionId);
  const legal = k ? legalActions(k, scenario) : null;
  const user = k && mem ? template('faction-user', { turn: '1', date: campaign.date, situation: JSON.stringify(situation(k)), memory: memoryText(mem), legal: JSON.stringify(legal) }) : c.user;
  const system = `${c.system.split('FORMATO')[0]}FORMATO${newFormat}`;
  return {
    nome: `fazione ${c.factionId}`, system: legal ? trimFormat(system, legal.orderKinds) : system, user, schema: DecisionOutput, maxTokens: 3000,
    check: (v: { orders: OrdersBody }) => {
      let n = 0; const id = () => `B-${++n}`;
      const o = { military: v.orders.military.map((x) => ({ ...x, id: id() })), diplomacy: v.orders.diplomacy.map((x) => ({ ...x, id: id() })), procurement: v.orders.procurement.map((x) => ({ ...x, id: id() })), statements: v.orders.statements.map((x) => ({ ...x, id: id() })) } as OrdersBody;
      return validateOrders(state, scenario.catalog, c.factionId, o, refs, campaign.turnLength).errors;
    },
  };
};
const factionCalls = opt['all-factions']
  ? [...new Map(calls.filter((x) => (x.role === 'faction_major' || x.role === 'faction_minor') && x.factionId).map((x) => [x.factionId, { factionId: x.factionId!, ...(x.request as { system: string; user: string }) }])).values()]
  : [major];
const tests: Test[] = [
  ...await Promise.all(factionCalls.map(factionTest)),
  { nome: 'narratore', system: template('narrator', { doc: 'il briefing di situazione', headings: 'Quadro strategico, Minacce, Energia e rotte, Forze proprie, Raccomandazioni' }), user: narr.user, schema: NarrOut, maxTokens: 2000,
    check: (v: { title: string; sections: unknown }) => { const bad = numbersNotInFacts(JSON.stringify([v.title, v.sections]), facts); return bad.length ? [`numeri inventati: ${bad.join(', ')}`] : []; } },
  { nome: 'riflessione', system: template('reflection', { factionId: refl.factionId }), user: refl.user, schema: ReflOut, maxTokens: 2000, check: () => [] },
];
const p = new OpenAiCompatProvider();
const summary: Record<string, { ok: number; schema: number; halluc: number; err: number; secs: number; n: number }> = {};
for (const model of models) {
  for (let run = 0; run < Number(opt.runs); run++) {
    for (const t of tests) {
      const t0 = Date.now();
      const secs = () => (Date.now() - t0) / 1000;
      const s = (summary[`${model} · ${t.nome.startsWith('fazione') ? 'fazioni' : t.nome}`] ??= { ok: 0, schema: 0, halluc: 0, err: 0, secs: 0, n: 0 });
      s.n++;
      try {
        const r = await p.complete({ role: 'faction_major', model, temperature: 0.3, maxTokens: t.maxTokens, timeoutMs: 300_000, system: t.system, user: t.user, schemaName: 'Bench', jsonSchema: z.toJSONSchema(t.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>, meta: {} });
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
console.log('\nRIEPILOGO (ok / schema sbagliato / allucinazioni / errori · secondi medi)');
for (const [k, s] of Object.entries(summary)) console.log(`${k.padEnd(42)} ${s.ok}/${s.n} ok · ${s.schema} schema · ${s.halluc} alluc. · ${s.err} err · ${(s.secs / s.n).toFixed(0)} s`);
