import { h } from '../dom';
import type { FactionKnowledge } from '../api-client';
import { NAMES } from '../layers/factions';
import type { UiState } from '../state/store';

const heat = (v: number, max: number, invert = false) => {
  const t = Math.max(-1, Math.min(1, v / max)) * (invert ? -1 : 1);
  return `background: ${t >= 0 ? `rgba(60,190,120,${t * 0.6})` : `rgba(230,70,70,${-t * 0.6})`}`;
};

const TIE = { recalled: 'ambasciatore richiamato', expelled: 'diplomatici espulsi', broken: 'relazioni rotte' } as const;
const n1 = (n: number) => n.toLocaleString('it-IT', { maximumFractionDigits: 1 });
const turns = (n: number) => `${n} ${n === 1 ? 'turno' : 'turni'}`;
const nameOf = (s: UiState, a: string) => NAMES[a] ?? s.nations.find((n) => (n.factionId ?? n.iso3) === a)?.nameIt ?? a;

/**
 * Capitale diplomatico, slot di «Migliorare le relazioni» (con chi e da quando) e ultimatum in corso con il conto alla rovescia: dalla panoramica
 * diplomatica del server (`/diplomacy/overview`, dalla Knowledge dell'Italia).
 */
function today(s: UiState) {
  const d = s.diplo;
  if (!d) return null;
  const c = d.capital;
  return h('div', { class: 'wg-card' },
    h('p', {}, h('b', {}, `Capitale diplomatico ${n1(c.value)} CD`), ` (+${n1(c.rent)} a settimana, +${n1(c.rent * c.weeks)} a turno)`),
    h('p', {}, h('b', {}, `Slot «Migliorare le relazioni»: ${c.improving.length}/${c.improvingSlots}`), c.improving.length ? ' — ' : '',
      c.improving.map((x) => `${nameOf(s, x.target)} (dal T${x.since})`).join(', '), c.improving.length < c.improvingSlots ? h('span', { class: 'wg-dim' }, `${c.improving.length ? ' · ' : ' '}${c.improvingSlots - c.improving.length} liberi (1 CD a turno ciascuno)`) : h('span', { class: 'wg-warn' }, ' · slot esauriti: serve «Smettere di migliorare le relazioni»')),
    d.ultimatums.length ? h('div', {}, h('h4', {}, 'Ultimatum'), h('ul', {}, d.ultimatums.map((u) => h('li', {},
      `${nameOf(s, u.from)} → ${nameOf(s, u.to)}: «${u.demand}» · `,
      u.status === 'pending' ? h('b', { class: 'wg-warn' }, u.turnsLeft !== null && u.turnsLeft > 0 ? `scade tra ${turns(u.turnsLeft)} (T${u.deadlineTurn})` : `scade al T${u.deadlineTurn}`)
        : h('span', {}, `scaduto: ${u.from === s.campaign?.playerFaction ? 'la forza è legittima' : 'la forza contro di noi è legittimata'}${u.turnsLeft !== null && u.turnsLeft >= 0 ? ` ancora per ${turns(u.turnsLeft)}` : ''}`))))) : h('p', { class: 'wg-dim' }, 'Nessun ultimatum in corso.'));
}

/** Rapporti ridotti, embarghi, ricariche e come risponderebbe il decisore alle proposte ricevute. */
function registry(d: NonNullable<FactionKnowledge['diplomacy']>) {
  const cooldowns = Object.entries(d.cooldowns).sort(([a], [b]) => a.localeCompare(b));
  return h('div', { class: 'wg-card' },
    Object.keys(d.ties).length ? h('p', { class: 'wg-warn' }, `Rapporti ridotti: ${Object.entries(d.ties).map(([f, st]) => `${f} — ${TIE[st]}`).join(', ')}`) : null,
    d.embargoes.length ? h('p', { class: 'wg-dim' }, `Embarghi sulle armi: ${d.embargoes.map((x) => x.replace('>', ' → ')).join(', ')}`) : null,
    cooldowns.length ? h('p', { class: 'wg-dim' }, `In ricarica: ${cooldowns.map(([k, until]) => `${k.replace('|', ' → ')} (T${until})`).join(', ')}`) : null,
    d.proposals.length ? h('div', {}, h('h4', {}, 'Proposte ricevute'), d.proposals.map((p) => h('details', {}, h('summary', {}, `${p.agreementId} · ${p.type} da ${p.from}: il decisore ${p.accept ? 'accetterebbe' : 'rifiuterebbe'} (punteggio ${p.score})`), h('ul', {}, p.reasons.map((r) => h('li', {}, `${r.value > 0 ? '+' : ''}${r.value} ${r.label}`)))))) : null);
}

export function diplomacyPanel(s: UiState) {
  const rel = s.overview?.relations ?? {};
  const k = s.knowledge;
  return h('div', {},
    h('p', { class: 'wg-dim' }, 'Le azioni diplomatiche si compongono nella scheda di ogni paese e nella Console Ordini.'),
    today(s),
    k?.diplomacy ? registry(k.diplomacy) : null,
    h('table', { class: 'wg-table' }, h('tr', {}, h('th', {}, 'Italia ↔'), h('th', {}, 'Fiducia'), h('th', {}, 'Tensione'), h('th', {}, 'Ultimo incidente')),
      Object.entries(rel).sort((a, b) => b[1].tension - a[1].tension).map(([f, r]) => h('tr', {}, h('td', {}, f), h('td', { style: heat(r.trust, 100) }, r.trust), h('td', { style: heat(r.tension - 30, 70, true) }, r.tension), h('td', {}, r.lastIncidentTurn === null ? '—' : `T${r.lastIncidentTurn}`)))),
    h('h4', {}, 'Accordi noti'),
    h('ul', {}, (k?.knownAgreements ?? []).map((a) => h('li', {}, `${a.id} · ${a.type} · ${a.parties.join('/')} · ${a.status} — ${a.terms}`))),
    h('h4', {}, 'Messaggi ricevuti'),
    h('ul', {}, (k?.inbox ?? []).map((m) => h('li', {}, `[${m.channel}] ${m.from}: ${m.text}`))));
}
