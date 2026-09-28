import type { Unit } from '../schemas/index.js';
import type { Scenario } from './scenario.js';

/**
 * Riconoscimento deterministico dei nomi nelle direttive del giocatore, PRIMA dell'LLM: «Bergamini» → ITA-F590,
 * «Mar Ionio» → IONIO, «Tunisia» → TUN. I modelli piccoli sbagliano gli id; qui si risolvono i nomi certi e al
 * modello arriva il testo con l'id tra parentesi quadre, più la tabella nome → id.
 */

export type NameKind = 'unit' | 'zone' | 'faction';
export interface NameEntry { id: string; kind: NameKind; label: string; aliases: string[]; note?: string }
export interface Lexicon { entries: NameEntry[]; /** alias normalizzato → id (più id = ambiguo) */ index: Map<string, { kind: NameKind; ids: string[] }> }
export interface NameHit { alias: string; id: string; kind: NameKind }
export interface Recognition { text: string; hits: NameHit[]; ambiguous: { alias: string; ids: string[] }[] }

/** nomi italiani dei tipi di unità: servono solo quando indicano un'unica unità («la portaerei») */
const TYPE_IT: Partial<Record<Unit['type'], string[]>> = {
  carrier: ['portaerei'], lhd: ["nave d'assalto anfibio", 'LHD'], destroyer: ['cacciatorpediniere'], frigate: ['fregata'], opv: ['pattugliatore'],
  submarine: ['sottomarino'], sam_battery: ['batteria SAMP/T'], aew: ['aereo radar'], mpa: ['pattugliatore marittimo'], sof_team: ['forze speciali'],
};

/** minuscolo e senza accenti, carattere per carattere (così gli indici restano quelli del testo originale) */
const fold = (c: string) => { const n = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); return n.length === 1 ? n : c.toLowerCase().slice(0, 1) || c; };
const norm = (s: string) => [...s].map(fold).join('').replace(/[’`]/g, "'");
const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_-]/u.test(c);

/** Alias di un'unità: id, id senza prefisso, nome, nome senza sigla, sigla («F 590»), code del nome («Bergamini», «Thaon di Revel»), classe. */
export function unitAliases(u: Pick<Unit, 'id' | 'name' | 'classId' | 'type'>, className?: string): string[] {
  const out = new Set<string>([u.id, u.id.replace(/^[A-Z]{2,4}_?[A-Z]*-/, ''), u.name]);
  const m = u.name.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  const base = (m ? m[1]! : u.name).trim();
  out.add(base);
  if (m) { const p = m[2]!.trim(); out.add(p); if (/^[A-Z]{1,3} ?\d{2,4}$/.test(p)) out.add(p.replace(' ', '')); }
  // code del nome solo per le navi con sigla («Carlo Bergamini (F 590)» → «Bergamini»): negli stormi darebbero «Gruppo»
  if (m && /^[A-Z]{1,3} ?\d{2,4}$/.test(m[2]!.trim())) {
    const words = base.split(/\s+/);
    for (let i = 1; i < words.length; i++) if (/^\p{Lu}/u.test(words[i]!)) out.add(words.slice(i).join(' '));
  }
  out.add(u.classId);
  if (className) out.add(className);
  for (const t of TYPE_IT[u.type] ?? []) out.add(t);
  return [...out].filter((a) => a.replace(/[^\p{L}\p{N}]/gu, '').length >= 3);
}

export function buildLexicon(units: Unit[], sc: Scenario): Lexicon {
  const entries: NameEntry[] = [
    ...units.filter((u) => u.status !== 'destroyed').map((u) => ({ id: u.id, kind: 'unit' as const, label: u.name, aliases: unitAliases(u, sc.catalog.classes[u.classId]?.name), note: `classe ${sc.catalog.classes[u.classId]?.name ?? u.classId}` })),
    ...Object.values(sc.world.zones).map((z) => ({ id: z.id, kind: 'zone' as const, label: z.name, aliases: [z.id, z.name, ...(sc.names.zones[z.id] ?? [])] })),
    ...Object.values(sc.world.factions).map((f) => ({ id: f.id, kind: 'faction' as const, label: f.name, aliases: [f.id, f.name, ...(sc.names.factions[f.id] ?? [])] })),
  ];
  const index = new Map<string, { kind: NameKind; ids: string[] }>();
  for (const e of entries) for (const a of new Set(e.aliases.map(norm))) {
    const cur = index.get(a);
    if (!cur) index.set(a, { kind: e.kind, ids: [e.id] });
    else if (!cur.ids.includes(e.id)) cur.ids.push(e.id);
  }
  return { entries, index };
}

/**
 * Trova i nomi nel testo (prima gli alias più lunghi, a parola intera, senza sovrapposizioni) e scrive l'id tra
 * parentesi quadre dopo ogni nome certo: «la fregata Bergamini [ITA-F590]». Gli alias di più id non si sostituiscono;
 * quelli di zone e fazioni finiscono in `ambiguous` («Libia» → LBY_GNU o LBY_LNA).
 */
export function recognize(text: string, lex: Lexicon): Recognition {
  const t = norm(text);
  const taken: boolean[] = new Array(t.length).fill(false);
  const found: { start: number; end: number; alias: string; kind: NameKind; ids: string[] }[] = [];
  const aliases = [...lex.index.entries()].sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
  for (const [alias, v] of aliases) {
    for (let from = 0; ;) {
      const i = t.indexOf(alias, from);
      if (i < 0) break;
      from = i + 1;
      const end = i + alias.length;
      if (isWord(t[i - 1]) || isWord(t[end]) || taken.slice(i, end).some(Boolean)) continue;
      for (let j = i; j < end; j++) taken[j] = true;
      found.push({ start: i, end, alias: text.slice(i, end), kind: v.kind, ids: v.ids });
    }
  }
  found.sort((a, b) => a.start - b.start);
  const hits: NameHit[] = []; const ambiguous: Recognition['ambiguous'] = [];
  let out = ''; let last = 0;
  for (const f of found) {
    if (f.ids.length > 1) { if (f.kind !== 'unit') ambiguous.push({ alias: f.alias, ids: f.ids }); continue; }
    const id = f.ids[0]!;
    hits.push({ alias: f.alias, id, kind: f.kind });
    const already = f.alias === id || text.slice(f.end).trimStart().startsWith(`[${id}]`);
    out += text.slice(last, f.end) + (already ? '' : ` [${id}]`);
    last = f.end;
  }
  return { text: out + text.slice(last), hits, ambiguous };
}

/** Tabella nome → id per il prompt: una riga per voce, solo gli alias che indicano un'unica voce (più la classe). */
export function nameTable(lex: Lexicon, kind: NameKind): string {
  return lex.entries.filter((e) => e.kind === kind).map((e) => {
    const unique = [...new Set(e.aliases)].filter((a) => a !== e.id && (lex.index.get(norm(a))?.ids.length ?? 0) === 1);
    return `${e.id} = ${unique.join(' · ') || e.label}${e.note ? ` (${e.note})` : ''}`;
  }).join('\n');
}
