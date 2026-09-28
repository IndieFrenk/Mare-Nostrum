import { describe, expect, it } from 'vitest';
import type { FactionKnowledge, GameEvent, WorldState } from '../src/schemas/index.js';
import { buildKnowledge, incidentsFrom } from '../src/engine/knowledge.js';
import { decideByRules } from '../src/engine/policy.js';
import { Rng } from '../src/engine/rng.js';
import { loadScenario } from '../src/engine/scenario.js';

const sc = loadScenario('med-2026');
const geo = { zones: sc.world.zones, bases: sc.world.bases, infrastructure: sc.world.infrastructure };
const names = Object.fromEntries(Object.values(sc.world.factions).map((f) => [f.id, f.name]));

let seq = 0;
/** evento del turno 1 (il turno precedente della conoscenza al turno 2) */
const ev = (type: GameEvent['type'], actor: string, payload: Record<string, unknown>, visibility: GameEvent['visibility'] = 'public'): GameEvent =>
  ({ id: `E1-${seq}`, turn: 1, seq: seq++, phase: 'ADJUDICATION', type, actor, targets: [], payload, visibility, causedBy: null });
const rel = (a: string, b: string, note: string, visibility: GameEvent['visibility'] = 'public') => ev('RELATION_CHANGED', a, { a, b, trust: -5, tension: 5, note }, visibility);

/** Conoscenza di una fazione al turno 2, dallo stato iniziale dello scenario (modificabile) e dagli eventi del turno 1. */
function knowledgeOf(f: string, o: { events?: GameEvent[]; mutate?: (s: WorldState) => void } = {}): FactionKnowledge {
  const s = structuredClone(sc.world);
  s.turn = 2;
  o.mutate?.(s);
  return buildKnowledge(s, f, [], { inbox: [], news: [], prevEvents: o.events ?? [] });
}
const decide = (k: FactionKnowledge, seed = 'policy') => decideByRules({ knowledge: k, geo, rng: new Rng(seed, 0, 2), names });
/** prima semente per cui il tiro della risposta di forza riesce (o fallisce) */
const seedWhere = (k: FactionKnowledge, pred: (d: ReturnType<typeof decide>) => boolean) => {
  for (let n = 0; n < 50; n++) if (pred(decide(k, `s${n}`))) return `s${n}`;
  throw new Error('nessuna semente adatta');
};

describe('profilo policy dello scenario', () => {
  it('ogni fazione non giocata dall\'umano (tranne i blocchi) ha un profilo con zone esistenti', () => {
    const agents = Object.values(sc.world.factions).filter((f) => f.controller !== 'human' && f.kind !== 'bloc');
    expect(agents.length).toBeGreaterThanOrEqual(14);
    for (const f of agents) {
      expect(f.policy, f.id).toBeDefined();
      for (const z of Object.keys(f.policy!.zoneInterests)) expect(sc.world.zones[z], `${f.id}: zona ${z}`).toBeDefined();
    }
    // il giocatore e i blocchi non decidono con le regole
    expect(sc.world.factions.ITA!.policy).toBeUndefined();
    expect(sc.world.factions.NATO!.policy).toBeUndefined();
  });
});

describe('incidenti nella conoscenza', () => {
  it('dalle note delle relazioni: minaccia, blocco con zona, scontro per entrambe le parti; niente propagazioni né cose non visibili', () => {
    const events = [
      rel('TUR', 'GRC', 'minaccia: Rispettate le nostre acque'), rel('TUR', 'GRC', 'BLOCKADE in EGEO'),
      rel('USA', 'IRN', 'scontro in MAR_ROSSO'), rel('TUR', 'FRA', 'propagazione: minaccia: Rispettate le nostre acque'),
      rel('RUS', 'ISR', 'lettera (threatening): Avvertimento', ['RUS', 'ISR']),
    ];
    expect(incidentsFrom(events, 'GRC').filter((x) => x.to === 'GRC')).toEqual([
      { turn: 1, kind: 'threat', from: 'TUR', to: 'GRC' }, { turn: 1, kind: 'blockade', from: 'TUR', to: 'GRC', zoneId: 'EGEO' },
    ]);
    const irn = incidentsFrom(events, 'IRN');
    expect(irn.filter((x) => x.kind === 'engagement').map((x) => `${x.from}>${x.to}`)).toEqual(['USA>IRN', 'IRN>USA']);
    expect(irn.some((x) => x.to === 'FRA')).toBe(false);
    // la lettera minacciosa riservata la vedono solo mittente e destinatario
    expect(incidentsFrom(events, 'ISR').some((x) => x.from === 'RUS' && x.kind === 'threat')).toBe(true);
    expect(incidentsFrom(events, 'GRC').some((x) => x.from === 'RUS')).toBe(false);
  });
});

