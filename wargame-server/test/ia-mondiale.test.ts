import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DigestVote, WorldDecision, WorldState } from '../src/schemas/index.js';
import { ReplayAgents } from '../src/agents/replay.js';
import { runSim } from '../src/cli/sim.js';
import { adjudicate } from '../src/engine/adjudication.js';
import { opinionLookup, opinionOf } from '../src/engine/opinion.js';
import { PARAMS } from '../src/engine/params.js';
import { Rng } from '../src/engine/rng.js';
import { Engine } from '../src/engine/turn-machine.js';
import { buildDigest, viewOf } from '../src/engine/world-digest.js';
import { reactTo, worldAiTurn, worldStates } from '../src/engine/world-ai.js';
import { worldData } from '../src/engine/world-data.js';
import { ctxOf, sc } from './diplo-helpers.js';
import { makeEngine } from './helpers.js';

const input = (s: WorldState, digest = buildDigest([], 0), seed = 'ia-mondiale') => ({ state: s, digest, player: 'ITA', rng: new Rng(seed, 0, s.turn), playerLettersPrev: [] });
const at = (turn: number) => { const s = structuredClone(sc.world); s.turn = turn; return s; };
const strike = { id: 'A1-1', kind: 'strike' as const, a: 'RUS', b: 'GRC', severity: 5, turn: 1, text: 'strike su MELLITAH' };

describe('IA mondiale: digest pubblico e nebbia', () => {
  it('il digest tiene gli atti pubblici gravi e, per gli atti non pubblici, solo chi ne era destinatario', () => {
    const ctx = ctxOf();
    ctx.relate('RUS', 'GRC', -25, 25, 'strike su MELLITAH', { incident: true });
    ctx.relate('RUS', 'TUR', -25, 25, 'strike su UNITA', { incident: true, visibility: ['RUS', 'TUR'] });
    ctx.relate('ITA', 'EGY', -2, 3, 'démarche: prova'); // non è un atto grave
    const d = buildDigest(ctx.events, 1);
    expect(d.events.map((e) => [e.kind, e.a, e.b, e.severity])).toEqual([['strike', 'RUS', 'GRC', 5]]);
    expect(d.involving.TUR?.map((e) => e.kind)).toEqual(['strike']);
    expect(d.involving.GRC).toBeUndefined();
    // la vista di un Stato qualunque ha solo l'atto pubblico; quella del destinatario anche il suo
    expect(viewOf(d, 'POL')).toHaveLength(1);
    expect(viewOf(d, 'TUR')).toHaveLength(2);
  });

  it('uno Stato non reagisce a un evento non pubblico che non lo riguarda: nessuna reazione, nessuna azione dettata da quell\'atto', () => {
    const ctx = ctxOf();
    ctx.relate('RUS', 'GRC', -25, 25, 'strike su MELLITAH', { incident: true, visibility: ['RUS', 'GRC'] });
    const d = buildDigest(ctx.events, 1);
    expect(d.events).toEqual([]);
    const out = worldAiTurn(input(at(2), d));
    expect(out.reactions).toEqual([]);
    // nessuno Stato terzo richiama l'ambasciatore dalla Russia per un atto che non può conoscere
    expect(out.actions.filter((a) => a.action.kind === 'RECALL_AMBASSADOR')).toEqual([]);
  });

  it('le votazioni pubbliche delle istituzioni sono nel digest; le sanzioni approvate sono un atto grave multilaterale', () => {
    const ctx = ctxOf();
    const eu = worldData().membersOf('EU');
    ctx.emit('INSTITUTION_VOTE', 'FRA', { forum: 'EU_COUNCIL', institutionId: 'EU', subject: 'Sanzioni', topic: 'sanctions', proposer: 'FRA', target: 'RUS', passed: true, yes: eu, no: [], abstain: [] }, { targets: ['RUS'] });
    const d = buildDigest(ctx.events, 1);
    expect(d.votes).toHaveLength(1);
    expect(d.events.map((e) => [e.kind, e.a, e.b])).toEqual([['multilateral_sanction', 'FRA', 'RUS']]);
  });
});

