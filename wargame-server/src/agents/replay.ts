import type { AgentMemory } from '../schemas/index.js';
import type { AgentsPort } from '../engine/turn-machine.js';
import type { JsonStore } from '../store/json-store.js';

/** Rilegge decisioni, narrativa e memoria salvate: nessuna chiamata LLM. */
export class ReplayAgents implements AgentsPort {
  constructor(readonly store: JsonStore, readonly sourceId: string) {}
  drainLlmCalls() { return []; }

  async briefing({ knowledge }: Parameters<AgentsPort['briefing']>[0]) {
    const n = (await this.store.getNarrative(this.sourceId, knowledge.turn))!;
    const k = await this.store.getKnowledge(this.sourceId, knowledge.factionId, knowledge.turn);
    return { briefing: n.briefing, reports: k?.intelReports ?? [] };
  }

  async decideAll(inputs: Parameters<AgentsPort['decideAll']>[0]) {
    return Promise.all(inputs.map(async (i) => {
      const d = await this.store.getDecision(this.sourceId, i.knowledge.turn, i.factionId);
      if (!d) throw new Error(`decisione mancante ${i.factionId} T${i.knowledge.turn}`);
      return { ...d, orders: { ...d.orders, source: 'replay' as const } };
    }));
  }

  async debrief({ campaign }: Parameters<AgentsPort['debrief']>[0]) {
    const n = (await this.store.getNarrative(this.sourceId, campaign.currentTurn))!;
    return { debriefing: n.debriefing!, news: n.news };
  }

  async reflect({ factionId, campaign, memory }: Parameters<AgentsPort['reflect']>[0]): Promise<AgentMemory> {
    const { readFile } = await import('node:fs/promises');
    const f = this.store.dir(this.sourceId, 'memory', 'history', `${factionId}-turn-${String(campaign.currentTurn).padStart(4, '0')}.json`);
    return readFile(f, 'utf8').then(JSON.parse).catch(() => memory);
  }

  async parseOrders(): Promise<never> { throw new Error('parse non disponibile in replay'); }
}
