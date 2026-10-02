import { DIRECTIVE_KINDS, Directive, type DirectiveRecord, type FactionKnowledge, type WorldState } from '../schemas/index.js';
import { opinionBand } from './opinion.js';
import { PARAMS } from './params.js';
import { worldData } from './world-data.js';

/**
 * Direttive strategiche delle grandi potenze (docs/wargame/DIPLOMAZIA.md §11). L'LLM non decide mai un esito: propone **intenzioni**; il motore
 * costruisce il contesto (solo dalla Knowledge della potenza), **valida** (bersagli esistenti, tipi ammessi), **limita** (pesi, scarti, liste) e
 * applica la versione limitata come bonus di punteggio in `policy.ts` e `world-ai.ts` per `horizonTurns` turni. Il registro tiene richiesta,
 * risposta, proposta e versione limitata; il replay rilegge quest'ultima senza chiamare l'LLM. Funzioni pure: stesso input, stesso output.
 */

const P = () => PARAMS.strategist;

// ——— chi, quando ———

/** Le potenze con una direttiva: USA, CHN, RUS e le fazioni con `tier: 'A'`, che esistono, non sono giocate dall'umano e non sono blocchi. */
export function strategistPowers(s: WorldState): string[] {
  const ids = new Set<string>([...P().powers, ...Object.values(s.factions).filter((f) => f.tier === 'A').map((f) => f.id)]);
  return [...ids].filter((id) => { const f = s.factions[id]; return !!f && f.kind !== 'bloc' && f.controller !== 'human'; }).sort();
}

/**
 * Rotazione deterministica: una potenza per turno, ognuna ogni `period` turni, con `period` = numero di potenze tra 3 e 6 (con 3 potenze: USA,
 * CHN, RUS a turni alterni; con 2: ognuna ogni 3 turni; con più di 6: più di una per turno).
 */
export function strategistsOfTurn(turn: number, powers: string[]): string[] {
  const n = powers.length;
  if (!n) return [];
  const period = Math.max(P().period.min, Math.min(P().period.max, n));
  return powers.filter((_, i) => i % period === turn % period);
}

/** La direttiva in vigore al turno `turn`: la più recente tra i registri con una versione limitata e `turno + orizzonte > turn`. */
export function activeDirective(records: DirectiveRecord[], turn: number): DirectiveRecord | null {
  return [...records].filter((r) => r.limited && r.turn <= turn && r.turn + r.limited.horizonTurns > turn).sort((a, b) => b.turn - a.turn)[0] ?? null;
}

// ——— validare e limitare ———

export interface LimitInput { state: WorldState; factionId: string; zones: ReadonlySet<string> }
export interface Limited { directive: Directive; notes: string[] }

const POSITIVE = new Set(['improve', 'court']);
const r2 = (v: number) => Math.round(v * 100) / 100;
const words = (t: string, max: number) => { const w = t.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean); return { text: w.slice(0, max).join(' ').slice(0, 420), cut: w.length > max }; };

/** Un bersaglio esiste: una fazione (non un blocco) o uno Stato del registro senza fazione. */
export function knownActor(s: WorldState, id: string): boolean {
  const f = s.factions[id];
  if (f) return f.kind !== 'bloc';
  const n = worldData().nation(id);
  return !!n && !n.factionId;
}

/**
 * La proposta del modello (qualunque cosa abbia scritto) → direttiva valida e limitata, con le note su ciò che è cambiato. Si tolgono i bersagli
 * inesistenti o la potenza stessa, i tipi non ammessi, le zone sconosciute; pesi in 0–1 e somma ≤ `maxTotalWeight`; scarti d'interesse ±0,2;
 * orizzonte 3–6; liste ai tetti (le voci più forti restano); una priorità positiva e una negativa sullo stesso bersaglio: resta la più pesante.
 * Idempotente: una direttiva già limitata torna uguale e senza note (il replay la rilegge così com'è).
 */
