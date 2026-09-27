import type { DiploAction, PublicStatement } from '../schemas/index.js';
import type { TurnCtx } from './context.js';

const PERMANENT = ['USA', 'GBR', 'FRA', 'RUS', 'CHN'];

function message(ctx: TurnCtx, from: string, to: string, text: string, channel: 'official' | 'backchannel', actionRef: string) {
  ctx.emit('DIPLO_MESSAGE', from, { message: { id: `M-${ctx.turn}-${actionRef}-${to}`, turn: ctx.turn, from, to, channel, text, actionRef } },
    { targets: [to], visibility: channel === 'backchannel' ? [from, to] : 'public' });
}

export function resolveDiplomacy(ctx: TurnCtx, actor: string, a: DiploAction) {
  const s = ctx.state;
  const cause = { causedBy: { orderId: a.id } };
  switch (a.kind) {
    case 'DEMARCHE': ctx.relate(actor, a.target, -2, 3, `démarche: ${a.message}`, { propagate: false }); message(ctx, actor, a.target, a.message, 'official', a.id); break;
    case 'THREAT':
      ctx.relate(actor, a.target, -6, 10, `minaccia: ${a.message}`);
      ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: 1 }, pendingThreat: { target: a.target, turn: ctx.turn } }, cause);
      message(ctx, actor, a.target, a.message, 'official', a.id); break;
    case 'REASSURANCE': ctx.relate(actor, a.target, 3, -5, 'rassicurazione', { propagate: false }); message(ctx, actor, a.target, a.message, 'official', a.id); break;
    case 'BACKCHANNEL': ctx.relate(actor, a.target, 2, -2, 'canale riservato', { propagate: false, visibility: [actor, a.target] }); message(ctx, actor, a.target, a.message, 'backchannel', a.id); break;
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
      for (const p of ag.parties) if (p !== actor) ctx.relate(actor, p, a.response === 'accept' ? 8 : a.response === 'reject' ? -4 : 0, a.response === 'accept' ? -5 : 2, `risposta ad accordo ${ag.id}: ${a.response}`, { propagate: false });
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
