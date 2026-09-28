import type { AfterActionReport, AgentRole, AgentDecision, AgentMemory, Campaign, Contact, DiploLetter, DiploMessage, LetterAction, LetterTone, FactionKnowledge, FactionOrders, GameEvent, IntelReport, LlmCall, NewsItem, OrdersBody, TurnNarrative, WorldState } from '../schemas/index.js';
import { isDeepStrictEqual } from 'node:util';
import { AgentDecision as AgentDecisionSchema, FactionOrders as FactionOrdersSchema, LETTER_LIMITS } from '../schemas/index.js';
import { leaderOf } from './diplomacy.js';
import { letterTriggers, type LetterTriggerKind } from './letter-triggers.js';
import type { JsonStore } from '../store/json-store.js';
import { adjudicate } from './adjudication.js';
import { applyAttrition } from './attrition.js';
import { applyAar, autoResolveMajor } from './cmo.js';
import { TurnCtx } from './context.js';
import { evolveCrises, recoverInfrastructure } from './crises.js';
import { runDetection } from './detection.js';
import { applyEnergy, chargeOperations } from './economy.js';
import { briefingFacts, debriefFacts, energyFacts, type Fact } from './facts.js';
import { addDays } from './geo.js';
import { buildKnowledge } from './knowledge.js';
import { deliver } from './procurement.js';
import { continueTransit } from './movement.js';
import { Rng } from './rng.js';
import { loadScenario, type Scenario } from './scenario.js';
import { validateOrders } from './validators.js';
import { finishParsed, type ParsedDirective } from './parse-review.js';
import { AGENT_ROLES, cadenceDefaults, factionModeDefault, llmDefaults, type FactionMode } from '../config.js';
import { doctrineDecision, rulesDecision } from '../agents/faction-agent.js';
import { quickMemory, rulesMemory } from '../agents/reflection.js';
import { incidentsFrom } from './knowledge.js';
import { checkThreats, confirmEnemyLosses, contactEvents, updateObjectives } from './review.js';

/** Una lettera da scrivere (una chiamata al ruolo diplomat): il motore sceglie chi scrive a chi, l'LLM solo testo e tono. */
export interface LetterJob {
  campaign: Campaign; factionId: string; to: string; kind: 'reply' | 'initiative' | 'draft';
  knowledge: FactionKnowledge; memory: AgentMemory | null; profile: string;
  fromTitle: string; toTitle: string; date: string;
  /** fiducia/tensione del mittente verso il destinatario (la sua riga della matrice) */
  relation: { trust: number; tension: number } | null;
  intent?: string; replyTo?: DiploLetter; gist?: string; tone?: LetterTone;
}
export interface LetterResult { subject: string; body: string; tone: LetterTone; source: 'ai' | 'template'; model: string; errors: string[] }
export interface DecideInput { campaign: Campaign; factionId: string; knowledge: FactionKnowledge; memory: AgentMemory; profile: string; state: WorldState; scenario: Scenario }
/** Porta verso gli agenti: il motore non conosce LLM, solo questo contratto. */
export interface AgentsPort {
  briefing(i: { campaign: Campaign; knowledge: FactionKnowledge; facts: Fact[] }): Promise<{ briefing: TurnNarrative['briefing']; reports: IntelReport[] }>;
  decideAll(inputs: DecideInput[], onProgress: (factionId: string, status: string) => void): Promise<AgentDecision[]>;
  debrief(i: { campaign: Campaign; facts: Fact[]; publicEvents: GameEvent[] }): Promise<{ debriefing: NonNullable<TurnNarrative['debriefing']>; news: NewsItem[] }>;
  reflect(i: { campaign: Campaign; factionId: string; decision: AgentDecision | null; visibleEvents: GameEvent[]; memory: AgentMemory }): Promise<AgentMemory>;
  /** Bozza di ordini da una direttiva in linguaggio naturale: il motore poi completa, traduce le posture e controlla (parse-review). */
  parseOrders(i: { campaign: Campaign; text: string; knowledge: FactionKnowledge }): Promise<ParsedDirective>;
  /** Scrive le lettere IA del turno, nello stesso ordine dei job (in replay: le rilegge dalle decisioni salvate). */
  writeLetters(jobs: LetterJob[], onProgress: (factionId: string, status: string) => void): Promise<LetterResult[]>;
  /** Bozza di lettera per il giocatore (non cambia lo stato). */
  draftLetter(job: LetterJob): Promise<LetterResult>;
  drainLlmCalls(): LlmCall[];
  /** Solo in replay: la decisione registrata, per verificare che quella ricalcolata a regole sia identica. */
  recordedDecision?(turn: number, factionId: string): Promise<AgentDecision | null>;
}

