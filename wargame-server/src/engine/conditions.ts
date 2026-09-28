import type { WorldState } from '../schemas/index.js';

/**
 * Mini-DSL per obiettivi e linee rosse. Termini:
 *   crisis(ID).escalation · infra(ID).status · relation(A,B).tension|trust · faction(ID).stability|credibility|posture
 *   units(FACTION, ZONE) · indicator(nome)
 * Operatori: >= <= > < == != ; combinazioni con && e ||.
 */
export function evaluate(s: WorldState, expr: string): boolean {
  return expr.split('||').some((or) => or.split('&&').every((t) => term(s, t.trim())));
}

function term(s: WorldState, t: string): boolean {
  const m = t.match(/^(.+?)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
  if (!m) return false;
  const lhs = value(s, m[1].trim());
  const rhs = isNaN(Number(m[3])) ? m[3].trim() : Number(m[3]);
  switch (m[2]) {
    case '>=': return (lhs as number) >= (rhs as number);
    case '<=': return (lhs as number) <= (rhs as number);
    case '>': return (lhs as number) > (rhs as number);
    case '<': return (lhs as number) < (rhs as number);
    case '==': return lhs === rhs;
    default: return lhs !== rhs;
  }
}

function value(s: WorldState, v: string): number | string | undefined {
  let m: RegExpMatchArray | null;
  if ((m = v.match(/^crisis\((\w+)\)\.(\w+)$/))) return (s.crises[m[1]] as any)?.[m[2]];
  if ((m = v.match(/^infra\((\w+)\)\.(\w+)$/))) return (s.infrastructure[m[1]] as any)?.[m[2]];
  if ((m = v.match(/^relation\((\w+),\s*(\w+)\)\.(\w+)$/))) return (s.relations[m[1]]?.[m[2]] as any)?.[m[3]];
  if ((m = v.match(/^faction\((\w+)\)\.(\w+)$/))) return (s.factions[m[1]] as any)?.[m[2]];
  if ((m = v.match(/^units\((\w+),\s*(\w+)\)$/))) return Object.values(s.units).filter((u) => u.factionId === m![1] && u.zoneId === m![2] && u.status === 'deployed').length;
  if ((m = v.match(/^indicator\((\w+)\)$/))) return (s.globalIndicators as any)[m[1]];
  return undefined;
}
