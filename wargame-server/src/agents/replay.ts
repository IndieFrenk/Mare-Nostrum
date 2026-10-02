import type { AgentMemory } from '../schemas/index.js';
import type { AgentsPort, LetterJob, LetterResult } from '../engine/turn-machine.js';
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

  /** Le lettere IA sono negli ordini delle decisioni salvate (azioni LETTER, nell'ordine in cui il motore le ha chieste). */
  async writeLetters(jobs: LetterJob[]): Promise<LetterResult[]> {
    const used = new Map<string, number>();
    return Promise.all(jobs.map(async (j) => {
      const n = used.get(j.factionId) ?? 0; used.set(j.factionId, n + 1);
      const d = await this.store.getDecision(this.sourceId, j.knowledge.turn, j.factionId);
      // gli Stati del mondo non hanno una decisione propria: le loro lettere stanno nel file del livello C
      const w = d ? null : await this.store.getWorldDecision(this.sourceId, j.knowledge.turn);
      const a = (d ? d.orders.diplomacy : (w?.actions ?? []).filter((x) => x.actor === j.factionId).map((x) => x.action)).filter((x) => x.kind === 'LETTER')[n];
      if (!a || a.kind !== 'LETTER') throw new Error(`lettera mancante ${j.factionId} → ${j.to} T${j.knowledge.turn}`);
      const info = (d ? d.letters : w!.letters).find((l) => l.actionId === a.id);
      return { subject: a.subject, body: a.body, tone: a.tone, source: info?.source ?? (a.model === 'template' ? 'template' : 'ai'), model: a.model ?? 'replay', errors: info?.errors ?? [] };
    }));
  }

  /** Decisioni del livello C registrate: il motore le ricalcola (stesso dado) e controlla che siano identiche. */
  recordedWorld(turn: number) { return this.store.getWorldDecision(this.sourceId, turn); }

  /** Decisione registrata: il motore ricalcola quelle a regole (stesso dado) e controlla che siano identiche a queste. */
  recordedDecision(turn: number, factionId: string) { return this.store.getDecision(this.sourceId, turn, factionId); }

  async draftLetter(): Promise<never> { throw new Error('bozze non disponibili in replay'); }

  async parseOrders(): Promise<never> { throw new Error('parse non disponibile in replay'); }
}
