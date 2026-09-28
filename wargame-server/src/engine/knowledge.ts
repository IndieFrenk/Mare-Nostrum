import type { Contact, DiploLetter, DiploMessage, FactionKnowledge, IntelReport, NewsItem, WorldState } from '../schemas/index.js';
import { hashString } from './rng.js';

const INTENT = ['guerra aperta', 'confronto armato limitato', 'coercizione', 'competizione', 'cooperazione'];

/** Rimuove ogni riferimento alla verità di terra prima che il contatto lasci il motore. */
export function stripContact({ truthUnitId: _t, ...c }: Contact): Omit<Contact, 'truthUnitId'> {
  return c;
}

export const letterVisibleTo = (l: DiploLetter, f: string) => l.visibility === 'public' || l.from === f || l.to === f;

export function buildKnowledge(s: WorldState, factionId: string, contacts: Contact[], extra: { inbox: DiploMessage[]; news: NewsItem[]; reports?: IntelReport[]; letters?: DiploLetter[] }): FactionKnowledge {
  const f = s.factions[factionId];
  const beliefs: FactionKnowledge['beliefs'] = {};
  for (const o of Object.values(s.factions)) {
    if (o.id === factionId || o.kind === 'bloc') continue;
    const noise = (hashString(`${factionId}:${o.id}:${s.turn}`) % 3) - 1;
    const est = Math.max(1, Math.min(5, o.posture + noise));
    beliefs[o.id] = { estPosture: est, estIntent: INTENT[est - 1], confidence: noise === 0 ? 0.6 : 0.4 };
  }
  return {
    schemaVersion: 1, factionId, turn: s.turn,
    ownUnits: Object.values(s.units).filter((u) => u.factionId === factionId),
    ownFaction: f,
    contacts: contacts.map(stripContact),
    intelReports: extra.reports ?? [],
    beliefs,
    knownCrises: Object.values(s.crises).filter((c) => c.status !== 'latent' || c.involved.includes(factionId))
      .map((c) => ({ ...c, escalation: Math.round(c.escalation), history: c.history.slice(-3) })),
    knownAgreements: Object.values(s.agreements).filter((a) => a.visibility === 'public' || a.visibility.includes(factionId) || a.parties.includes(factionId)),
    inbox: extra.inbox.filter((m) => m.to === factionId),
    publicNews: extra.news,
    letters: (extra.letters ?? []).filter((l) => letterVisibleTo(l, factionId) && l.turn >= s.turn - 3),
  };
}
