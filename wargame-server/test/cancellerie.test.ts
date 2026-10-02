import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LlmBudget, singleRouting } from '../src/agents/budget.js';
import { assembleStatements, chanceryPrompt, statementErrors, writeStatements } from '../src/agents/chancery.js';
import type { LlmProvider, LlmRequest } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { LlmAgents } from '../src/agents/orchestrator.js';
import { ReplayAgents } from '../src/agents/replay.js';
import { runSim } from '../src/cli/sim.js';
import { chanceryVocabulary, personNames, pickStates, templateStatement, wordCount } from '../src/engine/chancery.js';
import { opinionLookup } from '../src/engine/opinion.js';
import { PARAMS } from '../src/engine/params.js';
import { Engine, type ChanceryJob } from '../src/engine/turn-machine.js';
import { reactTo } from '../src/engine/world-ai.js';
import type { GraveEvent, LlmCall, WorldState } from '../src/schemas/index.js';
import { JsonStore } from '../src/store/json-store.js';
import { campaign, sc } from './diplo-helpers.js';
import { tmp } from './helpers.js';

const at = (turn = 2): WorldState => { const s = structuredClone(sc.world); s.turn = turn; return s; };
const strike: GraveEvent = { id: 'A1-1', kind: 'strike', a: 'RUS', b: 'GRC', severity: 5, turn: 1, text: 'strike su MELLITAH' };
const reaction = (s = at(), ev = strike) => reactTo(s, opinionLookup(s), ev, 'ITA');

const jobOf = (s = at(), ev = strike): ChanceryJob => {
  const r = reaction(s, ev);
  const nm = (x: string) => s.factions[x]?.name ?? x;
  return { campaign: { ...campaign(), id: 'c1', config: { factionMode: 'rules', llm: {} } } as never, turn: 2, event: { id: ev.id, kind: ev.kind, actor: ev.a, victim: ev.b, severity: ev.severity, text: ev.text }, actorName: nm(ev.a), victimName: nm(ev.b), states: pickStates(s, r), vocabulary: chanceryVocabulary(s) };
};

describe('cancellerie: il motore sceglie gli Stati e le posizioni', () => {
  it('6–8 Stati, ognuno con la posizione della reazione; mai le parti né il giocatore', () => {
    const s = at(); const r = reaction(s);
    const st = pickStates(s, r);
    expect(st.length).toBeGreaterThanOrEqual(PARAMS.chancery.minStates);
    expect(st.length).toBeLessThanOrEqual(PARAMS.chancery.maxStates);
    const pos = { condemn: new Set(r.condemn), support: new Set(r.support), silence: new Set(r.silent) };
    for (const x of st) expect(pos[x.position].has(x.iso), `${x.iso} ${x.position}`).toBe(true);
    expect(st.some((x) => ['RUS', 'GRC', 'ITA'].includes(x.iso))).toBe(false);
    expect(new Set(st.map((x) => x.iso)).size).toBe(st.length);
  });

  it('i più rilevanti: membri del Consiglio di sicurezza, vicini e alleati delle parti prima degli altri', () => {
    const s = at();
    const st = pickStates(s, reaction(s));
    const why = (x: (typeof st)[number]) => x.role.join(' | ');
    expect(st.filter((x) => /Consiglio di sicurezza|vicino|alleato/.test(why(x))).length).toBeGreaterThanOrEqual(st.length - 2);
    // l'ordine è per rilevanza e il risultato è deterministico
    expect(pickStates(s, reaction(s))).toEqual(st);
  });

  it('almeno una voce per posizione se la reazione le ha tutte e tre', () => {
    const s = at();
    const r = reaction(s);
    expect(r.condemn.length && r.support.length && r.silent.length).toBeTruthy();
    const st = pickStates(s, r);
    for (const p of ['condemn', 'support', 'silence'] as const) expect(st.some((x) => x.position === p), p).toBe(true);
  });

  it('con una reazione piccola parlano tutti quelli che ci sono; senza reazione nessuno', () => {
    const s = at();
    const small = { actor: 'RUS', victim: 'GRC', condemn: ['FRA', 'DEU'], support: ['BLR'], silent: [] };
    expect(pickStates(s, small).map((x) => `${x.iso}:${x.position}`).sort()).toEqual(['BLR:support', 'DEU:condemn', 'FRA:condemn']);
    expect(pickStates(s, { ...small, condemn: [], support: [] })).toEqual([]);
  });
});