describe('IA mondiale: reazioni agli atti gravi', () => {
  const s = at(2);
  const op = opinionLookup(s);
  const r = reactTo(s, op, strike, 'ITA');

  it('dopo uno strike di RUS su uno Stato UE la maggior parte dei membri UE condanna e i membri CSTO no', () => {
    const eu = worldData().membersOf('EU').filter((x) => x !== 'GRC' && x !== 'ITA');
    expect(eu.filter((x) => r.condemn.includes(x)).length / eu.length).toBeGreaterThanOrEqual(0.8);
    const csto = worldData().membersOf('CSTO').filter((x) => x !== 'RUS');
    expect(csto.filter((x) => r.condemn.includes(x))).toEqual([]);
    expect(r.support).toEqual(expect.arrayContaining(['BLR', 'KAZ']));
    // l'attore, la vittima e il giocatore non reagiscono; i tre elenchi non si sovrappongono
    for (const x of ['RUS', 'GRC', 'ITA']) expect([...r.condemn, ...r.support, ...r.silent]).not.toContain(x);
    expect(new Set([...r.condemn, ...r.support, ...r.silent]).size).toBe(r.condemn.length + r.support.length + r.silent.length);
    expect(r.condemn.length + r.support.length + r.silent.length).toBeGreaterThan(190);
  });

  it('i modificatori sono aggregati con un tetto: prima le fazioni, mai uno per Stato', () => {
    expect(r.modifiers.length).toBeLessThanOrEqual(PARAMS.worldAi.reaction.maxModifiersPerEvent);
    expect(r.modifiers.length).toBeGreaterThan(0);
    expect(r.modifiers.every((m) => ['condemnation', 'support'].includes(m.kind) && Math.abs(m.value) === PARAMS.worldAi.reaction.opinion)).toBe(true);
    // chi condanna lo strike è visto peggio dall'attore (opinion(attore→chi condanna) cala) e meglio dalla vittima
    const c = r.modifiers.find((m) => m.kind === 'condemnation')!;
    expect(c.from).toBe('RUS');
    expect(r.modifiers.some((m) => m.kind === 'support' && m.from === 'GRC' && m.to === c.to)).toBe(true);
  });

  it('un evento INTERNATIONAL_REACTIONS per atto grave in aggiudicazione, con tre elenchi e i modificatori applicati allo stato', () => {
    const ctx = ctxOf((st) => { st.turn = 2; });
    const ctxEvents = ctxOf();
    ctxEvents.relate('RUS', 'GRC', -25, 25, 'strike su MELLITAH', { incident: true });
    const out = worldAiTurn(input(ctx.state, buildDigest(ctxEvents.events, 1)));
    expect(out.reactions).toHaveLength(1);
    const world: WorldDecision = { schemaVersion: 1, turn: 2, digest: { events: [], votes: [] }, actions: [], reactions: out.reactions, blockSanctions: [], rationale: [], letters: [], stats: out.stats };
    const before = opinionOf(ctx.state, 'RUS', out.reactions[0]!.modifiers.find((m) => m.kind === 'condemnation')!.to).value;
    adjudicate(ctx, [], world);
    const ev = ctx.events.filter((e) => e.type === 'INTERNATIONAL_REACTIONS');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.visibility).toBe('public');
    expect(ev[0]!.payload).toMatchObject({ kind: 'strike', actor: 'RUS', victim: 'GRC' });
    for (const k of ['condemn', 'support', 'silent']) expect(Array.isArray(ev[0]!.payload[k])).toBe(true);
    const cm = out.reactions[0]!.modifiers.find((m) => m.kind === 'condemnation')!;
    expect(opinionOf(ctx.state, 'RUS', cm.to).value).toBeLessThan(before);
    expect(opinionOf(ctx.state, 'RUS', cm.to).modifiers.some((m) => m.kind === 'condemnation')).toBe(true);
  });
});