type LlmRoleConfig = NonNullable<Campaign['config']['llm']['diplomat']>;
/** Configurazione LLM di un ruolo (diplomat assente nelle campagne vecchie → quella di faction_major). */
export const roleConfig = (c: Campaign, role: AgentRole): LlmRoleConfig => c.config.llm[role] ?? c.config.llm.faction_major;

export class GameError extends Error { constructor(public code: string, message: string, public details?: unknown) { super(message); } }

type Cadence = Campaign['config']['agentCadence'];
export interface CreateOpts { scenarioId: string; name: string; seed?: string; turnLength?: 'week' | 'month'; id?: string; config?: Omit<Partial<Campaign['config']>, 'agentCadence'> & { agentCadence?: Partial<Cadence> } }
/** Cadenza della campagna con i default per i campi aggiunti dopo (campagne vecchie). */
export const cadenceOf = (c: Campaign): Cadence => Object.assign({ minorEvery: 1, reflectEvery: 1, lettersPerTurn: 3 }, c.config.agentCadence);
/** Modalità delle fazioni della campagna (le campagne vecchie senza il campo: quella del server). */
export const factionModeOf = (c: Campaign): FactionMode => c.config.factionMode ?? factionModeDefault();
/** Fazioni non giocate dall'umano che decidono (i blocchi reagiscono solo alle consultazioni). */
export const agentFactions = (s: WorldState) => Object.values(s.factions).filter((f) => f.controller !== 'human' && f.kind !== 'bloc').map((f) => f.id).sort();
/**
 * Chi decide come: in modalità `rules` tutte a regole; in modalità `llm` l'LLM per le fazioni con controller «ai» e le regole per
 * quelle «scripted» (i paesi aggiunti senza agente LLM: non allungano il turno).
 */
export function deciders(s: WorldState, c: Campaign): { llm: string[]; rules: string[] } {
  const all = agentFactions(s);
  if (factionModeOf(c) === 'rules') return { llm: [], rules: all };
  return { llm: all.filter((f) => s.factions[f]!.controller === 'ai'), rules: all.filter((f) => s.factions[f]!.controller !== 'ai') };
}


export class Engine {
  onProgress: (campaignId: string, msg: Record<string, unknown>) => void = () => {};
  constructor(readonly store: JsonStore, readonly agents: AgentsPort) {}