export function limitDirective(raw: unknown, ctx: LimitInput): Limited {
  const notes: string[] = [];
  const L = P();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);
  const ok = (id: string) => id !== ctx.factionId && knownActor(ctx.state, id);

  const h = Math.round(num(o.horizonTurns));
  const horizonTurns = Number.isFinite(h) ? Math.max(3, Math.min(6, h)) : 3;
  if (!Number.isFinite(h) || h !== horizonTurns) notes.push(`orizzonte ${Number.isFinite(h) ? h : 'mancante'} → ${horizonTurns} turni`);

  // priorità: tipo noto, bersaglio esistente, peso 0–1; una per (tipo, bersaglio)
  const prio = new Map<string, { kind: Directive['priorities'][number]['kind']; target: string; weight: number }>();
  for (const x of arr(o.priorities)) {
    const e = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const kind = str(e.kind); const target = str(e.target); const w0 = num(e.weight);
    if (!(DIRECTIVE_KINDS as readonly string[]).includes(kind)) { notes.push(`tipo di priorità «${kind || '?'}» non ammesso: scartata`); continue; }
    if (!ok(target)) { notes.push(`bersaglio «${target || '?'}» inesistente${target === ctx.factionId ? ' (la potenza stessa)' : ''}: priorità ${kind} scartata`); continue; }
    const w = Number.isFinite(w0) ? Math.max(0, Math.min(1, w0)) : 0.5;
    if (w !== w0) notes.push(`peso ${Number.isFinite(w0) ? w0 : '?'} → ${w} (${kind} ${target})`);
    const key = `${kind}|${target}`; const prev = prio.get(key);
    if (!prev || w > prev.weight) prio.set(key, { kind: kind as Directive['priorities'][number]['kind'], target, weight: r2(w) });
  }
  let priorities = [...prio.values()].filter((p) => p.weight > 0);
  // la stessa potenza non può voler migliorare e isolare lo stesso Stato: resta la famiglia più pesante
  for (const t of new Set(priorities.map((p) => p.target))) {
    const mine = priorities.filter((p) => p.target === t);
    const pos = mine.filter((p) => POSITIVE.has(p.kind)); const neg = mine.filter((p) => !POSITIVE.has(p.kind));
    if (pos.length && neg.length) {
      const wp = Math.max(...pos.map((p) => p.weight)); const wn = Math.max(...neg.map((p) => p.weight));
      const drop = wp >= wn ? neg : pos;
      notes.push(`priorità contrastanti su ${t}: resta ${wp >= wn ? 'la distensione' : 'la pressione'}`);
      priorities = priorities.filter((p) => !drop.includes(p));
    }
  }
  priorities.sort((a, b) => b.weight - a.weight || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));
  if (priorities.length > L.maxPriorities) { notes.push(`${priorities.length} priorità → le ${L.maxPriorities} più pesanti`); priorities = priorities.slice(0, L.maxPriorities); }
  const total = priorities.reduce((a, p) => a + p.weight, 0);
  if (total > L.maxTotalWeight + 1e-9) {
    const k = L.maxTotalWeight / total;
    notes.push(`somma dei pesi ${r2(total)} → ${L.maxTotalWeight}`);
    priorities = priorities.map((p) => ({ ...p, weight: Math.floor(p.weight * k * 100) / 100 }));
  }

  // zone: esistenti, scarto ±0,2, al massimo 3 (i più grandi)
  const z: [string, number][] = [];
  for (const [zone, v] of Object.entries((o.zoneInterestDelta && typeof o.zoneInterestDelta === 'object' ? o.zoneInterestDelta : {}) as Record<string, unknown>)) {
    const d0 = num(v);
    if (!ctx.zones.has(zone)) { notes.push(`zona «${zone}» sconosciuta: scarto scartato`); continue; }
    if (!Number.isFinite(d0)) continue;
    const d = r2(Math.max(-L.zoneDelta, Math.min(L.zoneDelta, d0)));
    if (d !== r2(d0)) notes.push(`scarto d'interesse ${zone} ${d0} → ${d}`);
    if (d !== 0) z.push([zone, d]);
  }
  z.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]));
  if (z.length > L.maxZones) notes.push(`${z.length} zone → le ${L.maxZones} con lo scarto maggiore`);
  const zoneInterestDelta = Object.fromEntries(z.slice(0, L.maxZones));

  // accordi cercati
  const seek: Directive['seekAgreements'] = [];
  for (const x of arr(o.seekAgreements)) {
    const e = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const type = str(e.type); const w = str(e.with);
    if (!L.agreementTypes.includes(type)) { notes.push(`tipo di accordo «${type || '?'}» non ammesso: scartato`); continue; }
    if (!ok(w)) { notes.push(`controparte «${w || '?'}» inesistente: accordo ${type} scartato`); continue; }
    if (!seek.some((s) => s.type === type && s.with === w)) seek.push({ type: type as Directive['seekAgreements'][number]['type'], with: w });
  }
  if (seek.length > L.maxAgreements) notes.push(`${seek.length} accordi → i primi ${L.maxAgreements}`);

  // da evitare: esistenti, non già da avvicinare
  const avoid: string[] = [];
  for (const x of arr(o.avoid)) {
    const t = str(x);
    if (!ok(t)) { notes.push(`«${t || '?'}» da evitare inesistente: scartato`); continue; }
    if (priorities.some((p) => p.target === t && POSITIVE.has(p.kind))) { notes.push(`${t} è già da avvicinare: tolto da «da evitare»`); continue; }
    if (!avoid.includes(t)) avoid.push(t);
  }
  if (avoid.length > L.maxAvoid) notes.push(`${avoid.length} da evitare → i primi ${L.maxAvoid}`);

  const rat = words(str(o.rationale), L.rationaleWords);
  if (rat.cut) notes.push(`motivazione tagliata a ${L.rationaleWords} parole`);

  const directive = Directive.parse({
    horizonTurns, priorities, zoneInterestDelta, seekAgreements: seek.slice(0, L.maxAgreements), avoid: avoid.slice(0, L.maxAvoid), rationale: rat.text,
  });
  return { directive, notes };
}

