import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { buildServer } from '../src/index.js';
import { tmp } from './helpers.js';

describe('API', () => {
  it('ciclo completo: crea → ordini → validate → advance → CMO → AAR → turno successivo', async () => {
    const { app } = await buildServer({ dataDir: tmp(), provider: new MockLLMProvider() });
    const j = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const r = await app.inject({ method, url: `/api/wg${url}`, payload: payload as object });
      return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body };
    };
    expect((await j('GET', '/scenarios')).body[0].id).toBe('med-2026');
    const { body: c } = await j('POST', '/campaigns', { scenarioId: 'med-2026', name: 'api', seed: 'api' });
    expect(c.phase).toBe('PLAYER_ORDERS');
    expect((await j('GET', `/campaigns/${c.id}/knowledge`)).body.factionId).toBe('ITA');
    expect((await j('GET', `/campaigns/${c.id}/narrative/1`)).body.briefing.sections).toHaveLength(5);
    expect((await j('GET', `/campaigns/${c.id}/catalog`)).body.items.length).toBe(16);
    const units = (await j('GET', `/campaigns/${c.id}/layers/units.geojson`)).body;
    expect(units.features.every((f: { id: string }) => f.id.startsWith('ITA-'))).toBe(true);
    const contacts = (await j('GET', `/campaigns/${c.id}/layers/contacts.geojson`)).body;
    expect(JSON.stringify(contacts)).not.toContain('truthUnitId');
    for (const l of ['zones', 'crises', 'infrastructure', 'lanes']) expect((await j('GET', `/campaigns/${c.id}/layers/${l}.geojson`)).status).toBe(200);
    expect((await j('GET', `/campaigns/${c.id}/layers/ranges.geojson?unitId=ITA-F590`)).body.features.length).toBe(2);

    const bad = await j('POST', `/campaigns/${c.id}/orders/validate`, { military: [{ id: 'x', kind: 'PATROL', unitIds: ['RUS-GORSHKOV'], zoneId: 'EGEO', roe: 'WEAPONS_TIGHT' }] });
    expect(bad.body.valid).toBe(false);
    const orders = { military: [{ id: 's1', kind: 'STRIKE', unitIds: ['ITA-TORNADO'], targetRef: 'HORMUZ', munitions: { STORM_SHADOW: 8 }, roe: 'WEAPONS_FREE' }] };
    expect((await j('POST', `/campaigns/${c.id}/orders/validate`, orders)).body.valid).toBe(true);
    expect((await j('POST', `/campaigns/${c.id}/orders`, orders)).status).toBe(200);
    expect((await j('POST', `/campaigns/${c.id}/orders`, { military: [{ id: 'x', kind: 'STAND_DOWN', unitIds: ['NOPE'] }] })).body.error.code).toBe('INVALID_ORDERS');

    const adv = await j('POST', `/campaigns/${c.id}/advance`);
    expect(adv.body.phase).toBe('CMO_PENDING');
    const cmo = (await j('GET', `/campaigns/${c.id}/cmo`)).body;
    // lo strike del giocatore, più eventuali ingaggi nati dalle posture delle fazioni IA
    expect(cmo.length).toBeGreaterThanOrEqual(1);
    const txt = await app.inject({ method: 'GET', url: `/api/wg/campaigns/${c.id}/cmo?format=txt` });
    expect(txt.body).toContain('RISOLUZIONE SU CMO RICHIESTA');
    for (const e of cmo) expect((await j('POST', `/campaigns/${c.id}/cmo/${e.id}/aar`, { autoResolve: true })).body.status).toBe('resolved');
    const next = await j('POST', `/campaigns/${c.id}/advance`);
    expect(next.body).toMatchObject({ currentTurn: 2, phase: 'PLAYER_ORDERS' });
    expect((await j('GET', `/campaigns/${c.id}/ledger?turn=1`)).body.every((l: { factionId: string }) => l.factionId === 'ITA')).toBe(true);
    expect((await j('GET', `/campaigns/${c.id}/events?turn=1`)).body.length).toBeGreaterThan(0);
    expect((await j('GET', `/campaigns/${c.id}/narrative/1`)).body.debriefing.sections.length).toBeGreaterThan(0);

    const pm = await j('GET', `/campaigns/${c.id}/postmortem?turn=1`);
    expect(pm.status).toBe(403);
    expect(pm.body.error.code).toBe('FORBIDDEN');
    const fork = (await j('POST', `/campaigns/${c.id}/fork`, { fromTurn: 1 })).body;
    expect(fork.parent.campaignId).toBe(c.id);
    expect((await j('POST', `/campaigns/${fork.id}/advance`)).body.currentTurn).toBe(2);
    await j('POST', `/campaigns/${c.id}/end`);
    const pm2 = await j('GET', `/campaigns/${c.id}/postmortem?turn=1&faction=RUS`);
    expect(pm2.status).toBe(200);
    expect(pm2.body.decisions[0].privateIntent).toBeTruthy();
    expect(pm2.body.branches.length).toBe(2);
    expect((await j('GET', '/campaigns/nope')).status).toBe(404);
    await app.close();
  }, 30_000);
});