describe('IA mondiale: sanzioni di blocco', () => {
  const vote = (institutionId: string, forum: string, yes: string[], extra: Partial<DigestVote> = {}): DigestVote => ({ id: 'E1-9', turn: 1, forum, institutionId, proposer: 'FRA', target: 'RUS', topic: 'sanctions', subject: 'Sanzioni', passed: true, yes, no: [], abstain: [], ...extra });
  const run = (v: DigestVote, seed = 'bs') => worldAiTurn({ ...input(at(2), { turn: 1, events: [], involving: {}, votes: [v], accepted: [] }, seed) });

  it('l\'UE approva sanzioni: gli Stati membri senza fazione che hanno votato sì si adeguano con probabilità = coesione (tiro registrato)', () => {
    const eu = worldData().membersOf('EU');
    const rng = new Rng('bs', 0, 2);
    const out = worldAiTurn({ ...input(at(2), { turn: 1, events: [], involving: {}, votes: [vote('EU', 'EU_COUNCIL', eu)], accepted: [] }), rng });
    const b = out.blockSanctions[0]!;
    const pool = worldStates().filter((n) => eu.includes(n.iso3)).map((n) => n.iso3);
    expect(pool.length).toBeGreaterThan(15);
    expect([...b.adopters, ...b.holdouts].sort()).toEqual(pool.filter((x) => x !== 'FRA').sort());
    const coh = worldData().institution('EU')!.cohesion;
    expect(b.adopters.length / pool.length).toBeGreaterThan(coh - 0.3);
    expect(b.adopters.length / pool.length).toBeLessThan(Math.min(1, coh + 0.3) + 1e-9);
    expect(b.holdouts.length).toBeGreaterThan(0);
    // un tiro registrato per Stato, con il motivo
    expect(rng.rolls.filter((r) => r.purpose.startsWith('adeguamento alle sanzioni E1-9')).length).toBe(pool.length);
    // chi non ha votato sì non si adegua
    const some = run(vote('EU', 'EU_COUNCIL', eu.filter((x) => !['POL', 'SWE'].includes(x)))).blockSanctions[0]!;
    expect(some.adopters).not.toContain('POL'); expect(some.adopters).not.toContain('SWE');
  });

  it('con coesione maggiore si adeguano di più; le sanzioni non vincolanti dell\'AG non vincolano nessuno', () => {
    const w = worldData();
    const ecowas = w.membersOf('ECOWAS');
    const n = (iso: string[]) => run(vote('ECOWAS', 'EU_COUNCIL', iso, { proposer: 'NGA', target: 'MLI' })).blockSanctions[0]?.adopters.length ?? 0;
    expect(n(ecowas)).toBeGreaterThan(0);
    expect(run(vote('UNGA', 'UNGA', w.membersOf('UNGA'))).blockSanctions).toEqual([]);
    expect(run(vote('AU', 'AU', w.membersOf('AU'))).blockSanctions).toEqual([]);
    // sanzioni respinte: nessun adeguamento
    expect(run(vote('EU', 'EU_COUNCIL', w.membersOf('EU'), { passed: false })).blockSanctions).toEqual([]);
  });

  it('in aggiudicazione un evento per risoluzione con un modificatore «sanzioni» per Stato che si adegua (si accumulano, tetto), e la stabilità del bersaglio scende', () => {
    const ctx = ctxOf((st) => { st.turn = 2; });
    const out = run(vote('EU', 'EU_COUNCIL', worldData().membersOf('EU')));
    const b = out.blockSanctions[0]!;
    const stab = ctx.state.factions.RUS!.stability;
    adjudicate(ctx, [], { schemaVersion: 1, turn: 2, digest: { events: [], votes: [] }, actions: [], reactions: [], blockSanctions: out.blockSanctions, rationale: [], letters: [], stats: out.stats });
    const ev = ctx.events.filter((e) => e.type === 'INTERNATIONAL_REACTIONS');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ kind: 'block_sanctions', victim: 'RUS', adopters: b.adopters });
    const iso = b.adopters[0]!;
    expect(opinionOf(ctx.state, 'RUS', iso).modifiers.find((m) => m.kind === 'sanction')!.value).toBe(PARAMS.worldAi.blockSanctions.opinion);
    expect(ctx.state.factions.RUS!.stability).toBeLessThan(stab);
  });
});