/** Una direttiva che non cambia niente (nessuna priorità, scarto, accordo o cosa da evitare): equivale a non averne. */
export const isEmptyDirective = (d: Directive) => !d.priorities.length && !Object.keys(d.zoneInterestDelta).length && !d.seekAgreements.length && !d.avoid.length;

// ——— il contesto ———

export interface StrategistContext {
  text: string; tokens: number;
  /** gli id delle righe d'opinione nel contesto (i bersagli che il modello conosce) */
  targets: string[];
  /** quelle righe in forma strutturata (per il provider finto) e le zone nominate nel contesto */
  rows: { x: string; opinion: number; tension: number; band: string }[]; zones: string[];
}
export const estimateTokens = (text: string) => Math.ceil(text.length / P().charsPerToken);

/**
 * Il contesto della potenza, costruito **solo dalla sua FactionKnowledge** (nebbia: niente stato di terra): le 10 righe d'opinione più rilevanti
 * con le fasce (come lei vede l'altro e come l'altro vede lei), le crisi che conosce, gli incidenti degli ultimi 2 turni, i suoi trattati, il
 * capitale diplomatico e la direttiva precedente. Rilevante = opinione forte (in un senso o nell'altro), tensione, crisi o incidenti in comune,
 * trattati. Sta in `contextTokens` (1.200): se serve, si tolgono prima le righe meno importanti.
 */
