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
    expect(cmo).toHaveLength(1);
    const txt = await app.inject({ method: 'GET', url: `/api/wg/campaigns/${c.id}/cmo?format=txt` });
    expect(txt.body).toContain('RISOLUZIONE SU CMO RICHIESTA');
    expect((await j('POST', `/campaigns/${c.id}/cmo/${cmo[0].id}/aar`, { autoResolve: true })).body.status).toBe('resolved');
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
