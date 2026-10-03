import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { acceptanceFor, countryView, diplomacyOverview, tensionBand, turnsLeft, voteViews } from '../src/engine/diplo-view.js';
import { opinionOf } from '../src/engine/opinion.js';
import { buildServer } from '../src/index.js';
import type { GameEvent, OpinionModifier, WorldState } from '../src/schemas/index.js';
import { agreement, sc, validate, trade } from './diplo-helpers.js';
import { setRelation, tmp } from './helpers.js';

const world = (mutate?: (s: WorldState) => void) => { const s = structuredClone(sc.world); s.turn = 1; mutate?.(s); return s; };
const withIntel = (s: WorldState, other = 'EGY') => { s.agreements['AG-INTEL'] = agreement('AG-INTEL', 'intel_sharing', ['ITA', other]); };
const mod = (o: Partial<OpinionModifier> & Pick<OpinionModifier, 'from' | 'to' | 'label'>): OpinionModifier => ({ id: `${o.label}:${o.from}>${o.to}`, kind: 'threat', value: -6, decayPerWeek: 1, causeRef: 'test', visibility: 'public', turn: 1, ...o });
const overview = (s: WorldState) => diplomacyOverview(s, 'ITA', { turnLength: 'week' });
const country = (s: WorldState, actor: string) => countryView(s, 'ITA', actor, 'week')!;

