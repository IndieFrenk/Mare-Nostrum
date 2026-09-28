import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LlmProvider } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { LlmAgents } from '../src/agents/orchestrator.js';
import { Engine } from '../src/engine/turn-machine.js';
import { JsonStore } from '../src/store/json-store.js';

export const tmp = () => mkdtempSync(path.join(tmpdir(), 'wg-'));

export function makeEngine(provider: LlmProvider = new MockLLMProvider(), dir = tmp()) {
  return new Engine(new JsonStore(dir), new LlmAgents(provider));
}
