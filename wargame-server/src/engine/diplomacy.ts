import type { DiploAction, DiploLetter, LetterAction, LetterTone, PublicStatement, WorldState } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { deescalateByAgreement } from './crises.js';

const PERMANENT = ['USA', 'GBR', 'FRA', 'RUS', 'CHN'];

function message(ctx: TurnCtx, from: string, to: string, text: string, channel: 'official' | 'backchannel', actionRef: string) {
  ctx.emit('DIPLO_MESSAGE', from, { message: { id: `M-${ctx.turn}-${actionRef}-${to}`, turn: ctx.turn, from, to, channel, text, actionRef } },
    { targets: [to], visibility: channel === 'backchannel' ? [from, to] : 'public' });
}

/**
 * Effetti deterministici del tono di una lettera (trust, tension), più lievi delle azioni formali corrispondenti:
 * conciliante ≈ REASSURANCE, ferma ≈ DEMARCHE, minacciosa ≈ THREAT (e come THREAT registra una minaccia da verificare).
 */
export const LETTER_TONE_EFFECTS: Record<LetterTone, { trust: number; tension: number }> = {
  cordial: { trust: 2, tension: -2 },
  conciliatory: { trust: 3, tension: -4 },
  formal: { trust: 1, tension: -1 },
  firm: { trust: -1, tension: 2 },
  threatening: { trust: -5, tension: 8 },
};

/** Carica e città di una fazione per intestazione e firma (mai nomi di persona). */
export function leaderOf(s: WorldState, f: string) {
  const x = s.factions[f];
  return { title: x?.leaderTitle || `Il Capo di Stato (${x?.name ?? f})`, capital: x?.capital || x?.name || f };
}

/** La lettera come viene archiviata: intestazioni dal mondo, fonte dall'ordine. */
export function letterRecord(ctx: TurnCtx, actor: string, a: LetterAction): DiploLetter {
  const from = leaderOf(ctx.state, actor); const to = leaderOf(ctx.state, a.target);
  const source = actor === ctx.campaign.playerFaction ? 'human' : a.model === 'template' ? 'template' : 'ai';
  return {
    id: `LT${ctx.turn}-${actor}-${a.id.replace(`${actor}-${ctx.turn}-`, '')}`, turn: ctx.turn, date: ctx.state.date, from: actor, to: a.target,
    fromTitle: from.title, toTitle: to.title, place: from.capital, subject: a.subject.trim(), body: a.body.trim(), tone: a.tone, visibility: a.visibility,
    ...(a.inReplyTo ? { inReplyTo: a.inReplyTo } : {}), source, ...(source !== 'human' && a.model ? { model: a.model } : {}),
  };
}

function resolveLetter(ctx: TurnCtx, actor: string, a: LetterAction) {
  const letter = letterRecord(ctx, actor, a);
  const visibility = a.visibility === 'public' ? 'public' as const : [actor, a.target];
  const cause = { causedBy: { orderId: a.id } };
  ctx.emit('LETTER_SENT', actor, { letter }, { targets: [a.target], visibility, ...cause });
  const fx = LETTER_TONE_EFFECTS[a.tone];
  ctx.relate(actor, a.target, fx.trust, fx.tension, `lettera (${a.tone}): ${letter.subject}`, { propagate: a.tone === 'threatening', visibility, detente: a.tone === 'cordial' || a.tone === 'conciliatory' });
  if (a.tone === 'threatening') ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: 1 }, pendingThreat: { target: a.target, turn: ctx.turn } }, { visibility, ...cause });
  if (a.visibility === 'public') ctx.emit('STATEMENT', actor, { text: letter.subject, tone: a.tone, audience: a.target, letterId: letter.id }, cause);
}