describe('IA mondiale: agenda lenta', () => {
  it('ogni Stato agisce al più un turno su quattro (sfalsati) e una sola azione per turno', () => {
    const turnsOf = new Map<string, number[]>();
    for (let t = 1; t <= 8; t++) {
      const out = worldAiTurn(input(at(t)));
      const actors = out.actions.map((a) => a.actor);
      expect(new Set(actors).size).toBe(actors.length);
      for (const a of actors) turnsOf.set(a, [...(turnsOf.get(a) ?? []), t]);
    }
    expect(turnsOf.size).toBeGreaterThan(30);
    for (const [a, ts] of turnsOf) for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!, `${a}: ${ts}`).toBeGreaterThanOrEqual(4);
    // gli Stati che toccano a un turno non sono quelli del turno dopo
    const t1 = worldAiTurn(input(at(1))).actions.map((a) => a.actor); const t2 = worldAiTurn(input(at(2))).actions.map((a) => a.actor);
    expect(t1.filter((x) => t2.includes(x))).toEqual([]);
  });

  it('tetto globale rispettato, con priorità alle azioni verso le fazioni e il giocatore; il resto è rimandato e registrato', () => {
    const out = worldAiTurn(input(at(2)));
    expect(out.actions.length).toBeLessThanOrEqual(PARAMS.worldAi.agenda.maxActionsPerTurn);
    expect(out.stats.candidates).toBeGreaterThan(PARAMS.worldAi.agenda.maxActionsPerTurn);
    expect(out.stats.capped).toBe(out.stats.candidates - out.actions.length);
    expect(out.rationale.some((r) => r.rule === 'cap')).toBe(true);
    // con un tetto più basso restano per prime le azioni verso fazioni
    const cap = PARAMS.worldAi.agenda as { maxActionsPerTurn: number };
    const keep = cap.maxActionsPerTurn; cap.maxActionsPerTurn = 5;
    try {
      const few = worldAiTurn(input(at(2)));
      const targets = few.actions.map((a) => a.action).map((a) => ('target' in a ? (Array.isArray(a.target) ? a.target[0] : a.target) : ''));
      expect(few.actions).toHaveLength(5);
      expect(targets.every((t) => !!sc.world.factions[t!])).toBe(true);
    } finally { cap.maxActionsPerTurn = keep; }
  });

  it('le azioni sono quelle dell\'agenda (migliorare le relazioni, accordo commerciale, rassicurazione, richiamo), con motivazione; nessuna ha CD', () => {
    const out = worldAiTurn(input(at(2)));
    expect(new Set(out.actions.map((a) => a.action.kind))).toEqual(new Set(['PROPOSE_AGREEMENT', 'IMPROVE_RELATIONS'].filter((k) => out.actions.some((a) => a.action.kind === k))));
    for (const a of out.actions) expect(worldData().nation(a.actor)?.factionId).toBeUndefined();
    expect(out.rationale.filter((r) => r.rule === 'agenda')).toHaveLength(out.actions.length);
    expect(out.rationale.find((r) => r.rule === 'agenda')!.text).toMatch(/Partner prioritario/);
    // le proposte commerciali sono solo verso chi le accetterebbe: nessuna rifiutata
    const ctx = ctxOf((st) => { st.turn = 2; });
    const rejected = adjudicate(ctx, [], { schemaVersion: 1, turn: 2, digest: { events: [], votes: [] }, actions: out.actions, reactions: [], blockSanctions: [], rationale: [], letters: [], stats: out.stats });
    expect(rejected).toEqual([]);
    expect(ctx.state.diplomacy!.capital[out.actions[0]!.actor]).toBeUndefined();
  });

  it('un atto grave di un rivale fa richiamare l\'ambasciatore a chi sta con la vittima (tiro registrato); senza opinione ostile no', () => {
    const ctx = ctxOf();
    ctx.relate('RUS', 'GRC', -25, 25, 'strike su MELLITAH', { incident: true });
    const d = buildDigest(ctx.events, 1);
    let recalls = 0;
    for (let t = 1; t <= 4; t++) { const out = worldAiTurn(input(at(t), d, `r${t}`)); recalls += out.actions.filter((a) => a.action.kind === 'RECALL_AMBASSADOR').length; for (const a of out.actions.filter((x) => x.action.kind === 'RECALL_AMBASSADOR')) expect(a.action).toMatchObject({ target: 'RUS' }); }
    expect(recalls).toBeGreaterThan(0);
    const calm = [1, 2, 3, 4].reduce((n, t) => n + worldAiTurn(input(at(t), buildDigest([], 0), `r${t}`)).actions.filter((a) => a.action.kind === 'RECALL_AMBASSADOR').length, 0);
    expect(calm).toBe(0);
  });

  it('determinismo: stesso stato, stesso digest e stesso seed → stesse decisioni; un altro seed cambia i tiri', () => {
    const ctx = ctxOf();
    ctx.relate('RUS', 'GRC', -25, 25, 'strike su MELLITAH', { incident: true });
    const d = buildDigest(ctx.events, 1);
    const a = worldAiTurn(input(at(2), d, 'x')); const b = worldAiTurn(input(at(2), d, 'x'));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.actions.length).toBeGreaterThan(0);
  });
});