describe('vista diplomatica: panoramica (nebbia §5.6)', () => {
  it('l\'opinione dell\'Italia verso tutti ha il valore, quella degli altri verso l\'Italia solo la fascia', () => {
    const o = overview(world());
    const out = Object.keys(o.opinion.out);
    expect(out.length).toBeGreaterThan(190);
    expect(out).not.toContain('ITA');
    expect(Object.keys(o.opinion.in).sort()).toEqual([...out].sort());
    expect(Object.values(o.opinion.in).every((b) => Number.isInteger(b) && b >= 0 && b <= 4)).toBe(true);
    expect(o.opinion.exact).toEqual({});
    expect(o.opinion.out.EGY).toBe(opinionOf(world(), 'ITA', 'EGY').value);
    expect(o.opinion.bands).toEqual(['ostile', 'fredda', 'neutra', 'cordiale', 'stretta']);
  });

  it('il numero esatto di chi ha un accordo di intelligence con l\'Italia compare, degli altri no', () => {
    const s = world((x) => withIntel(x));
    const o = overview(s);
    expect(Object.keys(o.opinion.exact)).toEqual(['EGY']);
    expect(o.opinion.exact.EGY).toBe(opinionOf(s, 'EGY', 'ITA').value);
    // un accordo solo proposto, o tra altri, non basta
    const p = overview(world((x) => { x.agreements.A = agreement('A', 'intel_sharing', ['ITA', 'EGY'], 'proposed'); x.agreements.B = agreement('B', 'intel_sharing', ['EGY', 'TUR']); }));
    expect(p.opinion.exact).toEqual({});
  });

  it('le coppie tra terzi non cambiano né la panoramica né la scheda di un altro Stato', () => {
    const before = world();
    const after = world((s) => { setRelation(s, 'GRC', 'TUR', -90, 95); s.diplomacy!.modifiers.push(mod({ from: 'GRC', to: 'TUR', label: 'TERZI-QWE' })); });
    expect(overview(after).opinion).toEqual(overview(before).opinion);
    expect(JSON.stringify(overview(after))).not.toContain('TERZI-QWE');
    expect(country(after, 'EGY')).toEqual(country(before, 'EGY'));
    expect(JSON.stringify(country(after, 'TUR'))).not.toContain('TERZI-QWE');
  });

  it('tensione mondiale: fascia, quattro fasce con gli effetti, cause dall\'ultimo evento', () => {
    const ev = { payload: { from: 30, to: 33, causes: [{ label: 'scontri armati (1)', value: 3 }] } } as unknown as GameEvent;
    const o = diplomacyOverview(world((s) => { s.globalIndicators.worldTension = 33; }), 'ITA', { turnLength: 'month', tensionEvent: ev });
    expect(o.tension).toMatchObject({ value: 33, from: 30, causes: [{ label: 'scontri armati (1)', value: 3 }] });
    expect(o.tension.band.label).toBe('Normale');
    expect(o.tension.bands.map((b) => b.index)).toEqual([0, 1, 2, 3]);
    expect([0, 24, 25, 49, 50, 74, 75, 100].map((v) => tensionBand(v).index)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(o.capital.weeks).toBe(4);
    expect(overview(world()).tension.from).toBeNull();
  });

  it('CD, rendita, slot e ultimatum in corso con il conto alla rovescia', () => {
    const s = world((x) => {
      x.diplomacy!.ultimatums.push({ id: 'U1', from: 'ITA', to: 'EGY', demand: 'ritirare le navi', issuedTurn: 1, deadlineTurn: 3, status: 'pending' });
      x.diplomacy!.ultimatums.push({ id: 'U2', from: 'TUR', to: 'GRC', demand: 'di terzi', issuedTurn: 1, deadlineTurn: 3, status: 'pending' });
    });
    const o = overview(s);
    expect(o.ultimatums.map((u) => [u.id, u.turnsLeft])).toEqual([['U1', 2]]);
    expect(o.capital.value).toBe(Math.round(s.diplomacy!.capital.ITA! * 10) / 10);
    expect(o.capital.rent).toBeGreaterThan(0);
    expect(o.capital.improvingSlots).toBeGreaterThanOrEqual(2);
  });
});

describe('vista diplomatica: scheda paese', () => {
  it('opinione dell\'Italia con i motivi (base + modificatori con i turni che mancano)', () => {
    const s = world((x) => x.diplomacy!.modifiers.push(mod({ from: 'ITA', to: 'EGY', label: 'Minaccia formale', value: -8, decayPerWeek: 1 })));
    const c = country(s, 'EGY');
    expect(c).toMatchObject({ actor: 'EGY', iso3: 'EGY', iso2: 'EG', name: 'Egitto', isFaction: true, self: false });
    expect(c.opinion.out.value).toBe(opinionOf(s, 'ITA', 'EGY').value);
    const sum = c.opinion.out.base.reduce((n, r) => n + r.value, 0) + c.opinion.out.modifiers.reduce((n, m) => n + m.value, 0);
    expect(Math.abs(sum - c.opinion.out.value)).toBeLessThan(0.2);
    expect(c.opinion.out.modifiers).toContainEqual({ label: 'Minaccia formale', value: -8, turnsLeft: 8 });
  });

  it('i turni che mancano: scadenza, decadimento fino a zero, permanente', () => {
    expect(turnsLeft(mod({ from: 'A', to: 'B', label: 'x', value: -8, decayPerWeek: 1 }), 1, 1)).toBe(8);
    expect(turnsLeft(mod({ from: 'A', to: 'B', label: 'x', value: -8, decayPerWeek: 1 }), 1, 4)).toBe(2);
    expect(turnsLeft(mod({ from: 'A', to: 'B', label: 'x', expiresTurn: 5 }), 2, 1)).toBe(3);
    expect(turnsLeft(mod({ from: 'A', to: 'B', label: 'x', decayPerWeek: 0 }), 1, 1)).toBeNull();
    expect(turnsLeft(mod({ from: 'A', to: 'B', label: 'x', floor: 3 }), 1, 1)).toBeNull();
  });

  it('l\'opinione verso l\'Italia è una fascia; senza intelligence mai il valore, solo le etichette degli atti pubblici o rivolti all\'Italia', () => {
    const s = world((x) => x.diplomacy!.modifiers.push(
      mod({ from: 'EGY', to: 'ITA', label: 'PUBBLICO-ABC', value: -7 }),
      mod({ from: 'EGY', to: 'ITA', label: 'RISERVATO-XYZ', value: -9, visibility: ['EGY', 'TUR'] }),
      mod({ from: 'EGY', to: 'ITA', label: 'PER-NOI-DEF', value: 4, visibility: ['ITA', 'EGY'] }),
    ));
    const c = country(s, 'EGY');
    expect(c.opinion.in.exact).toBeUndefined();
    expect(c.opinion.in.known.map((k) => k.label).sort()).toEqual(['PER-NOI-DEF', 'PUBBLICO-ABC']);
    expect(Object.keys(c.opinion.in.known[0]!).sort()).toEqual(['label', 'turnsLeft']);
    const json = JSON.stringify(c);
    expect(json).not.toContain('RISERVATO-XYZ');
    expect(json).not.toContain(String(opinionOf(s, 'EGY', 'ITA').value));
  });

  it('con un accordo di intelligence la scheda dà il numero esatto e i motivi', () => {
    const s = world((x) => { withIntel(x); x.diplomacy!.modifiers.push(mod({ from: 'EGY', to: 'ITA', label: 'RISERVATO-XYZ', value: -9, visibility: ['EGY', 'TUR'] })); });
    const c = country(s, 'EGY');
    expect(c.opinion.in.exact?.value).toBe(opinionOf(s, 'EGY', 'ITA').value);
    expect(c.opinion.in.exact?.modifiers.map((m) => m.label)).toContain('RISERVATO-XYZ');
  });

  it('trattati visibili, appartenenze condivise, rapporti ridotti e miglioramenti in corso', () => {
    const s = world((x) => {
      x.agreements.T1 = agreement('T1', 'trade', ['ITA', 'EGY']);
      x.agreements.T2 = agreement('T2', 'defense', ['EGY', 'TUR']);
      x.agreements.T3 = { ...agreement('T3', 'secret', ['EGY', 'GRC']), visibility: ['EGY', 'GRC'] };
      x.diplomacy!.ties['EGY|ITA'] = 'recalled';
      x.diplomacy!.improving.push({ actor: 'ITA', target: 'EGY', since: 1 });
    });
    const c = country(s, 'EGY');
    expect(c.agreements.map((a) => [a.id, a.shared])).toEqual([['T1', true], ['T2', false]]);
    expect(c.ties).toBe('recalled');
    expect(c.improving).toEqual({ since: 1 });
    expect(c.memberships.find((m) => m.id === 'UNGA')).toMatchObject({ shared: true });
  });

  it('azioni dal catalogo con costo e ricarica; spente con il motivo', () => {
    const c = country(world(), 'EGY');
    const improve = c.actions.find((a) => a.kind === 'IMPROVE_RELATIONS')!;
    expect(improve).toMatchObject({ cost: 1, available: true, cooldownUntil: null, errors: [] });
    expect(c.actions.find((a) => a.kind === 'STOP_IMPROVE')).toMatchObject({ available: false });
    expect(c.actions.find((a) => a.kind === 'STOP_IMPROVE')!.errors[0]).toMatch(/nessun miglioramento/);
    expect(c.actions.find((a) => a.kind === 'LIFT_SANCTION')!.errors).toContain('nessuna sanzione in corso');
    expect(c.actions.find((a) => a.kind === 'SANCTION')).toMatchObject({ coercive: true, cost: 6 });
    // niente CD: tutto ciò che costa è spento e lo dice
    const poor = country(world((x) => { x.diplomacy!.capital.ITA = 0; }), 'EGY');
    expect(poor.actions.find((a) => a.kind === 'IMPROVE_RELATIONS')!.errors.join()).toMatch(/capitale diplomatico insufficiente/);
    expect(poor.actions.find((a) => a.kind === 'STOP_IMPROVE')!.available).toBe(false);
    // ricarica
    const cd = country(world((x) => { x.diplomacy!.cooldowns['ITA|DEMARCHE|EGY'] = 3; }), 'EGY');
    expect(cd.actions.find((a) => a.kind === 'DEMARCHE')).toMatchObject({ available: false, cooldownUntil: 3 });
  });

  it('blocchi e sconosciuti non sono attori; la scheda dell\'Italia è senza azioni', () => {
    const s = world();
    expect(countryView(s, 'ITA', 'NATO', 'week')).toBeNull();
    expect(countryView(s, 'ITA', 'ZZZ', 'week')).toBeNull();
    const self = country(s, 'ITA');
    expect(self).toMatchObject({ self: true, actions: [], proposals: [] });
    // gli Stati del mondo senza fazione hanno la scheda come le altre
    const w = country(s, 'KEN');
    expect(w).toMatchObject({ actor: 'KEN', isFaction: false, name: 'Kenya' });
    expect(w.actions.length).toBeGreaterThan(8);
  });
});

describe('accettazione stimata (nebbia)', () => {
  const rivals = (s: WorldState) => { for (const [a, b] of [['EGY', 'IRN'], ['ITA', 'IRN']] as const) setRelation(s, a, b, -60); };
  const dep = { type: 'defense_cooperation' as const, parties: ['ITA', 'EGY'] };

  it('senza intelligence: l\'opinione è la stima della fascia e non nomina i terzi', () => {
    const s = world(rivals);
    const real = JSON.stringify(opinionOf(s, 'EGY', 'ITA').value);
    const r = acceptanceFor(s, 'ITA', 'EGY', dep);
    const op = r.reasons.find((x) => x.label.startsWith('Opinione verso il proponente'))!;
    expect(op.label).toMatch(/^Opinione verso il proponente \(stima: (ostile|fredda|neutra|cordiale|stretta)\)$/);
    expect(r).toMatchObject({ exact: false, accept: r.score >= 0 });
    expect(Math.round(r.reasons.reduce((n, x) => n + x.value, 0) * 10) / 10).toBe(r.score);
    const common = r.reasons.find((x) => x.label.startsWith('Minaccia comune'))!;
    expect(common.label).toBe('Minaccia comune (nemici in comune)');
    expect(JSON.stringify(r)).not.toContain('IRN');
    expect(op.label).not.toContain(real);
  });

  it('con intelligence è quella esatta del motore', () => {
    const s = world((x) => { rivals(x); withIntel(x); });
    expect(acceptanceFor(s, 'ITA', 'EGY', dep)).toMatchObject({ exact: true, reasons: expect.arrayContaining([expect.objectContaining({ label: expect.stringMatching(/^Opinione verso il proponente \(-?\d+\)$/) })]) });
  });

  it('il dry-run di POST /validate dà la stessa stima, con il campo exact', () => {
    const v = validate(world(), 'ITA', [trade('p1', ['ITA', 'EGY'])]);
    expect(v.acceptance![0]).toMatchObject({ actionId: 'p1', target: 'EGY', exact: false });
    expect(v.acceptance![0]!.reasons.find((x) => x.label.startsWith('Opinione verso il proponente'))!.label).toContain('stima');
  });

  it('la scheda ha una proposta per tipo di trattato con costo e stima; un trattato già in vigore la spegne', () => {
    const c = country(world((x) => { x.agreements.T1 = agreement('T1', 'non_aggression', ['ITA', 'EGY']); }), 'EGY');
    const types = c.proposals.map((p) => p.variant);
    expect(types).toContain('non_aggression');
    expect(types).toContain('trade');
    const na = c.proposals.find((p) => p.variant === 'non_aggression')!;
    expect(na).toMatchObject({ available: false, cost: 3 });
    expect(na.errors.join()).toMatch(/già in vigore/);
    const tr = c.proposals.find((p) => p.variant === 'trade')!;
    expect(tr).toMatchObject({ available: true, cost: 3, exact: false });
    expect(tr.accept).toBe(tr.score >= 0);
    expect(tr.reasons.length).toBeGreaterThan(2);
  });
});

describe('votazioni pubbliche (vista compatta)', () => {
  const ev = (o: Partial<GameEvent> & { payload: Record<string, unknown> }): GameEvent => ({ id: 'E1', turn: 2, seq: 1, phase: 'ADJUDICATION', type: 'INSTITUTION_VOTE', actor: 'ITA', targets: [], visibility: 'public', causedBy: null, ...o });
  it('esito per Stato in ISO3, data del turno, solo gli eventi pubblici', () => {
    const p = { forum: 'UNGA', institutionId: 'UNGA', subject: 'Condanna', topic: 'aggression', proposer: 'ITA', target: null, passed: true, rule: 'maggioranza', vetoes: [], yes: ['FRA', 'DEU'], no: ['RUS'], abstain: ['CHN'] };
    const v = voteViews([ev({ payload: p }), ev({ id: 'E2', visibility: ['ITA'], payload: p }), ev({ id: 'E3', type: 'WORLD_TENSION_CHANGED', payload: {} })], (t) => `2026-01-0${t}`);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ id: 'E1', turn: 2, date: '2026-01-02', forum: 'UNGA', passed: true, target: null, yes: ['FRA', 'DEU'], no: ['RUS'], abstain: ['CHN'] });
  });
});

