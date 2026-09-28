import { describe, expect, it } from 'vitest';
import type { DiploAction, LetterAction, OrdersBody } from '../src/schemas/index.js';
import { LETTER_LIMITS } from '../src/schemas/index.js';
import { TurnCtx } from '../src/engine/context.js';
import { LETTER_TONE_EFFECTS, resolveDiplomacy } from '../src/engine/diplomacy.js';
import { Rng } from '../src/engine/rng.js';
import { loadScenario } from '../src/engine/scenario.js';
import { validateOrders } from '../src/engine/validators.js';
import { runSim } from '../src/cli/sim.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { makeEngine } from './helpers.js';

const letter = (p: Partial<LetterAction> = {}): LetterAction => ({
  id: 'l1', kind: 'LETTER', target: 'TUR', subject: 'Sicurezza della navigazione nel Mediterraneo orientale',
  body: 'Signor Presidente,\nLe scrivo per proporre un dialogo diretto sulla sicurezza delle rotte.', tone: 'cordial', visibility: 'private', ...p,
});
const body = (...diplomacy: DiploAction[]): OrdersBody => ({ military: [], diplomacy, procurement: [], statements: [] });

describe('lettere: validatore', () => {
  const sc = loadScenario('med-2026');
  const v = (factionId: string, ...d: DiploAction[]) => validateOrders(sc.world, sc.catalog, factionId, body(...d));

  it('accetta una lettera corretta e rifiuta destinatari, lunghezze e numero non ammessi', () => {
    expect(v('ITA', letter()).errors).toEqual([]);
    expect(v('ITA', letter({ target: 'XYZ' })).errors.join()).toContain('sconosciuto');
    expect(v('ITA', letter({ target: 'ITA' })).errors.join()).toContain('a sé stessi');
    expect(v('ITA', letter({ target: 'NATO' })).errors.join()).toContain('capo di Stato');
    expect(v('ITA', letter({ subject: 'x'.repeat(LETTER_LIMITS.subject + 1) })).errors.join()).toContain('oggetto oltre');
    expect(v('ITA', letter({ body: 'x'.repeat(LETTER_LIMITS.body + 1) })).errors.join()).toContain('testo oltre');
    expect(v('ITA', letter({ subject: '  ' })).errors.join()).toContain('oggetto della lettera vuoto');
    expect(v('ITA', letter({ body: '' })).errors.join()).toContain('testo della lettera vuoto');
    expect(v('ITA', letter({ id: 'a' }), letter({ id: 'b', target: 'EGY' })).valid).toBe(true);
    expect(v('ITA', letter({ id: 'a' }), letter({ id: 'b' }), letter({ id: 'c' })).errors.join()).toContain('al massimo 2 lettere');
    // il tetto di 2 vale per il giocatore; le fazioni IA sono limitate da letterIntents e lettersPerTurn
    expect(v('TUR', letter({ id: 'a', target: 'ITA' }), letter({ id: 'b', target: 'GRC' }), letter({ id: 'c', target: 'EGY' })).valid).toBe(true);
  });

  it('ogni carica è una carica, non un nome: tutte le fazioni hanno leaderTitle e capital', () => {
    for (const f of Object.values(sc.world.factions)) {
      expect(f.leaderTitle, f.id).toMatch(/^Il (Presidente|Primo Ministro|Comandante|Segretario)/);
      expect(f.capital, f.id).not.toBe('');
    }
  });
});