export function resolveDiplomacy(ctx: TurnCtx, actor: string, a: DiploAction) {
  const s = ctx.state;
  const cause = { causedBy: { orderId: a.id } };
  switch (a.kind) {
    case 'LETTER': resolveLetter(ctx, actor, a); break;
    case 'DEMARCHE': ctx.relate(actor, a.target, -2, 3, `démarche: ${a.message}`, { propagate: false }); message(ctx, actor, a.target, a.message, 'official', a.id); break;
    case 'THREAT':
      ctx.relate(actor, a.target, -6, 10, `minaccia: ${a.message}`);
      ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: 1 }, pendingThreat: { target: a.target, turn: ctx.turn } }, cause);
      message(ctx, actor, a.target, a.message, 'official', a.id); break;
    case 'REASSURANCE': ctx.relate(actor, a.target, 3, -5, 'rassicurazione', { propagate: false, detente: true }); message(ctx, actor, a.target, a.message, 'official', a.id); break;
    case 'BACKCHANNEL': ctx.relate(actor, a.target, 2, -2, 'canale riservato', { propagate: false, visibility: [actor, a.target], detente: true }); message(ctx, actor, a.target, a.message, 'backchannel', a.id); break;
    case 'PROPOSE_AGREEMENT': {
      const agreement = { ...a.agreement, id: `AG-${ctx.turn}-${actor}-${a.id}`, parties: [...new Set([actor, ...a.target, ...a.agreement.parties])], startTurn: ctx.turn, status: 'proposed' as const };
      ctx.emit('AGREEMENT_CHANGED', actor, { agreement }, { targets: a.target, visibility: agreement.visibility === 'public' ? 'public' : agreement.parties, ...cause });
      for (const t of a.target) message(ctx, actor, t, `Proposta di accordo ${agreement.type}: ${agreement.terms} [${agreement.id}]`, agreement.visibility === 'public' ? 'official' : 'backchannel', a.id);
      break;
    }
    case 'RESPOND_AGREEMENT': {
      const ag = s.agreements[a.agreementId];
      if (!ag || !ag.parties.includes(actor) || ag.status !== 'proposed') break;
      const status = a.response === 'accept' ? 'active' : a.response === 'reject' ? 'expired' : 'proposed';
      ctx.emit('AGREEMENT_CHANGED', actor, { agreement: { ...ag, status, terms: a.counterTerms ?? ag.terms } }, { targets: ag.parties, visibility: ag.visibility, ...cause });
      for (const p of ag.parties) if (p !== actor) ctx.relate(actor, p, a.response === 'accept' ? 8 : a.response === 'reject' ? -4 : 0, a.response === 'accept' ? -5 : 2, `risposta ad accordo ${ag.id}: ${a.response}`, { propagate: false, detente: a.response === 'accept' });
      if (status === 'active') deescalateByAgreement(ctx, ag);
      break;
    }
    case 'SANCTION':
    case 'LIFT_SANCTION': {
      const k = a.kind === 'SANCTION' ? 1 : -0.5;
      ctx.relate(actor, a.target, -15 * k, 10 * k, `${a.kind === 'SANCTION' ? 'sanzioni' : 'revoca sanzioni'}: ${a.scope}`);
      ctx.emit('FACTION_CHANGED', actor, { factionId: a.target, delta: { stability: -2 * k } }, cause);
      break;
    }
    case 'NATO_ART4':
    case 'EU_COUNCIL':
    case 'UNSC_DRAFT': {
      const members = a.kind === 'UNSC_DRAFT' ? PERMANENT : Object.values(s.factions).filter((f) => f.alliances.includes(a.kind === 'NATO_ART4' ? 'NATO' : 'EU')).map((f) => f.id);
      const votes = members.filter((m) => m !== actor).map((m) => ({ m, yes: (s.relations[m]?.[actor]?.trust ?? 0) >= 20, veto: a.kind === 'UNSC_DRAFT' && (s.relations[m]?.[actor]?.trust ?? 0) < -20 }));
      const yes = votes.filter((v) => v.yes).length;
      const passed = !votes.some((v) => v.veto) && yes >= Math.ceil(votes.length / 2);
      ctx.emit('STATEMENT', a.kind === 'UNSC_DRAFT' ? 'UNSC' : a.kind === 'NATO_ART4' ? 'NATO' : 'EU', { kind: a.kind, subject: a.subject, requester: actor, passed, yes, total: votes.length, vetoes: votes.filter((v) => v.veto).map((v) => v.m) }, cause);
      ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: passed ? 3 : -2 } }, cause);
      break;
    }
    case 'ENERGY_DEAL': {
      const agreement = { id: `AG-${ctx.turn}-${actor}-${a.id}`, type: 'energy' as const, parties: [actor, a.target], terms: `${a.infrastructureId}: ${a.terms}`, startTurn: ctx.turn, endTurn: null, visibility: 'public' as const, status: 'proposed' as const };
      ctx.emit('AGREEMENT_CHANGED', actor, { agreement }, { targets: [a.target], ...cause });
      message(ctx, actor, a.target, `Proposta energetica su ${a.infrastructureId}: ${a.terms} [${agreement.id}]`, 'official', a.id);
      break;
    }
    case 'AID': {
      ctx.spend(actor, -a.amount, 'diplomacy', a.id, `Aiuto ${a.type} a ${a.target}`);
      if (s.factions[a.target].kind !== 'bloc') ctx.spend(a.target, a.amount, 'income', a.id, `Aiuto ${a.type} da ${actor}`);
      ctx.relate(actor, a.target, Math.min(15, a.amount / 10), -3, `aiuto ${a.type}`, { propagate: false });
      break;
    }
  }
}

export function resolveStatement(ctx: TurnCtx, actor: string, st: PublicStatement) {
  ctx.emit('STATEMENT', actor, { text: st.text, tone: st.tone, audience: st.audience }, { causedBy: { orderId: st.id } });
  const target = ctx.state.factions[st.audience] ? st.audience : null;
  if (st.tone === 'threatening') {
    ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: 1 } });
    if (target) ctx.relate(actor, target, -3, 3, 'dichiarazione minacciosa', { propagate: false });
  } else if (st.tone === 'conciliatory' && target) ctx.relate(actor, target, 2, -2, 'dichiarazione conciliante', { propagate: false });
}