describe('API diplomatiche', () => {
  it('overview, scheda paese e voti per HTTP: nebbia, 404 e forma compatta', async () => {
    const { app } = await buildServer({ dataDir: tmp(), provider: new MockLLMProvider() });
    const j = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const r = await app.inject({ method, url: `/api/wg${url}`, payload: payload as object });
      return { status: r.statusCode, body: r.json(), size: r.body.length };
    };
    const c = (await j('POST', '/campaigns', { scenarioId: 'med-2026', name: 'diplo-api', seed: 'diplo-api' })).body;
    const ov = await j('GET', `/campaigns/${c.id}/diplomacy/overview`);
    expect(ov.status).toBe(200);
    expect(ov.size).toBeLessThan(25_000);
    expect(ov.body.opinion.exact).toEqual({});
    expect(ov.body.capital.value).toBeGreaterThan(0);
    expect(ov.body.tension.band.label).toBeTruthy();

    const eg = (await j('GET', `/campaigns/${c.id}/diplomacy/country/EGY`)).body;
    expect(eg.opinion.in.exact).toBeUndefined();
    expect(eg.actions.length).toBeGreaterThan(8);
    expect((await j('GET', `/campaigns/${c.id}/diplomacy/country/egy`)).body.actor).toBe('EGY');
    // un ISO3 che ha una fazione si risolve nella fazione
    expect((await j('GET', `/campaigns/${c.id}/diplomacy/country/DZA`)).body.actor).toBe('ALG');
    expect((await j('GET', `/campaigns/${c.id}/diplomacy/country/NATO`)).status).toBe(404);
    expect((await j('GET', `/campaigns/${c.id}/diplomacy/country/ZZZ`)).status).toBe(404);

    expect((await j('GET', `/campaigns/${c.id}/institutions/votes`)).body).toEqual([]);
    expect((await j('GET', `/campaigns/${c.id}/institutions/votes?turn=abc`)).body).toEqual([]);

    // una risoluzione dell'Italia all'Assemblea generale: il voto compare, compatto, dal turno dopo
    const o = { diplomacy: [{ id: 'r1', kind: 'RESOLUTION', forum: 'UNGA', subject: 'Appello umanitario nel Mediterraneo', topic: 'humanitarian' }] };
    expect((await j('POST', `/campaigns/${c.id}/orders`, o)).status).toBe(200);
    expect((await j('POST', `/campaigns/${c.id}/advance`)).status).toBe(200);
    const votes = (await j('GET', `/campaigns/${c.id}/institutions/votes`)).body;
    expect(votes).toHaveLength(1);
    expect(votes[0]).toMatchObject({ forum: 'UNGA', proposer: 'ITA', turn: 1 });
    expect(votes[0].yes.length + votes[0].no.length + votes[0].abstain.length).toBeGreaterThan(150);
    expect((await j('GET', `/campaigns/${c.id}/institutions/votes?turn=1`)).body).toHaveLength(1);
    expect((await j('GET', `/campaigns/${c.id}/institutions/votes?turn=2`)).body).toEqual([]);
    expect(votes[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // il CD dopo la spesa (6) e la rendita del turno
    const after = (await j('GET', `/campaigns/${c.id}/diplomacy/overview`)).body;
    expect(after.turn).toBe(2);
    expect(after.tension.causes.length).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
