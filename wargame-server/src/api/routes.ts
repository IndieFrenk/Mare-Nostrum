import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import { AfterActionReport, OrdersBody } from '../schemas/index.js';
import { cmoText } from '../engine/cmo.js';
import { listScenarios, loadScenario } from '../engine/scenario.js';
import { GameError, type Engine } from '../engine/turn-machine.js';
import { LockError } from '../store/json-store.js';
import { layer } from './layers.js';

const STATUS: Record<string, number> = { NOT_FOUND: 404, WRONG_PHASE: 409, INVALID_ORDERS: 422, CAMPAIGN_LOCKED: 423, FORBIDDEN: 403, BAD_TURN: 400, CAMPAIGN_ENDED: 409, VALIDATION: 400 };

export function registerRoutes(app: FastifyInstance, engine: Engine) {
  const store = engine.store;
  const bus = new EventEmitter().setMaxListeners(100);
  engine.onProgress = (id, msg) => bus.emit(id, msg);

  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { code?: string; details?: unknown };
    const code = err instanceof ZodError ? 'VALIDATION' : err instanceof LockError ? 'CAMPAIGN_LOCKED' : e.code ?? 'INTERNAL';
    const details = err instanceof ZodError ? err.issues : e.details;
    reply.status(STATUS[code] ?? (err instanceof GameError ? 400 : 500)).send({ error: { code, message: e.message, details } });
  });

  const P = '/api/wg';
  const player = async (id: string) => (await store.getCampaign(id)).playerFaction;
  const godAllowed = async (id: string) => {
    const c = await store.getCampaign(id);
    if (c.status !== 'ended' && !c.config.debugGodView) throw new GameError('FORBIDDEN', 'post-mortem disponibile solo a campagna conclusa o in debug');
    return c;
  };
  type Id = { Params: { id: string } };

  app.get(`${P}/scenarios`, async () => listScenarios());
  app.get(`${P}/campaigns`, async () => store.listCampaigns());
  app.post<{ Body: unknown }>(`${P}/campaigns`, async (req) => {
    const b = z.object({ scenarioId: z.string().default('med-2026'), name: z.string().min(1), seed: z.string().optional(), turnLength: z.enum(['week', 'month']).optional(), debugGodView: z.boolean().optional(), cmoOnRequest: z.boolean().optional() }).parse(req.body);
    return engine.createCampaign({ ...b, config: { debugGodView: b.debugGodView ?? false, cmoOnRequest: b.cmoOnRequest ?? false } });
  });
  app.get<Id>(`${P}/campaigns/:id`, async (req) => store.getCampaign(req.params.id));
  app.post<Id & { Body: unknown }>(`${P}/campaigns/:id/fork`, async (req) => engine.fork(req.params.id, z.object({ fromTurn: z.number().int() }).parse(req.body).fromTurn));
  app.post<Id>(`${P}/campaigns/:id/end`, async (req) => engine.end(req.params.id));
  app.get<Id>(`${P}/campaigns/:id/knowledge`, async (req) => engine.knowledge(req.params.id));
  app.get<Id>(`${P}/campaigns/:id/overview`, async (req) => {
    const c = await store.getCampaign(req.params.id); const s = await store.getState(c.id); const me = c.playerFaction;
    return {
      campaign: c, indicators: s.globalIndicators, relations: s.relations[me],
      pendingDeliveries: s.pendingDeliveries.filter((d) => d.factionId === me),
      pendingCmo: Object.values(s.engagements).filter((e) => e.status === 'pending_cmo').map((e) => e.id),
      infrastructure: Object.values(s.infrastructure).map((i) => ({ id: i.id, name: i.name, type: i.type, status: i.status, flowShareIta: i.flowShareIta })),
    };
  });
  app.get<Id & { Params: { turn: string } }>(`${P}/campaigns/:id/narrative/:turn`, async (req) => {
    const c = await store.getCampaign(req.params.id);
    const t = Number(req.params.turn);
    if (t > c.currentTurn) throw new GameError('NOT_FOUND', 'turno futuro');
    return (await store.getNarrative(c.id, t)) ?? { turn: t, briefing: null, news: [] };
  });
  app.get<Id & { Querystring: { turn?: string } }>(`${P}/campaigns/:id/ledger`, async (req) => {
    const me = await player(req.params.id);
    return (await store.getLedger(req.params.id)).filter((l) => l.factionId === me && (req.query.turn === undefined || l.turn === Number(req.query.turn)));
  });
  app.get<Id>(`${P}/campaigns/:id/catalog`, async (req) => {
    const c = await store.getCampaign(req.params.id); const s = await store.getState(c.id);
    const budget = s.factions[c.playerFaction].budget.discretionary;
    return { budget, items: loadScenario(c.scenarioId).catalog.items.map((i) => ({ ...i, available: i.leadTimeTurns !== null && i.cost <= budget })), bases: Object.values(s.bases).filter((b) => b.factionId === c.playerFaction).map((b) => ({ id: b.id, name: b.name })), deliveries: s.pendingDeliveries.filter((d) => d.factionId === c.playerFaction) };
  });
  app.post<Id & { Body: { text: string } }>(`${P}/campaigns/:id/orders/parse`, async (req) => engine.parseOrders(req.params.id, z.object({ text: z.string().min(1) }).parse(req.body).text));
  app.post<Id & { Body: unknown }>(`${P}/campaigns/:id/orders/validate`, async (req) => engine.validate(req.params.id, OrdersBody.parse(req.body)));
  app.post<Id & { Body: unknown }>(`${P}/campaigns/:id/orders`, async (req) => engine.submitOrders(req.params.id, OrdersBody.parse(req.body)));
  app.post<Id>(`${P}/campaigns/:id/advance`, async (req) => {
    try { return await engine.advance(req.params.id); } catch (e) { bus.emit(req.params.id, { error: (e as Error).message }); throw e; }
  });
  app.post<Id & { Body: unknown }>(`${P}/campaigns/:id/config`, async (req) => engine.configure(req.params.id, z.object({
    turnLength: z.enum(['week', 'month']).optional(), cmoOnRequest: z.boolean().optional(), debugGodView: z.boolean().optional(),
    maxConcurrentAgents: z.number().int().min(1).max(16).optional(),
    llm: z.record(z.string(), z.object({ model: z.string().optional(), temperature: z.number().optional(), maxTokens: z.number().optional(), timeoutMs: z.number().optional() })).optional(),
  }).parse(req.body)));
  app.get<Id & { Querystring: { format?: string; engagementId?: string } }>(`${P}/campaigns/:id/cmo`, async (req, reply) => {
    const s = await store.getState(req.params.id);
    const pending = Object.values(s.engagements).filter((e) => e.status === 'pending_cmo').map((e) => ({ id: e.id, turn: e.turn, zoneId: e.zoneId, scale: e.scale, cmoPackage: e.cmoPackage! }));
    if (req.query.format === 'txt' || req.query.format === 'json') {
      const e = pending.find((p) => p.id === req.query.engagementId) ?? pending[0];
      if (!e) throw new GameError('NOT_FOUND', 'nessun ingaggio in attesa');
      const json = req.query.format === 'json';
      return reply.header('content-type', json ? 'application/json' : 'text/plain; charset=utf-8').header('content-disposition', `attachment; filename="${e.id}.${req.query.format}"`).send(json ? JSON.stringify(e.cmoPackage, null, 2) : cmoText(e.cmoPackage));
    }
    return pending;
  });
  app.post<Id & { Params: { engagementId: string }; Body: unknown }>(`${P}/campaigns/:id/cmo/:engagementId/aar`, async (req) => {
    const b = req.body as { autoResolve?: boolean };
    return engine.submitAar(req.params.id, req.params.engagementId, b?.autoResolve ? { autoResolve: true } : AfterActionReport.parse(req.body));
  });
  app.get<Id & { Querystring: { turn?: string } }>(`${P}/campaigns/:id/events`, async (req) => {
    const c = await store.getCampaign(req.params.id);
    const t = req.query.turn === undefined ? c.currentTurn : Number(req.query.turn);
    if (t > c.currentTurn) return [];
    return (await store.getEvents(c.id, t)).filter((e) => e.visibility === 'public' || e.visibility.includes(c.playerFaction) || e.actor === c.playerFaction);
  });
  app.get<Id & { Params: { layer: string }; Querystring: { unitId?: string } }>(`${P}/campaigns/:id/layers/:layer`, async (req, reply) => {
    const c = await store.getCampaign(req.params.id);
    const fc = layer(req.params.layer.replace(/\.geojson$/, ''), await store.getState(c.id), await engine.knowledge(c.id), loadScenario(c.scenarioId), req.query.unitId);
    return reply.header('content-type', 'application/geo+json').send(fc);
  });
  app.get<Id>(`${P}/campaigns/:id/stream`, (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': String(req.headers.origin ?? '*') });
    const send = (m: unknown) => reply.raw.write(`data: ${JSON.stringify(m)}\n\n`);
    send({ hello: req.params.id });
    bus.on(req.params.id, send);
    req.raw.on('close', () => bus.off(req.params.id, send));
  });
  app.get<Id & { Querystring: { turn?: string; faction?: string } }>(`${P}/campaigns/:id/postmortem`, async (req) => {
    const c = await godAllowed(req.params.id);
    const t = Number(req.query.turn ?? c.currentTurn);
    const factions = req.query.faction ? [req.query.faction] : Object.keys((await store.getState(c.id)).factions);
    const decisions = (await Promise.all(factions.map((f) => store.getDecision(c.id, t, f)))).filter(Boolean);
    const tree = (await store.listCampaigns()).filter((x) => x.id === c.id || x.parent?.campaignId === c.id || c.parent?.campaignId === x.id);
    return { turn: t, decisions, rolls: await store.getRolls(c.id, t), events: await store.getEvents(c.id, t), state: await store.getState(c.id, t).catch(() => store.getState(c.id)), branches: tree };
  });
}
