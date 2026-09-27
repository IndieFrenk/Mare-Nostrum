import type { AgentDecision, LlmCall } from '../schemas/index.js';
import type { AgentsPort, DecideInput } from '../engine/turn-machine.js';
import { loadScenario } from '../engine/scenario.js';
import { decide } from './faction-agent.js';
import { writeBriefing, writeDebriefing, writeNews } from './gm-narrator.js';
import { analyze } from './intel-analyst.js';
import type { LlmProvider } from './llm-client.js';
import { parseOrders } from './order-parser.js';
import { reflect } from './reflection.js';

export async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/** Implementazione LLM della porta agenti; i risultati tornano in ordine deterministico. */
export class LlmAgents implements AgentsPort {
  private log: LlmCall[] = [];
  constructor(readonly provider: LlmProvider) {}

  drainLlmCalls() { const l = this.log; this.log = []; return l; }

  async briefing({ campaign, knowledge, facts }: Parameters<AgentsPort['briefing']>[0]) {
    const [briefing, reports] = await Promise.all([writeBriefing(this.provider, this.log, campaign, knowledge.turn, facts), analyze(this.provider, this.log, campaign, knowledge)]);
    return { briefing, reports };
  }

  async decideAll(inputs: DecideInput[], onProgress: (f: string, s: string) => void): Promise<AgentDecision[]> {
    const limit = inputs[0]?.campaign.config.maxConcurrentAgents ?? 2;
    return pool(inputs, limit, async (i) => {
      onProgress(i.factionId, 'in elaborazione');
      const d = await decide(this.provider, this.log, i);
      onProgress(i.factionId, d.validation.fallbackUsed ? 'fallback dottrinale' : 'completato');
      return d;
    });
  }

  async debrief({ campaign, facts, publicEvents }: Parameters<AgentsPort['debrief']>[0]) {
    const [debriefing, news] = await Promise.all([writeDebriefing(this.provider, this.log, campaign, campaign.currentTurn, facts), writeNews(this.provider, this.log, campaign, campaign.currentTurn, publicEvents)]);
    return { debriefing, news };
  }

  reflect(i: Parameters<AgentsPort['reflect']>[0]) { return reflect(this.provider, this.log, i.campaign, i); }

  parseOrders({ campaign, text, knowledge }: Parameters<AgentsPort['parseOrders']>[0]) {
    return parseOrders(this.provider, this.log, campaign, loadScenario(campaign.scenarioId), text, knowledge);
  }
}
