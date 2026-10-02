import type { AgentDecision, Campaign, LlmCall } from '../schemas/index.js';
import type { AgentsPort, DecideInput, LetterJob, LetterResult } from '../engine/turn-machine.js';
import { LlmBudget, type BudgetStatus, type Priority, type UsageStore } from './budget.js';
import { loadScenario } from '../engine/scenario.js';
import { decide } from './faction-agent.js';
import { writeBriefing, writeDebriefing, writeNews } from './gm-narrator.js';
import { analyze } from './intel-analyst.js';
import { letterPrompt, templateLetter, writeLetter } from './letter-writer.js';
import type { LlmProvider } from './llm-client.js';
import { parseOrders } from './order-parser.js';
import { reflect } from './reflection.js';
import { promptHash } from './repair.js';

export async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/** Priorità di una lettera: con il giocatore (scritta da lui, a lui o una risposta) P1, tra IA P5. */
export const letterPriority = (j: Pick<LetterJob, 'factionId' | 'to' | 'campaign'>): Priority => (j.to === j.campaign.playerFaction || j.factionId === j.campaign.playerFaction ? 1 : 5);

/**
 * Implementazione LLM della porta agenti; i risultati tornano in ordine deterministico. Ogni chiamata passa dal gestore del budget
 * (agents/budget.ts) con la sua priorità: Console Ordini e briefing P0, lettere con il giocatore P1 (e le decisioni delle fazioni in modalità
 * `llm`), notizie P2, direttive P3, reazioni delle cancellerie P4, lettere tra IA e riflessione P5. Senza budget ogni ruolo usa il suo testo deterministico.
 */
export class LlmAgents implements AgentsPort {
  private log: LlmCall[] = [];
  /** `budget`: predefinito senza tetto e senza cache (test e strumenti); il server e i comandi lo costruiscono dall'ambiente (`LlmBudget.fromEnv`). */
  constructor(readonly provider: LlmProvider, readonly budget: LlmBudget = LlmBudget.unlimited(provider)) {}

  drainLlmCalls() { const l = this.log; this.log = []; return l; }
  attach(store: UsageStore) { this.budget.attach(store); }
  settle() { return this.budget.settle(); }
  expect(campaign: Campaign, turn: number, demand: Partial<Record<Priority, number>>) { return this.budget.expect(campaign, turn, demand); }
  budgetStatus(campaign?: Campaign, turn?: number): Promise<BudgetStatus> { return this.budget.status(campaign, turn); }
  private view(c: Campaign, turn: number, p: Priority) { return this.budget.view(c, turn, p); }

  async briefing({ campaign, knowledge, facts }: Parameters<AgentsPort['briefing']>[0]) {
    const turn = knowledge.turn; const p = this.view(campaign, turn, 0);
    const [briefing, reports] = await Promise.all([writeBriefing(p, this.log, campaign, turn, facts), analyze(p, this.log, campaign, knowledge)]);
    // il debriefing (P0) e le notizie (P2) di fine turno: le priorità più basse, in mezzo, lasciano loro il posto
    await this.budget.expect(campaign, turn, { 0: 1, 2: 1 });
    return { briefing, reports };
  }

  async decideAll(inputs: DecideInput[], onProgress: (f: string, s: string) => void): Promise<AgentDecision[]> {
    const limit = inputs[0]?.campaign.config.maxConcurrentAgents ?? 2;
    return pool(inputs, limit, async (i) => {
      onProgress(i.factionId, 'in elaborazione');
      const d = await decide(this.view(i.campaign, i.knowledge.turn, 1), this.log, i);
      onProgress(i.factionId, d.validation.fallbackUsed ? 'fallback dottrinale' : 'completato');
      return d;
    });
  }

  async debrief({ campaign, facts, publicEvents }: Parameters<AgentsPort['debrief']>[0]) {
    const turn = campaign.currentTurn;
    const [debriefing, news] = await Promise.all([writeDebriefing(this.view(campaign, turn, 0), this.log, campaign, turn, facts), writeNews(this.view(campaign, turn, 2), this.log, campaign, turn, publicEvents)]);
    return { debriefing, news };
  }

  /**
   * Una chiamata diplomat per lettera, in parallelo entro maxConcurrentAgents; risultati nell'ordine dei job. Le lettere sono una coda a
   * priorità (con il giocatore P1, tra IA P5): se il budget non basta per tutte cadono per prime le ultime, che usano la lettera-modello.
   */
  async writeLetters(jobs: LetterJob[], onProgress: (f: string, s: string) => void): Promise<LetterResult[]> {
    if (!jobs.length) return [];
    const limit = jobs[0]!.campaign.config.maxConcurrentAgents ?? 2;
    const turn = jobs[0]!.knowledge.turn; const c = jobs[0]!.campaign;
    const prios = jobs.map(letterPriority);
    const admitted = await this.budget.admit(c, turn, jobs.map((j, i) => ({ priority: prios[i]!, hash: promptHash(letterPrompt(j)) })));
    return pool(jobs.map((_, i) => i), limit, async (i) => {
      const j = jobs[i]!;
      onProgress(j.factionId, `lettera a ${j.to}`);
      const r: LetterResult = admitted[i]
        ? await writeLetter(this.view(j.campaign, turn, prios[i]!), this.log, j)
        : { ...templateLetter(j), source: 'template', model: 'template', errors: ['chiamata LLM non fatta: budget del turno esaurito'] };
      onProgress(j.factionId, r.source === 'template' ? `lettera a ${j.to}: lettera-modello` : `lettera a ${j.to} scritta`);
      return r;
    });
  }

  draftLetter(job: LetterJob) { return writeLetter(this.view(job.campaign, job.campaign.currentTurn, 1), this.log, job); }

  reflect(i: Parameters<AgentsPort['reflect']>[0]) { return reflect(this.view(i.campaign, i.campaign.currentTurn, 5), this.log, i.campaign, i); }

  parseOrders({ campaign, text, knowledge }: Parameters<AgentsPort['parseOrders']>[0]) {
    return parseOrders(this.view(campaign, knowledge.turn, 0), this.log, campaign, loadScenario(campaign.scenarioId), text, knowledge);
  }
}
