import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const cache = new Map<string, string>();

/** Riempie `prompts/{name}.md` sostituendo le variabili {{nome}}. */
export function template(name: string, vars: Record<string, string>): string {
  if (!cache.has(name)) cache.set(name, readFileSync(path.join(DIR, `${name}.md`), 'utf8'));
  return cache.get(name)!.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}
