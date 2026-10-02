import type { DiploAction, WorldDecision } from '../schemas/index.js';
import { LETTER_LIMITS } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { checkAction, isActor, targetsOf } from './diplo-actions.js';
import { resolveDiplomacy } from './diplomacy.js';
import { buildModifier } from './opinion.js';
import { PARAMS } from './params.js';

/** Errori di una azione di uno Stato del mondo: gli stessi prerequisiti del catalogo, ma senza capitale (l'agenda è a tetto). */
export function worldActionErrors(ctx: TurnCtx, actor: string, a: DiploAction): string[] {
  const s = ctx.state;
  const errs: string[] = [];
  if (!isActor(s, actor) || s.factions[actor]) errs.push(`${actor} non è uno Stato del mondo`);
  for (const t of targetsOf(a)) if (!isActor(s, t)) errs.push(`destinatario ${t} sconosciuto`); else if (t === actor && a.kind !== 'PROPOSE_AGREEMENT') errs.push('azione rivolta a sé stessi');
  if (a.kind === 'LETTER') {
    if (!s.factions[a.target] || s.factions[a.target]!.kind === 'bloc') errs.push(`${a.target} non ha un capo di Stato a cui scrivere`);
    if (!a.subject.trim() || a.subject.length > LETTER_LIMITS.subject || !a.body.trim() || a.body.length > LETTER_LIMITS.body) errs.push('oggetto o testo della lettera non validi');
    return errs;
  }
  return [...errs, ...checkAction(s, actor, a)];
}

/**
 * Esegue le decisioni del livello C nell'aggiudicazione: le reazioni agli atti gravi (un evento INTERNATIONAL_REACTIONS ciascuna, con i modificatori
 * aggregati), le sanzioni di blocco (un evento per risoluzione) e le azioni dell'agenda lenta e le lettere, validate di nuovo sullo stato di
 * adesso e risolte con le stesse funzioni delle fazioni. Restituisce le azioni rifiutate.
 */
export function applyWorldDecision(ctx: TurnCtx, w: WorldDecision): { factionId: string; id: string; errors: string[] }[] {
  const s = ctx.state;
  for (const r of w.reactions) {
    const modifiers = r.modifiers.map((m) => buildModifier(s, { kind: m.kind, label: PARAMS.opinion.modifiers[m.kind]!.label, from: m.from, to: m.to, value: m.value, turn: ctx.turn, act: `RX-${r.eventId}`, causeRef: r.eventId, visibility: 'public' }));
    ctx.emit('INTERNATIONAL_REACTIONS', 'world', {
      eventRef: r.eventId, kind: r.kind, actor: r.actor, victim: r.victim, severity: r.severity, ...(r.zoneId ? { zoneId: r.zoneId } : {}),
      condemn: r.condemn, support: r.support, silent: r.silent, modifiers,
    }, { targets: [r.actor, r.victim], visibility: 'public' });
  }
  for (const b of w.blockSanctions) {
    const def = PARAMS.opinion.modifiers.sanction!;
    // sanzioni di blocco: come le sanzioni (un modificatore per coppia che si accumula), uno solo per Stato che si adegua, in un evento solo
    const modifiers = b.adopters.map((iso) => buildModifier(s, { kind: 'sanction', label: def.label, from: b.target, to: iso, value: PARAMS.worldAi.blockSanctions.opinion, turn: ctx.turn, act: `BS-${b.voteId}`, causeRef: b.voteId, visibility: 'public' }));
    ctx.emit('INTERNATIONAL_REACTIONS', 'world', { eventRef: b.voteId, kind: 'block_sanctions', actor: 'world', victim: b.target, adopters: b.adopters, holdouts: b.holdouts, modifiers }, { targets: [b.target], visibility: 'public' });
    const SS = PARAMS.worldAi.blockSanctions.stability;
    if (s.factions[b.target]) ctx.emit('FACTION_CHANGED', 'world', { factionId: b.target, delta: { stability: -Math.min(SS.max, Math.ceil(b.adopters.length / SS.perAdopters)) } }, { visibility: 'public' });
  }
  const rejected: { factionId: string; id: string; errors: string[] }[] = [];
  for (const { actor, action } of w.actions) {
    const errors = worldActionErrors(ctx, actor, action);
    if (errors.length) { rejected.push({ factionId: actor, id: action.id, errors }); continue; }
    resolveDiplomacy(ctx, actor, action);
  }
  return rejected;
}