  async createCampaign(o: CreateOpts): Promise<Campaign> {
    const sc = loadScenario(o.scenarioId);
    const now = new Date().toISOString();
    const id = o.id ?? `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const campaign: Campaign = {
      schemaVersion: 1, id, name: o.name, scenarioId: o.scenarioId, seed: o.seed ?? id, rngCursor: 0, createdAt: now, updatedAt: now,
      currentTurn: 0, phase: 'CLOSED', date: sc.startDate, turnLength: o.turnLength ?? sc.turnLength, playerFaction: 'ITA', parent: null, status: 'active',
      config: {
        fogLevel: 'realistic', debugGodView: false, cmoThreshold: { majorShips: 1, aircraftPerSide: 4, missileSalvo: 8 },
        llm: llmDefaults(),
        maxConcurrentAgents: 2, cmoOnRequest: false, ...o.config, agentCadence: { ...cadenceDefaults(), ...o.config?.agentCadence },
        factionMode: o.config?.factionMode ?? factionModeDefault(),
      },
    };
    const s = sc.world;
    // modalità a regole: le fazioni IA diventano «scripted» (le decide il motore, engine/policy.ts)
    if (campaign.config.factionMode === 'rules') for (const f of Object.values(s.factions)) if (f.controller === 'ai') f.controller = 'scripted';
    await this.store.saveState(id, s, 0);
    await this.store.appendLedger(id, Object.values(s.factions).filter((f) => f.kind !== 'bloc').map((f) => ({ turn: 0, factionId: f.id, category: 'income' as const, amount: f.budget.discretionary, balanceAfter: f.budget.discretionary, ref: 'initial', note: 'Dotazione iniziale' })));
    for (const f of agentFactions(s).map((id) => s.factions[id]!)) {
      const goals = (sc.profiles[f.id] ?? '').match(/Interessi:\s*(.+)/)?.[1].split(/[,;]\s*/).slice(0, 5) ?? [];
      await this.store.saveMemory(id, { schemaVersion: 1, factionId: f.id, updatedTurn: 0, strategicGoals: goals, commitments: [], grievances: [], lessons: [], relationshipNotes: {}, rollingSummary: '' });
    }
    await this.store.saveCampaign(campaign);
    return this.advance(id);
  }

  private async ctxFor(c: Campaign): Promise<TurnCtx> {
    const state = await this.store.getState(c.id);
    const seq = (await this.store.getEvents(c.id, state.turn)).length;
    return new TurnCtx(state, c, loadScenario(c.scenarioId), new Rng(c.seed, c.rngCursor, state.turn), seq);
  }

  private flushed = new WeakMap<TurnCtx, { e: number; r: number; l: number }>();
  private async flush(ctx: TurnCtx, c: Campaign, snapshot = false) {
    const f = this.flushed.get(ctx) ?? { e: 0, r: 0, l: 0 };
    const events = ctx.events.slice(f.e); const rolls = ctx.rng.rolls.slice(f.r); const ledger = ctx.ledger.slice(f.l);
    for (const t of [...new Set(events.map((e) => e.turn))]) await this.store.appendEvents(c.id, t, events.filter((e) => e.turn === t));
    for (const t of [...new Set(rolls.map((r) => r.turn))]) await this.store.appendRolls(c.id, t, rolls.filter((r) => r.turn === t));
    await this.store.appendLedger(c.id, ledger);
    await this.store.appendLlmCalls(c.id, ctx.turn, this.agents.drainLlmCalls());
    this.flushed.set(ctx, { e: ctx.events.length, r: ctx.rng.rolls.length, l: ctx.ledger.length });
    await this.store.saveState(c.id, ctx.state, snapshot ? ctx.turn : undefined);
    Object.assign(c, { rngCursor: ctx.rng.cursor, currentTurn: ctx.turn, date: ctx.state.date, phase: ctx.phase, updatedAt: new Date().toISOString() });
    await this.store.saveCampaign(c);
  }

  /** Esegue le fasi fino a PLAYER_ORDERS del turno successivo o a CMO_PENDING. */
  advance(id: string): Promise<Campaign> {
    return this.store.withLock(id, async () => {
      try { return await this.runPhases(id); } finally { this.onProgress(id, { done: true }); }
    }, 'turno');
  }

  private async runPhases(id: string): Promise<Campaign> {
    {
      const c = await this.store.getCampaign(id);
      if (c.status === 'ended') throw new GameError('CAMPAIGN_ENDED', 'campagna conclusa');
      const ctx = await this.ctxFor(c);
      const progress = (msg: Record<string, unknown>) => this.onProgress(id, { turn: ctx.turn, ...msg });
      for (;;) {
        progress({ phase: ctx.phase });
        switch (ctx.phase) {
          case 'CLOSED':
            ctx.phase = 'OPEN';
            ctx.startTurn(ctx.state.turn + 1, addDays(ctx.state.date, c.turnLength === 'week' ? 7 : 30));
            break;
          case 'OPEN':
            deliver(ctx); chargeOperations(ctx); applyAttrition(ctx); continueTransit(ctx); recoverInfrastructure(ctx);
            evolveCrises(ctx, ctx.turn > 1 ? await this.store.getEvents(id, ctx.turn - 1) : []);
            ctx.phase = 'INTEL'; break;
          case 'INTEL': await this.intel(ctx, c); ctx.phase = 'BRIEFING'; break;
          case 'BRIEFING': await this.briefing(ctx, c); ctx.phase = 'PLAYER_ORDERS'; await this.flush(ctx, c); return c;
          case 'PLAYER_ORDERS':
            if (!(await this.store.getOrders(id, ctx.turn, c.playerFaction))) await this.store.saveOrders(id, { schemaVersion: 1, factionId: c.playerFaction, turn: ctx.turn, source: 'human', military: [], diplomacy: [], procurement: [], statements: [] });
            ctx.phase = 'AI_DECISIONS'; break;
          case 'AI_DECISIONS': await this.decisions(ctx, c, progress); ctx.phase = 'ADJUDICATION'; await this.flush(ctx, c); break;
          case 'ADJUDICATION': {
            await this.restoreContacts(ctx);
            const orders = (await Promise.all(Object.keys(ctx.state.factions).sort().map((f) => this.store.getOrders(id, ctx.turn, f)))).filter((o): o is FactionOrders => !!o);
            const rejected = adjudicate(ctx, orders);
            if (rejected.length) progress({ rejected });
            await this.store.appendLetters(id, ctx.turn, ctx.events.filter((e) => e.type === 'LETTER_SENT' && e.turn === ctx.turn).map((e) => (e.payload as { letter: DiploLetter }).letter));
            for (const e of Object.values(ctx.state.engagements).filter((e) => e.turn === ctx.turn && e.cmoPackage)) await this.store.saveCmo(id, ctx.turn, e.id, { package: e.cmoPackage });
            ctx.phase = this.pendingCmo(ctx.state).length ? 'CMO_PENDING' : 'DEBRIEF';
            break;
          }
          case 'CMO_PENDING':
            if (this.pendingCmo(ctx.state).length) { await this.flush(ctx, c); return c; }
            ctx.phase = 'DEBRIEF'; break;
          case 'DEBRIEF': await this.debrief(ctx, c); ctx.phase = 'CLOSED'; break;
        }
        if (ctx.phase === 'CLOSED') {
          ctx.emit('TURN_CLOSED', 'world', { rngCursor: ctx.rng.cursor });
          await this.flush(ctx, c, true);
        }
      }
    }
  }

  private pendingCmo(s: WorldState) { return Object.values(s.engagements).filter((e) => e.status === 'pending_cmo'); }

  private async previousExtras(ctx: TurnCtx, c: Campaign) {
    const prevEvents = ctx.turn > 1 ? await this.store.getEvents(c.id, ctx.turn - 1) : [];
    const inbox = prevEvents.filter((e) => e.type === 'DIPLO_MESSAGE').map((e) => (e.payload as { message: DiploMessage }).message);
    const news = (await this.store.getNarrative(c.id, ctx.turn - 1))?.news ?? [];
    const letters = (await Promise.all([3, 2, 1].filter((d) => ctx.turn - d >= 1).map((d) => this.store.getLetters(c.id, ctx.turn - d)))).flat();
    return { inbox, news, letters, prevEvents };
  }

  private async intel(ctx: TurnCtx, c: Campaign) {
    const prev: Record<string, Contact[]> = {};
    for (const f of Object.keys(ctx.state.factions)) {
      const k = await this.store.getKnowledge(c.id, f, ctx.turn - 1);
      if (k) prev[f] = k.contacts as Contact[];
    }
    runDetection(ctx, prev);
    contactEvents(ctx, prev);
    confirmEnemyLosses(ctx);
    const extra = await this.previousExtras(ctx, c);
    for (const f of Object.values(ctx.state.factions).filter((f) => f.kind !== 'bloc')) {
      await this.store.saveKnowledge(c.id, buildKnowledge(ctx.state, f.id, ctx.truthContacts[f.id] ?? [], extra));
    }
    await this.store.saveTruthContacts(c.id, ctx.turn, ctx.truthContacts);
  }

  private async restoreContacts(ctx: TurnCtx) {
    if (!Object.keys(ctx.truthContacts).length) ctx.truthContacts = await this.store.getTruthContacts(ctx.campaign.id, ctx.turn);
  }

  private async briefing(ctx: TurnCtx, c: Campaign) {
    const k = (await this.store.getKnowledge(c.id, c.playerFaction, ctx.turn))!;
    const recent = ctx.events.filter((e) => ctx.isVisibleTo(e, c.playerFaction));
    const facts = [...briefingFacts(k, recent), ...energyFacts(ctx.state, ctx.turn)];
    const { briefing, reports } = await this.agents.briefing({ campaign: c, knowledge: k, facts });
    await this.store.saveKnowledge(c.id, { ...k, intelReports: reports });
    await this.store.saveNarrative(c.id, ctx.turn, { turn: ctx.turn, briefing, news: [] });
  }

  private async decisions(ctx: TurnCtx, c: Campaign, progress: (m: Record<string, unknown>) => void) {
    const sc = loadScenario(c.scenarioId);
    const who = deciders(ctx.state, c);
    const inputs: DecideInput[] = [];
    for (const f of [...who.llm, ...who.rules].sort()) {
      const knowledge = (await this.store.getKnowledge(c.id, f, ctx.turn))!;
      const memory = (await this.store.getMemory(c.id, f)) ?? { schemaVersion: 1 as const, factionId: f, updatedTurn: 0, strategicGoals: [], commitments: [], grievances: [], lessons: [], relationshipNotes: {}, rollingSummary: '' };
      inputs.push({ campaign: c, factionId: f, knowledge, memory, profile: sc.profiles[f] ?? '', state: ctx.state, scenario: sc });
    }
    // a regole: nessuna chiamata LLM, dado registrato del motore, in ordine di id (stessa sequenza di tiri nel replay)
    const byRules: AgentDecision[] = [];
    for (const i of inputs.filter((x) => who.rules.includes(x.factionId))) {
      const d = rulesDecision(i, ctx.rng);
      const saved = await this.agents.recordedDecision?.(ctx.turn, i.factionId);
      if (saved && !isDeepStrictEqual(rulesFingerprint(saved), rulesFingerprint(AgentDecisionSchema.parse(JSON.parse(JSON.stringify(d)))))) throw new GameError('REPLAY_DIVERGENT', `decisione a regole di ${i.factionId} al turno ${ctx.turn} diversa da quella registrata`);
      progress({ agent: i.factionId, status: 'regole' });
      byRules.push(d);
    }
    // cadenza (modalità llm): le fazioni minori saltano l'IA a turni alterni (sfalsate), con ordini di dottrina deterministici
    const withAi = inputs.filter((x) => who.llm.includes(x.factionId));
    const cad = cadenceOf(c);
    const minors = who.llm.filter((f) => ctx.state.factions[f]!.agentRole === 'faction_minor');
    const withLlm = (f: string) => { const i = minors.indexOf(f); return i < 0 || (cad.minorEvery > 0 && (ctx.turn + i) % cad.minorEvery === 0); };
    const skipped = withAi.filter((i) => !withLlm(i.factionId)).map((i) => {
      progress({ agent: i.factionId, status: 'dottrina (turno senza IA)' });
      return doctrineDecision(i, `Turno senza IA (cadenza 1 ogni ${cad.minorEvery || '∞'}): ordini di dottrina.`);
    });
    const called = withAi.filter((i) => withLlm(i.factionId));
    const decisions = [...byRules, ...skipped, ...(called.length ? await this.agents.decideAll(called, (factionId, status) => progress({ agent: factionId, status })) : [])];
    await this.letters(ctx, c, decisions, inputs, progress);
    for (const d of decisions.sort((a, b) => a.factionId.localeCompare(b.factionId))) {
      await this.store.saveDecision(c.id, d);
      await this.store.saveOrders(c.id, d.orders);
    }
  }

  private letterJob(c: Campaign, s: WorldState, i: { factionId: string; knowledge: FactionKnowledge; memory: AgentMemory | null; profile: string }, to: string, kind: LetterJob['kind'], extra: Partial<LetterJob> = {}): LetterJob {
    const rel = s.relations[i.factionId]?.[to];
    return {
      campaign: c, factionId: i.factionId, to, kind, knowledge: i.knowledge, memory: i.memory, profile: i.profile,
      fromTitle: leaderOf(s, i.factionId).title, toTitle: leaderOf(s, to).title, date: s.date,
      relation: rel ? { trust: rel.trust, tension: rel.tension } : null, ...extra,
    };
  }

  /**
   * Lettere IA del turno, scelte in modo deterministico e poi scritte dal ruolo diplomat:
   * 1) risposte alle lettere del giocatore del turno precedente (sempre, al massimo una per fazione, anche nei turni «senza IA»);
   * 2) iniziative: prima i letterIntents delle decisioni IA, poi gli inneschi del motore sul turno precedente (engine/letter-triggers.ts:
   *    minaccia, blocco, sanzione o ingaggio subiti, tensione salita, accordo appena accettato); max 1 per le minori e 2 per le maggiori,
   *    in tutto al massimo lettersPerTurn, prima le maggiori e poi per id. Diventano azioni LETTER negli ordini: stesso validatore
   *    ed effetti del giocatore.
   */
  private async letters(ctx: TurnCtx, c: Campaign, decisions: AgentDecision[], inputs: DecideInput[], progress: (m: Record<string, unknown>) => void) {
    const s = ctx.state; const player = c.playerFaction;
    const byF = new Map(decisions.map((d) => [d.factionId, d]));
    for (const d of decisions) { d.orders.diplomacy = d.orders.diplomacy.filter((x) => x.kind !== 'LETTER'); d.letters = []; }
    type Choice = { factionId: string; to: string; kind: 'reply' | 'initiative'; replyTo?: DiploLetter; gist?: string; tone?: LetterTone; trigger?: LetterTriggerKind };
    const picks: Choice[] = [];
    const replying = new Set<string>();
    for (const l of ctx.turn > 1 ? await this.store.getLetters(c.id, ctx.turn - 1) : []) {
      if (l.from !== player || !byF.has(l.to) || replying.has(l.to)) continue;
      replying.add(l.to);
      picks.push({ factionId: l.to, to: player, kind: 'reply', replyTo: l });
    }
    const major = (f: string) => s.factions[f]?.agentRole === 'faction_major';
    const prev = ctx.turn - 1;
    const triggers = prev >= 1 ? letterTriggers({
      state: s, writers: [...byF.keys()],
      prevEvents: await this.store.getEvents(c.id, prev),
      prevOrders: (await Promise.all(Object.keys(s.factions).sort().map((f) => this.store.getOrders(c.id, prev, f)))).filter((o): o is FactionOrders => !!o),
      prevState: await this.store.getState(c.id, prev), prevPrevState: await this.store.getState(c.id, prev - 1).catch(() => null),
    }) : [];
    const initiatives = [...byF.values()].sort((a, b) => a.factionId.localeCompare(b.factionId)).flatMap((d) => {
      const seen = new Set<string>();
      const fromIntents = d.model === 'dottrina' ? [] : d.letterIntents.map((li): Choice => ({ factionId: d.factionId, to: li.to, kind: 'initiative', gist: li.gist.slice(0, LETTER_LIMITS.gist), tone: li.tone }));
      const fromTriggers = triggers.filter((t) => t.factionId === d.factionId).map((t): Choice => ({ factionId: d.factionId, to: t.to, kind: 'initiative', gist: t.gist, tone: t.tone, trigger: t.kind }));
      return [...fromIntents, ...fromTriggers].filter((li) => li.to !== d.factionId && s.factions[li.to] && s.factions[li.to]!.kind !== 'bloc'
        && !(li.to === player && replying.has(d.factionId)) && !seen.has(li.to) && !!seen.add(li.to))
        .slice(0, major(d.factionId) ? 2 : 1);
    }).sort((a, b) => Number(major(b.factionId)) - Number(major(a.factionId)) || a.factionId.localeCompare(b.factionId));
    picks.push(...initiatives.slice(0, cadenceOf(c).lettersPerTurn));
    if (!picks.length) return;
    const input = new Map(inputs.map((i) => [i.factionId, i]));
    const jobs = picks.map((p) => {
      const d = byF.get(p.factionId)!;
      return this.letterJob(c, s, input.get(p.factionId)!, p.to, p.kind, { replyTo: p.replyTo, gist: p.gist, tone: p.tone, intent: d.privateIntent });
    });
    const results = await this.agents.writeLetters(jobs, (factionId, status) => progress({ agent: factionId, status }));
    picks.forEach((p, i) => {
      const d = byF.get(p.factionId)!; const r = results[i]!;
      const action: LetterAction = { id: `${p.factionId}-${ctx.turn}-L${d.letters.length + 1}`, kind: 'LETTER', target: p.to, subject: r.subject, body: r.body, tone: r.tone, visibility: 'private', ...(p.replyTo ? { inReplyTo: p.replyTo.id } : {}), model: r.model };
      d.orders.diplomacy.push(action);
      d.letters.push({ actionId: action.id, to: p.to, kind: p.kind, ...(p.replyTo ? { inReplyTo: p.replyTo.id } : {}), ...(p.trigger ? { trigger: p.trigger } : {}), source: r.source, model: r.model, errors: r.errors });
    });
  }

  private async debrief(ctx: TurnCtx, c: Campaign) {
    applyEnergy(ctx);
    updateObjectives(ctx);
    checkThreats(ctx, [...(ctx.turn > 2 ? await this.store.getEvents(c.id, ctx.turn - 2) : []), ...(ctx.turn > 1 ? await this.store.getEvents(c.id, ctx.turn - 1) : []), ...(await this.store.getEvents(c.id, ctx.turn))]);
    await this.flush(ctx, c);
    const events = await this.store.getEvents(c.id, ctx.turn);
    const player = c.playerFaction;
    const ledger = (await this.store.getLedger(c.id)).filter((l) => l.turn === ctx.turn);
    const facts = debriefFacts(ctx.turn, events.filter((e) => ctx.isVisibleTo(e, player)), ledger, player);
    const { debriefing, news } = await this.agents.debrief({ campaign: c, facts, publicEvents: events.filter((e) => e.visibility === 'public') });
    const narrative = (await this.store.getNarrative(c.id, ctx.turn))!;
    await this.store.saveNarrative(c.id, ctx.turn, { ...narrative, debriefing, news });
    const cad = cadenceOf(c);
    const who = deciders(ctx.state, c);
    for (const f of [...who.llm, ...who.rules].sort()) {
      const memory = (await this.store.getMemory(c.id, f)) ?? { schemaVersion: 1 as const, factionId: f, updatedTurn: 0, strategicGoals: [], commitments: [], grievances: [], lessons: [], relationshipNotes: {}, rollingSummary: '' };
      const decision = await this.store.getDecision(c.id, ctx.turn, f);
      // a regole: riassunto deterministico (cosa ho subito, cosa ho fatto), nessuna chiamata reflection
      const m = who.rules.includes(f) ? rulesMemory(memory, decision, incidentsFrom(events, f), ctx.turn)
        : (ctx.turn + who.llm.indexOf(f)) % cad.reflectEvery === 0
          ? await this.agents.reflect({ campaign: c, factionId: f, decision, visibleEvents: events.filter((e) => ctx.isVisibleTo(e, f)), memory })
          : quickMemory(memory, decision, ctx.turn);
      await this.store.saveMemory(c.id, { ...m, updatedTurn: ctx.turn });
    }
  }

  // ——— operazioni del giocatore ———

  async knowledge(id: string): Promise<FactionKnowledge> {
    const c = await this.store.getCampaign(id);
    const k = await this.store.getKnowledge(id, c.playerFaction, c.currentTurn);
    if (!k) throw new GameError('NOT_FOUND', 'knowledge non disponibile');
    return k;
  }

  async validate(id: string, body: OrdersBody) {
    const c = await this.store.getCampaign(id);
    const k = await this.knowledge(id);
    return validateOrders(await this.store.getState(id), loadScenario(c.scenarioId).catalog, c.playerFaction, body, new Set(k.contacts.map((x) => x.id)), c.turnLength);
  }

  async submitOrders(id: string, body: OrdersBody) {
    const c = await this.store.getCampaign(id);
    if (c.phase !== 'PLAYER_ORDERS') throw new GameError('WRONG_PHASE', `fase attuale ${c.phase}`);
    const v = await this.validate(id, body);
    if (!v.valid) throw new GameError('INVALID_ORDERS', 'ordini non validi', v);
    const orders = FactionOrdersSchema.parse({ ...body, schemaVersion: 1, factionId: c.playerFaction, turn: c.currentTurn, source: 'human' });
    await this.store.saveOrders(id, orders);
    return { orders, validation: v };
  }

  async parseOrders(id: string, text: string) {
    const c = await this.store.getCampaign(id);
    const knowledge = await this.knowledge(id);
    const parsed = await this.agents.parseOrders({ campaign: c, text, knowledge });
    await this.store.appendLlmCalls(id, c.currentTurn, this.agents.drainLlmCalls());
    return finishParsed({ state: await this.store.getState(id), scenario: loadScenario(c.scenarioId), factionId: c.playerFaction, knowledge, turnLength: c.turnLength, text, parsed });
  }

  /** Bozza di lettera del giocatore scritta dal ruolo diplomat a nome dell'Italia: il giocatore la rivede e la invia come ordine LETTER. */
  async draftLetter(id: string, b: { target: string; gist: string; tone: LetterTone; inReplyTo?: string }) {
    const c = await this.store.getCampaign(id);
    const s = await this.store.getState(id);
    const t = s.factions[b.target];
    if (!t || b.target === c.playerFaction || t.kind === 'bloc') throw new GameError('VALIDATION', `destinatario non valido: ${b.target}`);
    const k = await this.knowledge(id);
    const replyTo = b.inReplyTo ? k.letters.find((l) => l.id === b.inReplyTo && l.to === c.playerFaction) : undefined;
    const job = this.letterJob(c, s, { factionId: c.playerFaction, knowledge: k, memory: null, profile: loadScenario(c.scenarioId).profiles[c.playerFaction] ?? '' }, b.target, 'draft',
      { gist: b.gist.slice(0, LETTER_LIMITS.gist), tone: b.tone, replyTo });
    const r = await this.agents.draftLetter(job);
    await this.store.appendLlmCalls(id, c.currentTurn, this.agents.drainLlmCalls());
    return { target: b.target, ...(replyTo ? { inReplyTo: replyTo.id } : {}), ...r };
  }

  submitAar(id: string, engagementId: string, body: { autoResolve: true } | AfterActionReport) {
    return this.store.withLock(id, async () => {
      const c = await this.store.getCampaign(id);
      const ctx = await this.ctxFor(c);
      const eng = ctx.state.engagements[engagementId];
      if (!eng || eng.status !== 'pending_cmo') throw new GameError('NOT_FOUND', `nessun ingaggio in attesa ${engagementId}`);
      if ('autoResolve' in body) autoResolveMajor(ctx, engagementId);
      else applyAar(ctx, engagementId, body);
      await this.store.saveCmo(id, ctx.turn, engagementId, { package: eng.cmoPackage, aar: 'autoResolve' in body ? null : body, result: ctx.state.engagements[engagementId] });
      await this.flush(ctx, c);
      return ctx.state.engagements[engagementId];
    }, 'cmo');
  }

  async fork(id: string, fromTurn: number) {
    const c = await this.store.getCampaign(id);
    if (fromTurn < 0 || fromTurn >= c.currentTurn + (c.phase === 'CLOSED' ? 1 : 0)) throw new GameError('BAD_TURN', `turno ${fromTurn} non chiuso`);
    return this.store.fork(id, fromTurn, `${id}-f${fromTurn}-${Date.now().toString(36)}`);
  }

  /** Cambi di configurazione in corsa (es. turno mensile→settimanale in crisi acuta, CMO su richiesta, modelli per ruolo). */
  configure(id: string, patch: { turnLength?: Campaign['turnLength']; cmoOnRequest?: boolean; debugGodView?: boolean; maxConcurrentAgents?: number; agentCadence?: Partial<Cadence>; llm?: Record<string, Partial<LlmRoleConfig>> }) {
    return this.store.withLock(id, async () => {
      const c = await this.store.getCampaign(id);
      if (patch.turnLength) c.turnLength = patch.turnLength;
      const { llm, turnLength: _t, agentCadence, ...rest } = patch;
      Object.assign(c.config, rest);
      if (agentCadence) c.config.agentCadence = { ...cadenceOf(c), ...agentCadence };
      for (const [role, cfg] of Object.entries(llm ?? {})) {
        if (!(AGENT_ROLES as readonly string[]).includes(role)) throw new GameError('VALIDATION', `ruolo sconosciuto ${role}`);
        const r = role as AgentRole;
        c.config.llm[r] = { ...roleConfig(c, r), ...cfg };
      }
      c.updatedAt = new Date().toISOString();
      await this.store.saveCampaign(c);
      return c;
    }, 'config');
  }

  async end(id: string) {
    const c = await this.store.getCampaign(id);
    c.status = 'ended';
    await this.store.saveCampaign(c);
    return c;
  }
}

/** Parte di una decisione a regole che il replay ricalcola (le lettere si aggiungono dopo, dal ruolo diplomat o dal registro). */
function rulesFingerprint(d: AgentDecision) {
  return { zoneStances: d.zoneStances, rationale: d.rationale, letterIntents: d.letterIntents, stanceOrders: d.stanceOrders, military: d.orders.military, diplomacy: d.orders.diplomacy.filter((x) => x.kind !== 'LETTER') };
}