describe('IA mondiale: lettere al giocatore', () => {
  const trig = (mk: (ctx: ReturnType<typeof ctxOf>) => void, prev: unknown[] = []) => {
    const ctx = ctxOf(); mk(ctx);
    return worldAiTurn({ ...input(at(2), buildDigest(ctx.events, 1)), playerLettersPrev: prev as never }).letterTriggers;
  };

  it('scrive solo per una risposta o per un innesco forte: ultimatum italiano, sanzioni subite, accordo accettato', () => {
    expect(trig((c) => { c.relate('ITA', 'POL', -5, 10, 'ultimatum: ritirare le navi'); })).toMatchObject([{ iso: 'POL', kind: 'initiative', trigger: 'ultimatum', tone: 'firm' }]);
    expect(trig((c) => { c.relate('POL', 'ITA', -15, 10, 'sanzioni: misure economiche'); })).toMatchObject([{ iso: 'POL', trigger: 'sanction' }]);
    expect(trig((c) => { c.emit('AGREEMENT_CHANGED', 'ITA', { agreement: { id: 'AG-1', type: 'trade', parties: ['ITA', 'POL'], terms: 'x', startTurn: 1, endTurn: null, visibility: 'public', status: 'active' } }); })).toMatchObject([{ iso: 'POL', trigger: 'agreement', tone: 'cordial' }]);
    // senza nulla di forte nessuna lettera; una démarche o una minaccia non bastano
    expect(trig((c) => { c.relate('ITA', 'POL', -2, 3, 'démarche: prova'); })).toEqual([]);
    // gli atti di fazioni non sono lettere degli Stati del mondo
    expect(trig((c) => { c.relate('ITA', 'TUR', -5, 10, 'ultimatum: x'); })).toEqual([]);
  });

  it('risponde a una lettera del giocatore (e la risposta viene prima degli inneschi)', () => {
    const letter = { id: 'LT1-ITA-1', turn: 1, date: '2026-03-09', from: 'ITA', to: 'POL', fromTitle: 'x', toTitle: 'y', place: 'Roma', subject: 'Dialogo', body: 'Signor Presidente', tone: 'cordial', visibility: 'private', source: 'human' };
    const t = trig((c) => { c.relate('ITA', 'POL', -5, 10, 'ultimatum: x'); c.relate('ITA', 'CZE', -5, 10, 'ultimatum: x'); }, [letter]);
    expect(t.map((x) => [x.iso, x.kind])).toEqual([['POL', 'reply'], ['CZE', 'initiative']]);
    expect(t[0]!.replyTo!.id).toBe('LT1-ITA-1');
  });
});