describe('cancellerie: frasi-modello e controlli', () => {
  it('una frase-modello per posizione: ≤ 30 parole, nessuna cifra, nessun nome di persona', () => {
    const j = jobOf();
    for (const kind of Object.keys({ strike: 1, engagement: 1, blockade: 1, ultimatum: 1, sanction: 1, multilateral_sanction: 1, break: 1, embargo: 1, cyber: 1, covert: 1 })) {
      for (const position of ['condemn', 'support', 'silence'] as const) {
        const t = templateStatement({ name: 'Francia', position }, { kind, actorName: j.actorName, victimName: j.victimName });
        expect(wordCount(t), t).toBeLessThanOrEqual(30);
        expect(t).not.toMatch(/\d/);
        expect(personNames(t, j.vocabulary)).toEqual([]);
      }
    }
    expect(templateStatement({ name: 'Francia', position: 'condemn' }, { kind: 'strike', actorName: 'Russia', victimName: 'Grecia' })).toBe('Francia condanna l\'attacco di Russia contro Grecia e chiede il pieno rispetto del diritto internazionale.');
  });

  it('nomi di persona: «il Presidente Macron» e «Vladimir Putin» sì, la carica e le entità note no', () => {
    const v = chanceryVocabulary(at());
    expect(personNames('Il Presidente Macron condanna l\'attacco.', v)).toEqual(['Macron']);
    expect(personNames('Vladimir Putin ha ordinato lo strike.', v).sort()).toEqual(['Putin', 'Vladimir']);
    expect(personNames('il ministro Lavrov ha parlato', v)).toEqual(['Lavrov']);
    for (const ok of ['Il Presidente della Repubblica condanna lo strike su Grecia.', 'Il Governo di Turchia segue con attenzione gli sviluppi nel Mar Rosso.', 'Il Consiglio di Sicurezza delle Nazioni Unite si riunisce.', 'La Francia e la Germania chiedono moderazione.', 'Il Ministro degli Esteri invita al dialogo.'])
      expect(personNames(ok, v), ok).toEqual([]);
  });

  it('statementErrors: lunghezza, numeri non presenti nel fatto, nomi di persona', () => {
    const v = chanceryVocabulary(at());
    const long = Array.from({ length: 31 }, () => 'parola').join(' ');
    expect(statementErrors('Francia condanna lo strike.', ['strike su MELLITAH'], v)).toEqual([]);
    expect(statementErrors(long, [], v)[0]).toMatch(/31 parole/);
    expect(statementErrors('Francia condanna: 45 morti.', ['strike su MELLITAH'], v)[0]).toMatch(/numeri non presenti nel fatto: 45/);
    expect(statementErrors('Francia condanna: 45 morti.', ['45 morti a MELLITAH'], v)).toEqual([]);
    expect(statementErrors('Il Presidente Macron condanna.', [], v)[0]).toMatch(/nomi di persona/);
    expect(statementErrors('   ', [], v)).toEqual(['frase vuota']);
  });

  it('il prompt porta il fatto, gli Stati con posizione e ruolo, e le regole sulle cariche e sui numeri', () => {
    const j = jobOf();
    const p = chanceryPrompt(j);
    expect(p.system).toMatch(/Massimo 30 parole/);
    expect(p.system).toMatch(/SOLO con la carica/);
    expect(p.user).toContain('strike su MELLITAH');
    for (const st of j.states) expect(p.user).toContain(`${st.iso} · ${st.name} · ${st.position}`);
  });
});

/** Modello finto che risponde con le frasi date (e conta le chiamate). */
const says = (statements: unknown, onCall?: (r: LlmRequest) => void): LlmProvider & { calls: LlmRequest[] } => {
  const calls: LlmRequest[] = [];
  return { name: 'finto', calls, async complete(req) { calls.push(req); onCall?.(req); return { text: typeof statements === 'string' ? statements : JSON.stringify({ statements }), usage: { promptTokens: 5, completionTokens: 5 }, latencyMs: 0, model: 'finto' }; } };
};