describe('API lettere', () => {
  it('bozza dall\'LLM → ordine LETTER → risposta nel turno dopo, visibile solo se pertinente', async () => {
    const { app } = await buildServer({ dataDir: tmp(), provider: new MockLLMProvider() });
    const j = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const r = await app.inject({ method, url: `/api/wg${url}`, payload: payload as object });
      return { status: r.statusCode, body: r.json() };
    };
    const { body: c } = await j('POST', '/campaigns', { scenarioId: 'med-2026', name: 'lettere', seed: 'api-lettere' });
    expect((await j('POST', `/campaigns/${c.id}/letters/draft`, { target: 'ITA', gist: 'x', tone: 'formal' })).status).toBe(400);
    expect((await j('POST', `/campaigns/${c.id}/letters/draft`, { target: 'TUR', gist: 'x', tone: 'rude' })).status).toBe(400);
    const before = (await j('GET', `/campaigns/${c.id}`)).body;
    const { body: draft } = await j('POST', `/campaigns/${c.id}/letters/draft`, { target: 'TUR', gist: 'Proporre un tavolo sulla sicurezza della navigazione nell\'Egeo.', tone: 'conciliatory' });
    expect(draft).toMatchObject({ target: 'TUR', tone: 'conciliatory', source: 'ai' });
    expect(draft.body.length).toBeLessThanOrEqual(1800);
    expect((await j('GET', `/campaigns/${c.id}`)).body.updatedAt).toBe(before.updatedAt); // la bozza non cambia lo stato
    const l = { id: 'l1', kind: 'LETTER', target: 'TUR', subject: draft.subject, body: `${draft.body}\nAggiunta del giocatore.`, tone: draft.tone, visibility: 'private' };
    const three = { diplomacy: [l, { ...l, id: 'l2' }, { ...l, id: 'l3' }] };
    expect((await j('POST', `/campaigns/${c.id}/orders/validate`, three)).body.errors.join()).toContain('al massimo 2 lettere');
    expect((await j('POST', `/campaigns/${c.id}/orders`, { diplomacy: [l] })).status).toBe(200);
    await j('POST', `/campaigns/${c.id}/advance`);
    await j('POST', `/campaigns/${c.id}/advance`);
    const all = (await j('GET', `/campaigns/${c.id}/letters`)).body as { from: string; to: string; turn: number; inReplyTo?: string; visibility: string; body: string }[];
    expect(all.find((x) => x.from === 'ITA')!.body).toContain('Aggiunta del giocatore.');
    expect(all.find((x) => x.from === 'TUR' && x.inReplyTo === 'LT1-ITA-l1')).toBeTruthy();
    expect(all.every((x) => x.from === 'ITA' || x.to === 'ITA' || x.visibility === 'public')).toBe(true);
    expect((await j('GET', `/campaigns/${c.id}/letters?turn=2`)).body.every((x: { turn: number }) => x.turn === 2)).toBe(true);
  }, 30_000);

  it('diplomazia (settore 09): catalogo delle azioni, dry-run dell\'accettazione in /validate, registro diplomatico nella knowledge', async () => {
    const { app } = await buildServer({ dataDir: tmp(), provider: new MockLLMProvider() });
    const j = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const r = await app.inject({ method, url: `/api/wg${url}`, payload: payload as object });
      return { status: r.statusCode, body: r.json() };
    };
    const cat = (await j('GET', '/diplomacy/catalog')).body as { kind: string; label: string; cost: number | null; costBy?: Record<string, number>; cooldown: number; coercive: boolean }[];
    expect(cat.map((x) => x.kind)).toEqual(expect.arrayContaining(['DEMARCHE', 'IMPROVE_RELATIONS', 'RECALL_AMBASSADOR', 'ULTIMATUM', 'MEDIATE', 'RESOLUTION', 'PROPOSE_AGREEMENT']));
    expect(cat.map((x) => x.kind)).not.toContain('UNSC_DRAFT');
    expect(cat.find((x) => x.kind === 'DEMARCHE')).toMatchObject({ cost: 1, cooldown: 1, coercive: false });
    expect(cat.find((x) => x.kind === 'SANCTION')).toMatchObject({ cost: 6, coercive: true });
    expect(cat.find((x) => x.kind === 'RESOLUTION')!.costBy).toMatchObject({ UNSC: 8, UNGA: 6 });
    const { body: c } = await j('POST', '/campaigns', { scenarioId: 'med-2026', name: 'diplo', seed: 'diplo' });
    const k = (await j('GET', `/campaigns/${c.id}/knowledge`)).body;
    expect(k.diplomacy.capital).toBeGreaterThan(10);
    expect(k.diplomacy).toMatchObject({ improvingSlots: 3, improving: [], ties: {}, ultimatums: [], embargoes: [] });
    const prop = (id: string, to: string) => ({ id, kind: 'PROPOSE_AGREEMENT', target: [to], agreement: { type: 'trade', parties: ['ITA', to], terms: 'prova', endTurn: null, visibility: 'public' } });
    const v = (await j('POST', `/campaigns/${c.id}/orders/validate`, { diplomacy: [prop('p1', 'POL'), prop('p2', 'EGY')] })).body;
    expect(v.valid).toBe(true);
    expect(v.capitalCost).toBe(6);
    expect(v.acceptance.map((a: { actionId: string; target: string }) => [a.actionId, a.target])).toEqual([['p1', 'POL'], ['p2', 'EGY']]);
    expect(v.acceptance[0].reasons.length).toBeGreaterThan(2);
    // senza CD: errore chiaro
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, kind: 'THREAT', target: ['TUR', 'RUS', 'EGY', 'FRA', 'GRC', 'ISR', 'IRN', 'CHN'][i], message: 'x', visibility: 'public' }));
    const bad = (await j('POST', `/campaigns/${c.id}/orders/validate`, { diplomacy: many })).body;
    expect(bad.valid).toBe(false);
    expect(bad.errors.some((e: string) => e.includes('capitale diplomatico insufficiente'))).toBe(true);
  });
});