describe('lettere: effetti deterministici del tono', () => {
  it('ogni tono sposta fiducia e tensione come da tabella; la pubblica genera anche una dichiarazione', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'toni', seed: 'toni' });
    for (const tone of Object.keys(LETTER_TONE_EFFECTS) as (keyof typeof LETTER_TONE_EFFECTS)[]) {
      const state = await e.store.getState(c.id);
      const ctx = new TurnCtx(state, c, loadScenario('med-2026'), new Rng(c.seed, c.rngCursor, 1), 0);
      const before = structuredClone(state.relations.ITA!.EGY!);
      resolveDiplomacy(ctx, 'ITA', letter({ target: 'EGY', tone }));
      const after = ctx.state.relations.ITA!.EGY!;
      const clamp = (v: number, lo: number, hi: number) => +(Math.max(lo, Math.min(hi, v))).toFixed(1);
      expect(after.trust, tone).toBe(clamp(before.trust + LETTER_TONE_EFFECTS[tone].trust, -100, 100));
      expect(after.tension, tone).toBe(clamp(before.tension + LETTER_TONE_EFFECTS[tone].tension, 0, 100));
      const sent = ctx.events.find((x) => x.type === 'LETTER_SENT')!;
      expect(sent.visibility).toEqual(['ITA', 'EGY']);
      expect((sent.payload as { letter: { fromTitle: string; place: string; source: string } }).letter).toMatchObject({ fromTitle: 'Il Presidente del Consiglio dei Ministri della Repubblica Italiana', place: 'Roma', source: 'human' });
      expect(ctx.events.some((x) => x.type === 'STATEMENT')).toBe(false);
    }
    const ctx = new TurnCtx(await e.store.getState(c.id), c, loadScenario('med-2026'), new Rng(c.seed, c.rngCursor, 1), 0);
    resolveDiplomacy(ctx, 'ITA', letter({ visibility: 'public' }));
    expect(ctx.events.find((x) => x.type === 'LETTER_SENT')!.visibility).toBe('public');
    expect(ctx.events.find((x) => x.type === 'STATEMENT')!.payload).toMatchObject({ audience: 'TUR', tone: 'cordial' });
    // conciliante e cordiale riducono la tensione, ferma e minacciosa la alzano
    expect(LETTER_TONE_EFFECTS.conciliatory.tension).toBeLessThan(0);
    expect(LETTER_TONE_EFFECTS.threatening.tension).toBeGreaterThan(LETTER_TONE_EFFECTS.firm.tension);
  });

  it('lettera minacciosa → minaccia da verificare: senza seguito costa credibilità due turni dopo', async () => {
    const e = makeEngine();
    let c = await e.createCampaign({ scenarioId: 'med-2026', name: 'minaccia', seed: 'minaccia-lettera' });
    await e.submitOrders(c.id, body(letter({ target: 'LBY_LNA', tone: 'threatening', subject: 'Avvertimento sugli impianti di Mellitah' })));
    c = (await runSim(e, c, 3)).campaign;
    const ev1 = await e.store.getEvents(c.id, 1);
    expect(ev1.some((x) => x.type === 'FACTION_CHANGED' && x.actor === 'ITA' && (x.payload as { pendingThreat?: { target: string } }).pendingThreat?.target === 'LBY_LNA')).toBe(true);
    const ev3 = await e.store.getEvents(c.id, 3);
    expect(ev3.some((x) => x.type === 'FACTION_CHANGED' && x.actor === 'ITA' && String((x.payload as { note?: string }).note).includes('LBY_LNA non mantenuta'))).toBe(true);
    // la lettera è archiviata e compare nella knowledge del destinatario (e non in quella di un terzo)
    const stored = await e.store.getLetters(c.id, 1);
    expect(stored.find((l) => l.from === 'ITA')).toMatchObject({ to: 'LBY_LNA', tone: 'threatening', source: 'human', toTitle: "Il Comandante generale dell'Esercito Nazionale Libico" });
    expect((await e.store.getKnowledge(c.id, 'LBY_LNA', 2))!.letters.some((l) => l.from === 'ITA')).toBe(true);
    expect((await e.store.getKnowledge(c.id, 'FRA', 2))!.letters.some((l) => l.from === 'ITA')).toBe(false);
  }, 30_000);
});