describe('cancellerie: il ruolo scrive solo il testo', () => {
  it('le posizioni del motore non cambiano anche se il modello le contraddice', async () => {
    const j = jobOf();
    const contradict = j.states.map((st) => ({ iso: st.iso, position: st.position === 'condemn' ? 'support' : 'condemn', text: `${st.name} ha una posizione.` }));
    const r = await writeStatements(says(contradict), [], j);
    expect(r.statements.map((x) => [x.iso, x.position])).toEqual(j.states.map((st) => [st.iso, st.position]));
    expect(r.statements.every((x) => x.source === 'ai')).toBe(true);
    expect(r).toMatchObject({ source: 'ai', model: 'finto', errors: [] });
  });

  it('frasi con numeri inventati, nomi di persona o troppo lunghe: quella frase diventa frase-modello, le altre restano', async () => {
    const j = jobOf();
    const [a, b, c, ...rest] = j.states;
    const model = [
      { iso: a!.iso, text: `${a!.name} condanna lo strike che ha fatto 120 morti.` },
      { iso: b!.iso, text: `Il Presidente Macron esprime preoccupazione.` },
      { iso: c!.iso, text: Array.from({ length: 40 }, () => 'parola').join(' ') },
      ...rest.map((st) => ({ iso: st.iso, text: `${st.name} segue la situazione.` })),
    ];
    const r = await writeStatements(says(model), [], j);
    expect(r.statements.slice(0, 3).map((x) => x.source)).toEqual(['template', 'template', 'template']);
    expect(r.statements.slice(3).every((x) => x.source === 'ai')).toBe(true);
    expect(r.source).toBe('mixed');
    expect(r.errors).toHaveLength(3);
    expect(r.errors.join(' ')).toMatch(/numeri non presenti nel fatto: 120/);
    expect(r.errors.join(' ')).toMatch(/Macron/);
    expect(r.statements[0]!.text).toBe(templateStatement(a!, { kind: 'strike', actorName: j.actorName, victimName: j.victimName }));
  });

  it('uno Stato fuori dall\'elenco si ignora, uno mancante ha la frase-modello', async () => {
    const j = jobOf();
    const model = [{ iso: 'ZZZ', text: 'Frase di uno Stato non richiesto.' }, ...j.states.slice(1).map((st) => ({ iso: st.iso, text: `${st.name} segue la situazione.` }))];
    const r = await writeStatements(says(model), [], j);
    expect(r.statements.map((x) => x.iso)).toEqual(j.states.map((x) => x.iso));
    expect(r.statements[0]!.source).toBe('template');
    expect(r.errors).toEqual([`${j.states[0]!.iso}: frase mancante`]);
  });

  it('risposta inutilizzabile: UN repair, poi tutte frasi-modello', async () => {
    const j = jobOf();
    const p = says('non è json');
    const log: LlmCall[] = [];
    const r = await writeStatements(p, log, j);
    expect(p.calls).toHaveLength(2); // la richiesta e un repair
    expect(r.statements.every((x) => x.source === 'template')).toBe(true);
    expect(r).toMatchObject({ source: 'template', model: 'template' });
    expect(r.statements.map((x) => x.position)).toEqual(j.states.map((x) => x.position));
  });

  it('senza budget non parte nessuna chiamata e valgono le frasi-modello', async () => {
    const j = jobOf();
    const mock = new MockLLMProvider();
    const agents = new LlmAgents(mock, new LlmBudget(singleRouting(mock), { callsPerTurn: 0 }));
    const [r] = await agents.chancery([j]);
    expect(mock.calls).toBe(0);
    expect(r!.source).toBe('template');
    expect(r!.statements).toHaveLength(j.states.length);
    expect(r!.errors[0]).toMatch(/chiamata LLM non fatta/);
  });

  it('assembleStatements senza risposta: tutte le frasi-modello, nessun errore', () => {
    const j = jobOf();
    const { statements, errors } = assembleStatements(j, null, []);
    expect(statements.every((x) => x.source === 'template')).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe('cancellerie nel turno', () => {
  const sanction = { id: 's1', kind: 'SANCTION' as const, target: 'RUS', scope: 'misure mirate' };
  const play = async (calls: number, e?: Engine) => {
    const mock = new MockLLMProvider();
    const store = new JsonStore(tmp());
    const eng = e ?? new Engine(store, new LlmAgents(mock, new LlmBudget(singleRouting(mock), { callsPerTurn: calls })));
    const c = await eng.createCampaign({ scenarioId: 'med-2026', name: 'cancellerie', seed: 'cancellerie', config: { factionMode: 'rules' } });
    await eng.submitOrders(c.id, { military: [], diplomacy: [sanction], procurement: [], statements: [] });
    const r = await runSim(eng, c, 2);
    return { eng, store: eng.store, c: r.campaign, mock };
  };

  it('le frasi finiscono nel file del livello C, nell\'evento INTERNATIONAL_REACTIONS e nelle notizie del turno', async () => {
    const { store, c } = await play(10);
    const w = (await store.getWorldDecision(c.id, 2))!;
    expect(w.chancery.length).toBeGreaterThan(0);
    expect(w.chancery.length).toBeLessThanOrEqual(PARAMS.chancery.maxCalls);
    for (const g of w.chancery) {
      const sts = w.statements.filter((x) => x.eventId === g.eventId);
      expect(sts.length).toBeGreaterThanOrEqual(PARAMS.chancery.minStates);
      expect(sts.length).toBeLessThanOrEqual(PARAMS.chancery.maxStates);
      for (const x of sts) { expect(wordCount(x.text)).toBeLessThanOrEqual(30); expect(x.text).not.toMatch(/\d/); }
      // le posizioni sono quelle della reazione calcolata dal motore
      const r = w.reactions.find((x) => x.eventId === g.eventId)!;
      for (const x of sts) expect({ condemn: r.condemn, support: r.support, silence: r.silent }[x.position]).toContain(x.iso);
    }
    const ev = (await store.getEvents(c.id, 2)).filter((e) => e.type === 'INTERNATIONAL_REACTIONS' && (e.payload as { statements?: unknown[] }).statements?.length);
    expect(ev.length).toBe(w.chancery.length);
    expect(ev.every((e) => e.visibility === 'public')).toBe(true);
    const news = (await store.getNarrative(c.id, 2))!.news.filter((n) => n.kind === 'chancery');
    expect(news.length).toBe(w.chancery.length);
    expect(news[0]!.headline).toMatch(/^Reazioni internazionali: /);
    expect(news[0]!.body).toMatch(/«.+»/);
    expect(new Set((await store.getNarrative(c.id, 2))!.news.map((n) => n.id)).size).toBe((await store.getNarrative(c.id, 2))!.news.length);
  }, 120_000);

  it('senza budget le frasi sono tutte frasi-modello e il turno si completa', async () => {
    const { store, c, mock } = await play(0);
    expect(mock.calls).toBe(0);
    const w = (await store.getWorldDecision(c.id, 2))!;
    expect(w.statements.length).toBeGreaterThan(0);
    expect(w.statements.every((x) => x.source === 'template')).toBe(true);
    expect(w.chancery.every((g) => g.source === 'template' && g.model === 'template')).toBe(true);
  }, 120_000);

  it('budget corto: le cancellerie (P4) vengono prima delle lettere tra IA (P5) e non mangiano il debriefing', async () => {
    // 7 chiamate: briefing (2) + riserva di debriefing e notizie (2) + 3 per il resto, che vanno nell'ordine delle priorità (direttiva P3, cancellerie P4, lettere tra IA P5)
    const { store, c } = await play(7);
    const u = (await store.getLlmUsage(c.id))!.turns['2']!;
    expect(u.admitted).toBeLessThanOrEqual(7);
    expect(u.byRole.chancery ?? 0).toBeGreaterThan(0);
    expect(u.skippedByPriority['5'] ?? 0).toBeGreaterThanOrEqual(u.skippedByPriority['4'] ?? 0); // a cadere per prime sono le lettere tra IA
    // il debriefing (P0) e le notizie (P2) del turno hanno avuto il loro posto
    const n = (await store.getNarrative(c.id, 2))!;
    expect(n.debriefing).toBeTruthy();
    expect(u.byRole.gm_narrator ?? 0).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('replay identico: le frasi vengono dal registro, nessuna chiamata LLM e nessuna notizia doppia', async () => {
    const { eng, store, c: src } = await play(10);
    const replay = new Engine(store, new ReplayAgents(store, src.id));
    const c = await replay.createCampaign({ scenarioId: src.scenarioId, name: 'rep', seed: src.seed, config: src.config });
    const r = await runSim(replay, c, 2, async (t) => { const o = await store.getOrders(src.id, t, 'ITA'); if (o) await store.saveOrders(c.id, o); });
    void eng;
    for (let t = 1; t <= 2; t++) {
      expect(await store.getState(r.campaign.id, t)).toEqual(await store.getState(src.id, t));
      expect(await store.getWorldDecision(r.campaign.id, t)).toEqual(await store.getWorldDecision(src.id, t));
      expect((await store.getNarrative(r.campaign.id, t))!.news).toEqual((await store.getNarrative(src.id, t))!.news);
    }
    expect(readdirSync(store.dir(r.campaign.id)).includes('llm-log')).toBe(false);
  }, 180_000);
});
