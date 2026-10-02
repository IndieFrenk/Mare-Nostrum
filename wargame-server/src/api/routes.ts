import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import { AfterActionReport, LETTER_LIMITS, LetterTone, OrdersBody } from '../schemas/index.js';
import { letterVisibleTo } from '../engine/knowledge.js';
import { cmoText } from '../engine/cmo.js';
import { diploCatalogView } from '../engine/diplo-actions.js';
import { listScenarios, loadScenario } from '../engine/scenario.js';
import { worldData } from '../engine/world-data.js';
import { factionModeOf, GameError, type Engine } from '../engine/turn-machine.js';
import { LockError } from '../store/json-store.js';
import { layer } from './layers.js';
import { mockStatus, type LlmStatusSource } from '../agents/llm-status.js';
import { factionModeDefault, llmDefaults, RULES_FREE_ROLES } from '../config.js';

const STATUS: Record<string, number> = { NOT_FOUND: 404, WRONG_PHASE: 409, INVALID_ORDERS: 422, CAMPAIGN_LOCKED: 423, FORBIDDEN: 403, BAD_TURN: 400, CAMPAIGN_ENDED: 409, VALIDATION: 400, LLM_UNREACHABLE: 503 };

export function registerRoutes(app: FastifyInstance, engine: Engine, llm: LlmStatusSource = mockStatus()) {
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

  /**
   * Modello per ruolo: quelli della campagna (cambiano in corsa con /config) o i predefiniti del server. In modalità `rules` solo
   * i ruoli che usano ancora l'LLM (lettere, notizie, briefing, intel, Console Ordini, repair): decisioni e memoria delle fazioni
   * le fa il motore.
   */
  const modelsFor = async (campaignId?: string) => {
    const c = campaignId ? await store.getCampaign(campaignId) : null;
    const rules = (c ? factionModeOf(c) : factionModeDefault()) === 'rules';
    return Object.fromEntries(Object.entries(c?.config.llm ?? llmDefaults()).filter(([r, v]) => v && !(rules && (RULES_FREE_ROLES as readonly string[]).includes(r))).map(([r, v]) => [r, v!.model]));
  };
  /**
   * Prima di un'operazione che chiama i modelli: se non rispondono, 503 subito invece di un turno tutto in dottrina.
   * Un «irraggiungibile» in cache si riprova subito (il giocatore può aver appena acceso il PC).
   */
  const requireLlm = async (campaignId?: string) => {
    if (!llm.enforced) return;
    const models = await modelsFor(campaignId);
    let st = await llm.status(models);
    if (!st.reachable && st.cached) st = await llm.status(models, true);
    if (!st.reachable) throw new GameError('LLM_UNREACHABLE', `I modelli non rispondono: accendi il PC con Ollama (${st.baseUrl}${st.error ? ` — ${st.error}` : ''}). Per giocare lo stesso con gli ordini di dottrina avvia il server con WARGAME_ALLOW_OFFLINE=1.`, st);
  };

  /** Stato dei modelli (cache 30 s; ?fresh=1 riprova subito): raggiungibili, modello per ruolo, modelli mancanti, latenza. */
  app.get<{ Querystring: { campaignId?: string; fresh?: string } }>(`${P}/llm/status`, async (req) => {
    const c = req.query.campaignId ? await store.getCampaign(req.query.campaignId) : null;
    const budget = await engine.agents.budgetStatus?.(c ?? undefined, c?.currentTurn);
    return { ...(await llm.status(await modelsFor(req.query.campaignId), req.query.fresh === '1')), factionMode: c ? factionModeOf(c) : factionModeDefault(), ...(budget ? { budget } : {}) };
  });

  app.get(`${P}/scenarios`, async () => listScenarios());

  /**
   * Registro dei 197 Stati (dati pubblici dello scenario, niente nebbia): elenco compatto e scheda completa con le istituzioni
   * e le coppie storiche. Sono dati statici (scenarios/_world), non stato di gioco.
   */
  app.get(`${P}/nations`, async () => worldData().summaries());
  /** catalogo delle azioni diplomatiche (engine/diplo-actions.ts): costo in CD, ricarica, effetti */
  app.get(`${P}/diplomacy/catalog`, async () => diploCatalogView());
  app.get<{ Params: { iso3: string } }>(`${P}/nations/:iso3`, async (req) => {
    const w = worldData();
    const n = w.nation(req.params.iso3.toUpperCase());
    if (!n) throw new GameError('NOT_FOUND', `Stato sconosciuto: ${req.params.iso3}`);
    const pairs = w.pairs.filter(([a, b]) => a === n.iso3 || b === n.iso3).map(([a, b, value, label]) => (a === n.iso3 ? { dir: 'out' as const, with: b, value, label } : { dir: 'in' as const, with: a, value, label }));
    return {
      ...n, sourceLegend: w.sourceLegend, asOf: w.asOf,
      institutions: n.memberships.map((id) => w.institution(id)!).map((i) => ({ id: i.id, name: i.name, nameIt: i.nameIt, kind: i.kind, decision: i.decision, cohesion: i.cohesion, members: i.members.length })),
      pairs,
    };
  });
  app.get(`${P}/campaigns`, async () => store.listCampaigns());
  app.post<{ Body: unknown }>(`${P}/campaigns`, async (req) => {
    const b = z.object({ scenarioId: z.string().default('med-2026'), name: z.string().min(1), seed: z.string().optional(), turnLength: z.enum(['week', 'month']).optional(), debugGodView: z.boolean().optional(), cmoOnRequest: z.boolean().optional() }).parse(req.body);
    await requireLlm(); // la creazione gioca già il primo briefing
    return engine.createCampaign({ ...b, config: { debugGodView: b.debugGodView ?? false, cmoOnRequest: b.cmoOnRequest ?? false } });
  });
  app.get<Id>(`${P}/campaigns/:id`, async (req) => store.getCampaign(req.params.id));
  /** Operazione in corso sulla campagna (es. un turno con gli agenti LLM): la UI la usa per non rilanciare ▶. */
  app.get<Id>(`${P}/campaigns/:id/status`, async (req) => {
    const c = await store.getCampaign(req.params.id);
    const lock = await store.lockInfo(c.id);
    return { running: !!lock, op: lock?.op ?? null, since: lock?.since ?? null, turn: c.currentTurn, phase: c.phase };
  });
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
  app.post<Id & { Body: { text: string } }>(`${P}/campaigns/:id/orders/parse`, async (req) => {
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    await requireLlm(req.params.id);
    return engine.parseOrders(req.params.id, text);
  });
  /** Lettere visibili al giocatore (sue, a lui, pubbliche): tutti i turni, o solo `turn`. */
  app.get<Id & { Querystring: { turn?: string } }>(`${P}/campaigns/:id/letters`, async (req) => {
    const c = await store.getCampaign(req.params.id);
    const turns = req.query.turn === undefined ? Array.from({ length: c.currentTurn }, (_, i) => i + 1) : [Number(req.query.turn)].filter((t) => t >= 1 && t <= c.currentTurn);
    return (await Promise.all(turns.map((t) => store.getLetters(c.id, t)))).flat().filter((l) => letterVisibleTo(l, c.playerFaction));
  });
  /** Bozza scritta dall'LLM a nome dell'Italia: il giocatore la rivede e la manda come ordine LETTER. Non cambia lo stato. */
  app.post<Id & { Body: unknown }>(`${P}/campaigns/:id/letters/draft`, async (req) => {
    const b = z.object({ target: z.string(), gist: z.string().min(1).max(LETTER_LIMITS.gist), tone: LetterTone, inReplyTo: z.string().optional() }).parse(req.body);
    await requireLlm(req.params.id);
    return engine.draftLetter(req.params.id, b);
  });
  app.post<Id & { Body: unknown }>(`${P}/campaigns/:id/orders/validate`, async (req) => engine.validate(req.params.id, OrdersBody.parse(req.body)));
  app.post<Id & { Body: unknown }>(`${P}/campaigns/:id/orders`, async (req) => engine.submitOrders(req.params.id, OrdersBody.parse(req.body)));
  app.post<Id>(`${P}/campaigns/:id/advance`, async (req) => {
    try {
      await requireLlm(req.params.id);
      return await engine.advance(req.params.id);
    } catch (e) { bus.emit(req.params.id, { error: (e as Error).message }); throw e; }
  });
  app.post<Id & { Body: unknown }>(`${P}/campaigns/:id/config`, async (req) => engine.configure(req.params.id, z.object({
    turnLength: z.enum(['week', 'month']).optional(), cmoOnRequest: z.boolean().optional(), debugGodView: z.boolean().optional(),
    maxConcurrentAgents: z.number().int().min(1).max(16).optional(),
    agentCadence: z.object({ minorEvery: z.number().int().min(0).max(10).optional(), reflectEvery: z.number().int().min(1).max(10).optional(), lettersPerTurn: z.number().int().min(0).max(20).optional() }).optional(),
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
  /** tempo di ogni fase del motore (ms), per misurare i turni */
  app.get<Id>(`${P}/campaigns/:id/timings`, async (req) => store.getTimings(req.params.id));
  app.get<Id & { Querystring: { turn?: string; faction?: string } }>(`${P}/campaigns/:id/postmortem`, async (req) => {
    const c = await godAllowed(req.params.id);
    const t = Number(req.query.turn ?? c.currentTurn);
    const factions = req.query.faction ? [req.query.faction] : Object.keys((await store.getState(c.id)).factions);
    const decisions = (await Promise.all(factions.map((f) => store.getDecision(c.id, t, f)))).filter(Boolean);
    const tree = (await store.listCampaigns()).filter((x) => x.id === c.id || x.parent?.campaignId === c.id || c.parent?.campaignId === x.id);
    return { turn: t, decisions, directives: (await store.listDirectives(c.id, t)).filter((d) => !req.query.faction || d.factionId === req.query.faction), world: await store.getWorldDecision(c.id, t), rolls: await store.getRolls(c.id, t), events: await store.getEvents(c.id, t), state: await store.getState(c.id, t).catch(() => store.getState(c.id)), branches: tree };
  });
}