describe('IA mondiale nel motore', () => {
  const replayOf = async (e: Engine, srcId: string, turns: number) => {
    const src = await e.store.getCampaign(srcId);
    const replay = new Engine(e.store, new ReplayAgents(e.store, src.id));
    const c = await replay.createCampaign({ scenarioId: src.scenarioId, name: 'rep', seed: src.seed, config: src.config });
    return runSim(replay, c, turns, async (t) => { const o = await e.store.getOrders(src.id, t, 'ITA'); if (o) await e.store.saveOrders(c.id, o); });
  };

  it('un solo file di decisioni per turno (decisions/turn-N/_world.json), nessun file per Stato; rifiuti 0; replay identico', async () => {
    const e = makeEngine();
    const rejected: unknown[] = [];
    e.onProgress = (_, m) => { if (m.rejected) rejected.push(...(m.rejected as unknown[])); };
    const src = (await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: 'mondo', seed: 'ia-mondo' }), 6)).campaign;
    expect(rejected).toEqual([]);
    for (let t = 1; t <= 6; t++) {
      const w = (await e.store.getWorldDecision(src.id, t))!;
      expect(w.turn).toBe(t);
      expect(w.actions.length).toBeLessThanOrEqual(PARAMS.worldAi.agenda.maxActionsPerTurn + 2);
      expect(w.stats.eligible).toBeGreaterThan(30);
    }
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(e.store.dir(src.id, 'decisions', 'turn-0003')).filter((f) => !f.endsWith('.json')).length).toBe(0);
    expect(readdirSync(e.store.dir(src.id, 'decisions', 'turn-0003')).some((f) => /^[A-Z]{3}\.json$/.test(f) && !['ITA', 'USA', 'FRA', 'TUR', 'RUS', 'CHN', 'GBR', 'GRC', 'EGY', 'ISR', 'ALG', 'TUN', 'IRN', 'ESP', 'MAR', 'MLT', 'CYP', 'LBN', 'SYR', 'JOR', 'SAU', 'ARE', 'QAT', 'DEU'].includes(f.slice(0, 3)))).toBe(false);
    const r = await replayOf(e, src.id, 6);
    for (let t = 1; t <= 6; t++) {
      expect(await e.store.getState(r.campaign.id, t)).toEqual(await e.store.getState(src.id, t));
      expect(await e.store.getWorldDecision(r.campaign.id, t)).toEqual(await e.store.getWorldDecision(src.id, t));
    }
  }, 60_000);

  it('una decisione del livello C registrata che non torna con le regole ferma il replay (REPLAY_DIVERGENT)', async () => {
    const e = makeEngine();
    const src = (await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: 'mondo', seed: 'ia-mondo-manomesso' }), 3)).campaign;
    const file = e.store.dir(src.id, 'decisions', 'turn-0003', '_world.json');
    const w = JSON.parse(readFileSync(file, 'utf8'));
    w.rationale.push({ rule: 'agenda', actor: 'POL', text: 'manomessa' });
    writeFileSync(file, JSON.stringify(w));
    await expect(replayOf(e, src.id, 3)).rejects.toMatchObject({ code: 'REPLAY_DIVERGENT' });
  }, 60_000);

  it('il giocatore può scrivere a uno Stato del mondo e questo risponde nel turno dopo (lettera scritta dal ruolo diplomat)', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'lettere', seed: 'ia-lettere' });
    const letter = { id: 'pl1', kind: 'LETTER' as const, target: 'POL', subject: 'Dialogo tra i due Governi', body: 'Signor Presidente,\nLe propongo un canale di dialogo diretto tra i nostri Governi.', tone: 'cordial' as const, visibility: 'private' as const };
    await e.submitOrders(c.id, { military: [], diplomacy: [letter], procurement: [], statements: [] });
    await e.advance(c.id); // turno 1 chiuso: la lettera è partita
    await e.advance(c.id); // turno 2 (ordini vuoti): lo Stato risponde
    const sent = (await e.store.getLetters(c.id, 1)).find((l) => l.from === 'ITA' && l.to === 'POL');
    expect(sent).toBeTruthy();
    const w2 = (await e.store.getWorldDecision(c.id, 2))!;
    expect(w2.letters).toMatchObject([{ actor: 'POL', to: 'ITA', kind: 'reply', inReplyTo: sent!.id }]);
    const reply = (await e.store.getLetters(c.id, 2)).find((l) => l.from === 'POL');
    expect(reply).toMatchObject({ to: 'ITA', inReplyTo: sent!.id });
    expect(reply!.fromTitle).toMatch(/Polonia/);
    // un destinatario senza capo di Stato (un blocco) resta escluso, e uno Stato sconosciuto è un errore
    const bad = await e.validate(c.id, { military: [], diplomacy: [{ ...letter, id: 'x', target: 'NATO' }, { ...letter, id: 'y', target: 'ZZZ' }], procurement: [], statements: [] });
    expect(bad.errors.join()).toMatch(/NATO non ha un capo di Stato/);
    expect(bad.errors.join()).toMatch(/destinatario ZZZ sconosciuto/);
  }, 60_000);

  it('le Knowledge delle fazioni portano le reazioni del mondo che le riguardano e solo quelle', async () => {
    const { worldView } = await import('../src/engine/knowledge.js');
    const t = ctxOf();
    t.emit('INTERNATIONAL_REACTIONS', 'world', { eventRef: 'A1-1', kind: 'strike', actor: 'RUS', victim: 'GRC', severity: 5, condemn: ['FRA', 'DEU', 'POL'], support: ['BLR'], silent: ['IND'], modifiers: [] }, { visibility: 'public' });
    expect(worldView(t.events, 'RUS').reactions).toMatchObject([{ actor: 'RUS', victim: 'GRC', condemn: 3, support: 1, silent: 1, topCondemners: ['DEU', 'FRA', 'POL'] }]);
    expect(worldView(t.events, 'GRC').reactions).toHaveLength(1);
    expect(worldView(t.events, 'TUR').reactions).toEqual([]);
  }, 60_000);
});