describe('decisore a regole', () => {
  it('minaccia ricevuta → risposta proporzionata e lettera ferma (profilo prudente: démarche)', () => {
    const k = knowledgeOf('GRC', { events: [rel('TUR', 'GRC', 'minaccia: Rispettate le nostre acque')] });
    const d = decide(k);
    expect(d.orders.diplomacy).toContainEqual(expect.objectContaining({ kind: 'DEMARCHE', target: 'TUR' }));
    expect(d.letterIntents).toContainEqual(expect.objectContaining({ to: 'TUR', tone: 'firm' }));
    expect(d.threats).toContainEqual(expect.objectContaining({ factionId: 'TUR', level: 3 }));
    expect(d.rationale).toContainEqual({ rule: 'threat', text: 'Risposta alla minaccia di TUR: démarche' });
  });

  it('atto ostile con una zona → il profilo aggressivo risponde con una dimostrazione di forza (o, se il tiro fallisce, con la diplomazia)', () => {
    const k = knowledgeOf('IRN', { events: [rel('USA', 'IRN', 'BLOCKADE in GOLFO')] });
    const force = decide(k, seedWhere(k, (d) => d.zoneStances.some((z) => z.zoneId === 'GOLFO' && z.stance === 'show_of_force')));
    expect(force.zoneStances).toContainEqual({ zoneId: 'GOLFO', stance: 'show_of_force', intensity: 2 });
    expect(force.rationale).toContainEqual({ rule: 'threat', text: 'Risposta al blocco navale di USA in GOLFO: dimostrazione di forza' });
    const calm = decide(k, seedWhere(k, (d) => !d.zoneStances.some((z) => z.zoneId === 'GOLFO' && z.stance === 'show_of_force')));
    expect(calm.orders.diplomacy.some((x) => 'target' in x && x.target === 'USA')).toBe(true);
    for (const d of [force, calm]) expect(d.letterIntents).toContainEqual(expect.objectContaining({ to: 'USA', tone: 'firm' }));
  });

  it('linea rossa superata → la risposta del profilo nella zona della condizione («Mobilitazione navale» → show_of_force 3)', () => {
    const k = knowledgeOf('TUR', { events: [ev('RED_LINE_CROSSED', 'TUR', { redLineId: 'RL-TUR-EGEO', text: 'Blocco greco nell\'Egeo', response: 'Mobilitazione navale' }, ['TUR'])] });
    const d = decide(k);
    expect(d.zoneStances[0]).toEqual({ zoneId: 'EGEO', stance: 'show_of_force', intensity: 3 });
    expect(d.letterIntents[0]).toMatchObject({ to: 'GRC', tone: 'firm' });
    expect(d.rationale.find((r) => r.rule === 'red_line')?.text).toBe('Linea rossa «Blocco greco nell\'Egeo» superata (Mobilitazione navale): dimostrazione di forza in EGEO (intensità 3)');
    // «Strike preventivo» di Israele sulla crisi del Mar Rosso: dimostrazione di forza nel Mar Rosso, niente strike
    const isr = decide(knowledgeOf('ISR', { events: [ev('RED_LINE_CROSSED', 'ISR', { redLineId: 'RL-ISR-IRN' }, ['ISR'])] }));
    expect(isr.zoneStances[0]).toEqual({ zoneId: 'MAR_ROSSO', stance: 'show_of_force', intensity: 3 });
    expect(isr.orders.military.some((o) => o.kind === 'STRIKE')).toBe(false);
  });

  it('crisi nella zona d\'interesse → postura con intensità da escalation × interesse', () => {
    const k = knowledgeOf('GRC', { mutate: (s) => { s.crises.EAST_MED!.escalation = 5; s.crises.EAST_MED!.status = 'active'; } });
    const d = decide(k);
    expect(d.zoneStances).toContainEqual({ zoneId: 'EGEO', stance: 'presence', intensity: 2 });
    expect(d.rationale).toContainEqual({ rule: 'crisis', text: 'Crisi EAST_MED a 5/10 in EGEO (interesse 1): presenza, intensità 2' });
    // più alta l'escalation, più forze; sopra soglia un profilo aggressivo coinvolto (TUR) passa alla dimostrazione di forza
    const hot = decide(knowledgeOf('TUR', { mutate: (s) => { s.crises.EAST_MED!.escalation = 9; s.crises.EAST_MED!.status = 'active'; } }));
    expect(hot.zoneStances).toContainEqual({ zoneId: 'EGEO', stance: 'show_of_force', intensity: 3 });
    expect(hot.rationale).toContainEqual({ rule: 'crisis', text: 'Crisi EAST_MED a 9/10 in EGEO (interesse 1): dimostrazione di forza, intensità 3' });
  });

  it('sopra la soglia i profili poco aggressivi scelgono la distensione invece di più forze', () => {
    const at = (esc: number) => decide(knowledgeOf('EGY', { mutate: (s) => { s.crises.RED_SEA!.escalation = esc; } }));
    const d = at(7);
    expect(d.zoneStances).toContainEqual({ zoneId: 'MAR_ROSSO', stance: 'patrol', intensity: 1 });
    // la parte coinvolta con più tensione verso l'Egitto è l'Iran (fiducia negativa → canale riservato)
    expect(d.orders.diplomacy).toContainEqual(expect.objectContaining({ kind: 'BACKCHANNEL', target: 'IRN' }));
    expect(d.letterIntents).toContainEqual(expect.objectContaining({ to: 'IRN', tone: 'conciliatory' }));
    expect(at(8).orders.diplomacy).toContainEqual(expect.objectContaining({ kind: 'PROPOSE_AGREEMENT', target: ['IRN'] }));
    // a escalation più bassa niente distensione: presenza
    expect(at(5).zoneStances).toContainEqual({ zoneId: 'MAR_ROSSO', stance: 'presence', intensity: 2 });
  });

  it('sceglie solo posture che le proprie unità possono eseguire: senza navi adatte ripiega sul pattugliamento', () => {
    // l'Iran senza motovedette: nel Mar Rosso restano i lanciatori di droni, buoni solo per pattugliare
    const k = knowledgeOf('IRN', { mutate: (s) => { s.units['IRN-FAC']!.status = 'destroyed'; s.crises.RED_SEA!.escalation = 7; } });
    const d = decide(k);
    expect(d.zoneStances).toContainEqual({ zoneId: 'MAR_ROSSO', stance: 'patrol', intensity: 3 });
    expect(d.rationale).toContainEqual({ rule: 'crisis', text: 'Crisi RED_SEA a 7/10 in MAR_ROSSO (interesse 1): dimostrazione di forza, intensità 3 (pattugliamento: nessuna unità adatta a dimostrazione di forza)' });
    // senza nessuna unità adatta la zona non si sceglie affatto
    const none = decide(knowledgeOf('IRN', { mutate: (s) => { s.units['IRN-FAC']!.status = 'destroyed'; s.units['IRN-DRONES']!.status = 'destroyed'; } }));
    expect(none.zoneStances).toEqual([]);
  });

  it('ritiro dalle zone dove la fazione ha forze ma nessuna regola le chiede più', () => {
    const k = knowledgeOf('GRC', {
      mutate: (s) => { const u = s.units['GRC-MEKO1']!; Object.assign(u, { status: 'deployed', zoneId: 'ADRIATICO', currentTask: { id: 'x', kind: 'PATROL', unitIds: [u.id], zoneId: 'ADRIATICO', roe: 'WEAPONS_TIGHT' } }); },
    });
    const d = decide(k);
    expect(d.zoneStances).toContainEqual({ zoneId: 'ADRIATICO', stance: 'withdraw', intensity: 1 });
    expect(d.rationale).toContainEqual({ rule: 'withdraw', text: 'Ritiro da ADRIATICO: nessuna crisi, obiettivo o minaccia che chieda di restarci' });
    // la fregata già nell'Egeo resta: lì c'è ancora una ragione
    expect(d.zoneStances.some((z) => z.zoneId === 'EGEO' && z.stance === 'withdraw')).toBe(false);
  });

  it('alleati sotto pressione: sostegno da chi ha interesse nella zona o, per atti senza zona, solo dagli alleati stretti', () => {
    const events = [rel('RUS', 'GRC', 'BLOCKADE in MEDITERRANEO_ORIENTALE'), rel('RUS', 'FRA', 'sanzioni: energia')];
    // blocco russo contro la Grecia nel Mediterraneo orientale: la Francia (interesse 0,5 lì) scorta il traffico se ha posto
    // tra le posture, altrimenti rassicura la Grecia
    const fra = decide(knowledgeOf('FRA', { events: [events[0]!], mutate: (s) => { s.factions.FRA!.policy!.maxStancesPerTurn = 4; } }));
    expect(fra.rationale).toContainEqual({ rule: 'ally', text: 'Sostegno a GRC dopo il blocco navale di RUS in MEDITERRANEO_ORIENTALE: scorta al traffico' });
    expect(fra.zoneStances).toContainEqual({ zoneId: 'MEDITERRANEO_ORIENTALE', stance: 'escort_shipping', intensity: 1 });
    // con il tetto di 3 posture già pieno (crisi e obiettivi) la scorta non entra: rassicurazione
    const busy = decide(knowledgeOf('FRA', { events: [events[0]!] }));
    expect(busy.rationale).toContainEqual({ rule: 'ally', text: 'Sostegno a GRC dopo il blocco navale di RUS: rassicurazione' });
    expect(busy.orders.diplomacy).toContainEqual(expect.objectContaining({ kind: 'REASSURANCE', target: 'GRC' }));
    // sanzioni russe alla Francia: la Germania (fiducia 60) la rassicura, la Spagna (fiducia 50, solo NATO/UE) no
    const sanction = [events[1]!];
    expect(decide(knowledgeOf('DEU', { events: sanction })).orders.diplomacy).toContainEqual(expect.objectContaining({ kind: 'REASSURANCE', target: 'FRA' }));
    expect(decide(knowledgeOf('ESP', { events: sanction })).rationale.some((r) => r.rule === 'ally')).toBe(false);
  });

  it('mai operazioni cyber verso alleati, anche ostili; sì verso gli avversari', () => {
    const k = knowledgeOf('GRC', {
      mutate: (s) => {
        const grc = s.factions.GRC!;
        grc.policy = { ...grc.policy!, cyberPropensity: 1 }; grc.cyber.offense = 10;
        // la Turchia è alleata NATO (accordo di difesa) anche con fiducia pessima
        s.relations.GRC!.TUR = { ...s.relations.GRC!.TUR!, trust: -90, tension: 95 };
      },
    });
    for (let n = 0; n < 20; n++) expect(decide(k, `c${n}`).orders.military.filter((o) => o.kind === 'CYBER_OP')).toEqual([]);
    const withEnemy = knowledgeOf('GRC', {
      mutate: (s) => {
        const grc = s.factions.GRC!;
        grc.policy = { ...grc.policy!, cyberPropensity: 1 }; grc.cyber.offense = 10;
        s.relations.GRC!.TUR = { ...s.relations.GRC!.TUR!, trust: -90, tension: 95 };
        s.relations.GRC!.RUS = { ...s.relations.GRC!.RUS!, trust: -60, tension: 70 };
      },
    });
    const d = decide(withEnemy);
    expect(d.orders.military).toEqual([{ id: '', kind: 'CYBER_OP', target: 'RUS', targetRef: 'reti governative', effect: 'espionage' }]);
    expect(d.rationale).toContainEqual({ rule: 'cyber', text: 'Operazione cyber (espionage) contro RUS: avversario, fiducia -60, tensione 70' });
  });

  it('nebbia di guerra: la fazione non reagisce a ciò che non conosce', () => {
    // lettera minacciosa riservata di RUS a ISR: la Grecia non la vede, Israele sì
    const events = [rel('RUS', 'ISR', 'lettera (threatening): Avvertimento', ['RUS', 'ISR'])];
    const grc = decide(knowledgeOf('GRC', { events }));
    expect(grc.threats).toEqual([]);
    expect(grc.letterIntents.some((l) => l.to === 'RUS')).toBe(false);
    expect(decide(knowledgeOf('ISR', { events })).threats).toContainEqual(expect.objectContaining({ factionId: 'RUS' }));
    // crisi latente che non la coinvolge: la Tunisia non la conosce e non ci manda nessuno
    const tun = knowledgeOf('TUN', { mutate: (s) => { s.crises.SUBSEA!.escalation = 3; } });
    expect(tun.knownCrises.some((c) => c.id === 'SUBSEA')).toBe(false);
    expect(decide(tun).rationale.some((r) => r.text.includes('SUBSEA'))).toBe(false);
  });

  it('determinismo: stessa semente → stesse decisioni e stessi tiri registrati', () => {
    const k = knowledgeOf('RUS', { events: [rel('USA', 'RUS', 'sanzioni: energia'), rel('USA', 'RUS', 'dimostrazione di forza in MEDITERRANEO_ORIENTALE')], mutate: (s) => { s.crises.EAST_MED!.escalation = 6; } });
    const run = (seed: string) => { const rng = new Rng(seed, 0, 2); return { d: decideByRules({ knowledge: structuredClone(k), geo, rng, names }), rolls: rng.rolls }; };
    const [a, b] = [run('x'), run('x')];
    expect(a).toEqual(b);
    expect(a.rolls.length).toBeGreaterThan(0);
    expect(a.rolls.every((r) => r.purpose.startsWith('regole RUS'))).toBe(true);
    // ogni decisione ha una motivazione per ogni scelta
    expect(a.d.rationale.length).toBeGreaterThanOrEqual(a.d.zoneStances.length);
  });
});
