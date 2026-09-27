import type { DiceRoll } from '../schemas/index.js';

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** mulberry32 con cursore: lo stato si ripristina da (seed, cursor). */
export class Rng {
  private state: number;
  cursor = 0;
  readonly rolls: DiceRoll[] = [];

  constructor(readonly seed: string, cursor = 0, private turn = 0) {
    this.state = hashString(seed);
    for (let i = 0; i < cursor; i++) this.next();
  }

  setTurn(turn: number) { this.turn = turn; }

  next(): number {
    this.cursor++;
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number) { return min + Math.floor(this.next() * (max - min + 1)); }

  pick<T>(items: T[]): T { return items[this.int(0, items.length - 1)]; }

  /** Tira una formula "NdM+K", "dM" o "p=0.35" e registra il tiro. */
  roll(purpose: string, formula: string, opts: { modifiers?: { name: string; value: number }[]; threshold?: number; outcome?: (total: number) => string } = {}): DiceRoll {
    const rngIndex = this.cursor;
    const modifiers = opts.modifiers ?? [];
    const modSum = modifiers.reduce((a, m) => a + m.value, 0);
    let raw: number[]; let total: number; let outcome: string;
    const p = formula.match(/^p=([\d.]+)$/);
    if (p) {
      const prob = Math.min(1, Math.max(0, Number(p[1]) + modSum));
      raw = [this.next()]; total = raw[0];
      outcome = total < prob ? 'success' : 'failure';
    } else {
      const m = formula.match(/^(\d*)d(\d+)([+-]\d+)?$/);
      if (!m) throw new Error(`formula dado non valida: ${formula}`);
      const n = Number(m[1] || 1); const sides = Number(m[2]);
      raw = Array.from({ length: n }, () => this.int(1, sides));
      total = raw.reduce((a, b) => a + b, 0) + Number(m[3] ?? 0) + modSum;
      outcome = opts.outcome ? opts.outcome(total)
        : opts.threshold === undefined ? 'rolled'
        : sides === 100 && n === 1 && raw[0] <= 5 ? 'critical_success'
        : sides === 100 && n === 1 && raw[0] >= 96 ? 'critical_failure'
        : total <= opts.threshold ? 'success' : 'failure';
    }
    const roll: DiceRoll = { id: `R${this.turn}-${rngIndex}`, turn: this.turn, rngIndex, purpose, formula, modifiers, raw, total, threshold: opts.threshold, outcome };
    this.rolls.push(roll);
    return roll;
  }

  chance(purpose: string, p: number, modifiers?: { name: string; value: number }[]) {
    const r = this.roll(purpose, `p=${Math.round(p * 1000) / 1000}`, { modifiers });
    return { ok: r.outcome === 'success', roll: r };
  }
}
