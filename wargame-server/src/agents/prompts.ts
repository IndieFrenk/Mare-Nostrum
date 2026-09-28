import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const cache = new Map<string, string>();

const load = (name: string): string => {
  // {{>nome}} include un altro file di prompts/ (es. i campi degli ordini, uguali per fazioni e parser)
  if (!cache.has(name)) cache.set(name, readFileSync(path.join(DIR, `${name}.md`), 'utf8').replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, n) => load(n)));
  return cache.get(name)!;
};

/** Riempie `prompts/{name}.md` sostituendo le variabili {{nome}} e le inclusioni {{>file}}. */
export function template(name: string, vars: Record<string, string>): string {
  return load(name).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}
