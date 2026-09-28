import { describe, expect, it } from 'vitest';
import type { DiploAction, LetterAction, OrdersBody } from '../src/schemas/index.js';
import { LETTER_LIMITS } from '../src/schemas/index.js';
import { TurnCtx } from '../src/engine/context.js';
import { LETTER_TONE_EFFECTS, resolveDiplomacy } from '../src/engine/diplomacy.js';
import { Rng } from '../src/engine/rng.js';
import { loadScenario } from '../src/engine/scenario.js';
import { validateOrders } from '../src/engine/validators.js';
import { runSim } from '../src/cli/sim.js';
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