describe('lettere: agenti', () => {
  it('la fazione risponde nel turno dopo alla lettera del giocatore, anche in un turno «senza IA»', async () => {
    const e = makeEngine();
    // LBY_GNU è minore: con minorEvery 2 in uno dei due turni decide per dottrina, ma alle lettere del giocatore risponde sempre
    let c = await e.createCampaign({ scenarioId: 'med-2026', name: 'risposta', seed: 'risposta', config: { factionMode: 'llm',  agentCadence: { minorEvery: 2, lettersPerTurn: 0 } } });
    await e.submitOrders(c.id, body(letter({ id: 'a', target: 'LBY_GNU', subject: 'Cooperazione sulla migrazione' }), letter({ id: 'b', target: 'TUR', tone: 'firm' })));
    c = (await runSim(e, c, 1)).campaign;
    await e.submitOrders(c.id, body(letter({ id: 'a', target: 'LBY_GNU', subject: 'Cooperazione sulla migrazione' }), letter({ id: 'b', target: 'TUR', tone: 'firm' })));
    c = (await runSim(e, c, 2)).campaign;
    const sent = await e.store.getLetters(c.id, 1);
    const replies = (await e.store.getLetters(c.id, 2)).filter((l) => l.to === 'ITA');
    for (const l of sent.filter((x) => x.from === 'ITA')) expect(replies.find((r) => r.inReplyTo === l.id), `risposta di ${l.to}`).toMatchObject({ from: l.to, source: 'ai' });
    const gnu = (await e.store.getDecision(c.id, 2, 'LBY_GNU'))!;
    expect([gnu.model, (await e.store.getDecision(c.id, 1, 'LBY_GNU'))!.model]).toContain('dottrina');
    expect(gnu.letters).toMatchObject([{ kind: 'reply', to: 'ITA', source: 'ai' }]);
    // una sola risposta per fazione per turno, e nessuna iniziativa (lettersPerTurn 0)
    expect(replies.filter((r) => r.from === 'TUR')).toHaveLength(1);
    expect((await e.store.getLetters(c.id, 2)).filter((l) => l.from !== 'ITA' && !l.inReplyTo)).toHaveLength(0);
    // il giocatore vede la risposta nella sua knowledge del turno successivo
    expect((await e.store.getKnowledge(c.id, 'ITA', 3))!.letters.some((l) => l.from === 'TUR' && l.to === 'ITA')).toBe(true);
  }, 60_000);

  it('replay identico con lettere del giocatore, risposte e iniziative IA (nessuna chiamata LLM)', async () => {
    const { ReplayAgents } = await import('../src/agents/replay.js');
    const { Engine } = await import('../src/engine/turn-machine.js');
    const e = makeEngine();
    const src = await e.createCampaign({ scenarioId: 'med-2026', name: 'src', seed: 'replay-lettere' });
    const r1 = await runSim(e, src, 4, async (t) => { if (t % 2 === 1) await e.submitOrders(src.id, body(letter({ id: `x${t}`, target: t === 1 ? 'TUR' : 'EGY' }))); });
    const all = (await Promise.all([1, 2, 3, 4].map((t) => e.store.getLetters(src.id, t)))).flat();
    expect(all.filter((l) => l.inReplyTo).length).toBeGreaterThanOrEqual(2);
    expect(all.filter((l) => l.from !== 'ITA' && !l.inReplyTo).length).toBeGreaterThan(0);
    const replay = new Engine(e.store, new ReplayAgents(e.store, src.id));
    const rc = await replay.createCampaign({ scenarioId: 'med-2026', name: 'rep', seed: src.seed, config: src.config });
    const r = await runSim(replay, rc, 4, async (t) => { const o = await e.store.getOrders(src.id, t, 'ITA'); if (o) await e.store.saveOrders(rc.id, o); });
    for (let t = 1; t <= 4; t++) {
      expect(await e.store.getState(r.campaign.id, t)).toEqual(await e.store.getState(r1.campaign.id, t));
      expect((await e.store.getLetters(r.campaign.id, t)).map((l) => [l.id, l.body])).toEqual((await e.store.getLetters(src.id, t)).map((l) => [l.id, l.body]));
    }
  }, 60_000);

  it('corpo con numeri inventati → 1 repair → lettera-modello breve e cortese', async () => {
    const mock = new MockLLMProvider();
    const roles: string[] = [];
    const provider = { name: 'inventa', complete: async (r: Parameters<MockLLMProvider['complete']>[0]) => {
      roles.push(r.role === 'repair' ? `repair:${r.meta.repairOf}` : r.role);
      const res = await mock.complete(r);
      if (r.role !== 'diplomat' && r.meta.repairOf !== 'diplomat') return res;
      const d = JSON.parse(res.text);
      return { ...res, text: JSON.stringify({ ...d, body: `${d.body} Abbiamo schierato 47 navi e 312 aerei.` }) };
    } };
    const e = makeEngine(provider as never);
    let c = await e.createCampaign({ scenarioId: 'med-2026', name: 'numeri', seed: 'numeri', config: { agentCadence: { lettersPerTurn: 0 } } });
    await e.submitOrders(c.id, body(letter({ target: 'TUR' })));
    c = (await runSim(e, c, 2)).campaign;
    const reply = (await e.store.getLetters(c.id, 2)).find((l) => l.from === 'TUR' && l.to === 'ITA')!;
    expect(reply).toMatchObject({ source: 'template', model: 'template', tone: 'formal', inReplyTo: 'LT1-ITA-l1' });
    expect(reply.body).not.toMatch(/\d/);
    expect(reply.body).toMatch(/^Signor Presidente,/);
    expect(reply.subject).toBe(`Risposta: ${letter().subject}`);
    const d = (await e.store.getDecision(c.id, 2, 'TUR'))!;
    expect(d.letters[0]!.errors.join()).toContain('47');
    expect(roles.filter((x) => x === 'diplomat')).toHaveLength(1);
    expect(roles.filter((x) => x === 'repair:diplomat')).toHaveLength(1);
    const log = await import('node:fs/promises').then((fs) => fs.readFile(e.store.dir(c.id, 'llm-log', 'turn-0002.jsonl'), 'utf8'));
    expect(log).toContain('numeri non presenti nella situazione del mittente');
  }, 60_000);

  it('tetto lettersPerTurn: prima le maggiori, poi per id; le lettere messe dal modello negli ordini vengono tolte', async () => {
    const mock = new MockLLMProvider();
    const provider = { name: 'epistolare', complete: async (r: Parameters<MockLLMProvider['complete']>[0]) => {
      const res = await mock.complete(r);
      if (r.role !== 'faction_major' && r.role !== 'faction_minor') return res;
      const d = JSON.parse(res.text);
      const f = String(r.meta.factionId);
      d.letterIntents = [{ to: f === 'GRC' ? 'EGY' : 'GRC', gist: 'Proposta di dialogo.', tone: 'cordial' }, { to: 'ITA', gist: 'Saluti.', tone: 'formal' }, { to: 'EGY', gist: 'Terza.', tone: 'formal' }];
      d.orders.diplomacy.push({ id: 'z', kind: 'LETTER', target: 'ITA', subject: 'abusiva', body: 'non dovrebbe passare', tone: 'cordial', visibility: 'public' });
      return { ...res, text: JSON.stringify(d) };
    } };
    const e = makeEngine(provider as never);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'tetto', seed: 'tetto', config: { factionMode: 'llm',  agentCadence: { lettersPerTurn: 3 } } });
    await e.advance(c.id);
    const letters = await e.store.getLetters(c.id, 1);
    expect(letters.map((l) => `${l.from}>${l.to}`)).toEqual(['CHN>GRC', 'CHN>ITA', 'FRA>GRC']);
    expect(letters.some((l) => l.subject === 'abusiva')).toBe(false);
    const fra = (await e.store.getDecision(c.id, 1, 'FRA'))!;
    expect(fra.orders.diplomacy.filter((x) => x.kind === 'LETTER')).toHaveLength(1);
    expect((await e.store.getDecision(c.id, 1, 'USA'))!.letters).toEqual([]);
  }, 60_000);
});
