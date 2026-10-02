import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LlmProvider } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { LlmAgents } from '../src/agents/orchestrator.js';
import { baseOpinion, emptyDiplomacy, setTension, syncPair } from '../src/engine/opinion.js';
import type { WorldState } from '../src/schemas/index.js';
import { Engine } from '../src/engine/turn-machine.js';
import { JsonStore } from '../src/store/json-store.js';

export const tmp = () => mkdtempSync(path.join(tmpdir(), 'wg-'));

export function makeEngine(provider: LlmProvider = new MockLLMProvider(), dir = tmp()) {
  return new Engine(new JsonStore(dir), new LlmAgents(provider));
}

/**
 * Porta `opinion(a→b)` e la tensione di coppia ai valori dati, come farebbe la storia della partita: sostituisce i modificatori di
 * a verso b con uno solo permanente («Situazione di prova»). Per i test che costruiscono uno stato a mano (la matrice `relations`
 * è un valore derivato: scriverci non serve, la Knowledge legge i modificatori).
 */
export function setRelation(s: WorldState, a: string, b: string, trust: number, tension?: number) {
  const d = (s.diplomacy ??= emptyDiplomacy());
  d.modifiers = d.modifiers.filter((m) => !(m.from === a && m.to === b));
  d.modifiers.push({ id: `prova:${a}>${b}`, from: a, to: b, kind: 'situation', label: 'Situazione di prova', value: Math.round((trust - baseOpinion(a, b).value) * 10) / 10, decayPerWeek: 0, causeRef: 'test', visibility: 'public', turn: s.turn });
  if (tension !== undefined) setTension(s, a, b, tension);
  syncPair(s, a, b);
}