export function strategistContext(k: FactionKnowledge, prev: Directive | null, names: Record<string, string> = {}): StrategistContext {
  const L = P(); const me = k.factionId;
  const nm = (x: string) => names[x] ?? x;
  const involved = new Map<string, number>();
  const bump = (x: string, v: number) => { if (x !== me) involved.set(x, (involved.get(x) ?? 0) + v); };
  for (const c of k.knownCrises.filter((c) => c.status !== 'resolved' && c.involved.includes(me))) for (const x of c.involved) bump(x, 20 + c.escalation * 2);
  const fromTurn = k.turn - L.incidentTurns;
  const incidents = k.incidents.filter((x) => x.turn >= fromTurn && x.turn < k.turn + 1);
  for (const x of incidents) { bump(x.from, 15); bump(x.to, 15); }
  const treaties = k.knownAgreements.filter((a) => a.status === 'active' && a.type !== 'secret' && a.parties.includes(me));
  for (const a of treaties) for (const x of a.parties) bump(x, 10);
  const rows = Object.entries(k.ownRelations).filter(([x]) => x !== me)
    .map(([x, r]) => ({ x, r, score: Math.abs(r.trust) * 0.5 + r.tension * 0.5 + (involved.get(x) ?? 0) }))
    .sort((a, b) => b.score - a.score || a.x.localeCompare(b.x)).slice(0, L.opinionRows);

  const build = (n: { rows: number; inc: number; tr: number; cr: number; prev: boolean }) => JSON.stringify({
    tu: { id: me, nome: k.ownFaction.name, turno: k.turn, capitaleDiplomatico: Math.round((k.diplomacy?.capital ?? 0) * 10) / 10, slotMigliorare: k.diplomacy?.improvingSlots ?? 0 },
    relazioni: rows.slice(0, n.rows).map(({ x, r }) => ({ con: x, nome: nm(x), opinione: Math.round(r.trust), fascia: opinionBand(r.trust), tiVede: r.opinionOfMe ?? null, tensione: Math.round(r.tension) })),
    crisi: k.knownCrises.filter((c) => c.status !== 'resolved').sort((a, b) => b.escalation - a.escalation || a.id.localeCompare(b.id)).slice(0, n.cr)
      .map((c) => ({ id: c.id, titolo: c.title, escalation: c.escalation, attori: c.involved.slice(0, 5), zone: c.zoneIds.slice(0, 2) })),
    incidenti: incidents.slice(0, n.inc).map((x) => ({ turno: x.turn, tipo: x.kind, da: x.from, verso: x.to, ...(x.zoneId ? { zona: x.zoneId } : {}) })),
    trattati: treaties.slice(0, n.tr).map((a) => ({ tipo: a.type, con: a.parties.filter((p) => p !== me).slice(0, 3) })),
    interessiZone: Object.fromEntries(Object.entries(k.ownFaction.policy?.zoneInterests ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6)),
    direttivaPrecedente: n.prev && prev ? { priorita: prev.priorities.map((p) => `${p.kind} ${p.target} ${p.weight}`), accordi: prev.seekAgreements.map((a) => `${a.type} con ${a.with}`), daEvitare: prev.avoid } : null,
  });
  // si stringe finché sta nel tetto: prima gli incidenti e i trattati oltre i primi, poi le righe d'opinione oltre le cinque, poi le crisi, infine la direttiva precedente
  const n = { rows: rows.length, inc: 8, tr: 8, cr: 5, prev: true };
  let text = build(n);
  const steps: (() => boolean)[] = [() => n.inc > 2 && !!(n.inc -= 1), () => n.tr > 2 && !!(n.tr -= 1), () => n.rows > 5 && !!(n.rows -= 1), () => n.cr > 2 && !!(n.cr -= 1), () => n.rows > 3 && !!(n.rows -= 1), () => n.prev && !(n.prev = false)];
  for (let guard = 0; guard < 60 && estimateTokens(text) > L.contextTokens; guard++) {
    if (!steps.some((s) => s())) break;
    text = build(n);
  }
  const shown = rows.slice(0, n.rows);
  const zones = [...new Set([...k.knownCrises.filter((c) => c.status !== 'resolved').flatMap((c) => c.zoneIds), ...Object.keys(k.ownFaction.policy?.zoneInterests ?? {})])].sort();
  return { text, tokens: estimateTokens(text), targets: shown.map((r) => r.x), rows: shown.map(({ x, r }) => ({ x, opinion: Math.round(r.trust), tension: Math.round(r.tension), band: opinionBand(r.trust) })), zones };
}
