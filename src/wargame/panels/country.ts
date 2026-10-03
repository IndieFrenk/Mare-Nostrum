import type { CountryView, DiploAction, NationDetail } from '../api-client';
import { isoOfActor, selectCountry } from '../actions';
import { h } from '../dom';
import { OPINION_LABELS, TREATY_TYPE_LABEL } from '../layers/diplomacy';
import { NAMES } from '../layers/factions';
import { newId, set, state, type UiState } from '../state/store';
import { meter } from './hud';
import { composeTo } from './letters';
import { draftCost } from './orders';

const GOVERNMENT: Record<string, string> = { democracy: 'democrazia', hybrid: 'regime ibrido', authoritarian: 'regime autoritario', absolute_monarchy: 'monarchia assoluta', theocracy: 'teocrazia', military: 'regime militare', transitional: 'fase di transizione' };
const NUCLEAR: Record<string, string> = { none: 'nessuna', latent: 'latente (potrebbe dotarsene)', declared: 'dichiarata', nato_sharing: 'ospita armi USA (condivisione NATO)' };
const STATUS: Record<string, string> = { active: 'in vigore', proposed: 'proposto', violated: 'violato', expired: 'scaduto' };
const TIE: Record<string, string> = { recalled: 'ambasciatore richiamato', expelled: 'diplomatici espulsi', broken: 'relazioni rotte' };
/** le azioni della scheda, in gruppi: i primi due aperti, gli altri a richiesta */
const GROUPS: [string, string[], boolean][] = [
  ['Relazioni', ['IMPROVE_RELATIONS', 'STOP_IMPROVE', 'DEMARCHE', 'REASSURANCE', 'BACKCHANNEL'], true],
  ['Pressione', ['THREAT', 'SANCTION', 'LIFT_SANCTION', 'ARMS_EMBARGO', 'LIFT_ARMS_EMBARGO', 'ULTIMATUM'], false],
  ['Rapporti diplomatici', ['RECALL_AMBASSADOR', 'EXPEL_DIPLOMATS', 'BREAK_RELATIONS', 'RESTORE_RELATIONS'], false],
];

const num = (n: number, digits = 1) => n.toLocaleString('it-IT', { maximumFractionDigits: n >= 100 ? 0 : digits });
/** +25 / −8 (con il segno meno vero) */
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v))}`;
const turns = (n: number) => `${n} ${n === 1 ? 'turno' : 'turni'}`;
/** Bandiera come emoji dai due caratteri ISO2 (nessuna immagine esterna); chi non ha un ISO2 non ha bandiera. */
export const flagEmoji = (iso2?: string) => (iso2 && /^[A-Z]{2}$/.test(iso2) ? String.fromCodePoint(...[...iso2].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');

const nameOf = (s: UiState, actor: string) => NAMES[actor] ?? s.nations.find((n) => (n.factionId ?? n.iso3) === actor)?.nameIt ?? actor;

/** Un motivo in stile grand strategy: «+25 Alleanza in comune», con i turni che mancano se il modificatore decade. */
const reason = (r: { label: string; value: number }, left?: number | null) => h('li', {}, h('b', { class: r.value > 0 ? 'pos' : r.value < 0 ? 'neg' : '' }, signed(r.value)), ' ', r.label, left !== undefined && left !== null ? h('small', { class: 'wg-dim' }, ` (ancora ${turns(left)})`) : null);

/** Barra dell'opinione da −100 a +100: parte dal centro, il colore è quello della fascia. */
function opinionBar(value: number, band: number) {
  const w = Math.min(100, Math.abs(value)) / 2;
  return h('div', { class: 'wg-cbar', role: 'img', 'aria-label': `opinione ${signed(value)} su una scala da −100 a +100, fascia ${OPINION_LABELS[band]}` },
    h('i', { style: `left:${value < 0 ? 50 - w : 50}%;width:${w}%;background:var(--wg-op-${band})` }), h('u', {}));
}
/** Le cinque fasce (ostile … stretta) con quella attuale in evidenza: di chi non si conosce il numero si conosce solo questa. */
function bandBar(band: number) {
  return h('div', { class: 'wg-bseg', role: 'img', 'aria-label': `fascia ${OPINION_LABELS[band]}` }, OPINION_LABELS.map((l, i) => h('i', { class: i === band ? 'on' : '', style: `background:var(--wg-op-${i})`, title: l })));
}

function opinionSection(v: CountryView) {
  const name = v.name; const out = v.opinion.out; const inn = v.opinion.in;
  const head = (text: string, value: string, band: number) => h('div', { class: 'wg-opline' }, h('span', {}, text), h('b', { style: `color:var(--wg-op-${band})` }, value));
  return h('div', { class: 'wg-op' },
    head(`L'Italia verso ${name}`, `${signed(out.value)} · ${OPINION_LABELS[out.band]}`, out.band),
    opinionBar(out.value, out.band),
    h('ul', { class: 'wg-reasons' }, out.base.map((r) => reason(r)), out.modifiers.map((m) => reason(m, m.turnsLeft))),
    inn.exact
      ? [head(`${name} verso l'Italia (intelligence)`, `${signed(inn.exact.value)} · ${OPINION_LABELS[inn.band]}`, inn.band), opinionBar(inn.exact.value, inn.band),
        h('ul', { class: 'wg-reasons' }, inn.exact.base.map((r) => reason(r)), inn.exact.modifiers.map((m) => reason(m, m.turnsLeft)))]
      : [head(`${name} verso l'Italia`, OPINION_LABELS[inn.band], inn.band), bandBar(inn.band),
        inn.known.length ? h('ul', { class: 'wg-reasons' }, inn.known.map((k) => h('li', {}, k.label, k.turnsLeft !== null ? h('small', { class: 'wg-dim' }, ` (ancora ${turns(k.turnsLeft)})`) : null))) : null,
        h('small', { class: 'wg-dim' }, 'Di come ci vede si conosce solo la fascia e gli atti pubblici; il numero esatto serve un accordo di intelligence.')],
    h('p', { class: 'wg-dim' }, `Tensione tra i due: ${num(v.tension)}/100`,
      v.ties ? ` · ${TIE[v.ties]}` : '', v.embargo.toThem ? ' · embargo sulle armi dell\'Italia' : '', v.embargo.toUs ? ' · embargo sulle armi verso l\'Italia' : '',
      v.improving ? ` · migliorare le relazioni in corso dal turno ${v.improving.since}` : ''));
}

function treatiesSection(s: UiState, v: CountryView) {
  return h('div', {},
    v.agreements.length ? h('ul', { class: 'wg-reasons' }, v.agreements.map((a) => h('li', { class: a.shared ? 'shared' : '' },
      h('b', {}, TREATY_TYPE_LABEL[a.type] ?? a.type), ` — ${a.parties.map((p) => nameOf(s, p)).join(', ')} · ${STATUS[a.status] ?? a.status}${a.endTurn !== null ? ` (fino al T${a.endTurn})` : ''}`)))
      : h('p', { class: 'wg-dim' }, 'Nessun trattato visibile.'),
    h('p', {}, v.memberships.slice(0, 12).map((m) => h('span', { class: `wg-chip${m.shared ? ' shared' : ''}`, title: `${m.nameIt}${m.shared ? ' · anche l\'Italia' : ''}` }, m.id.replace(/_/g, ' '))), v.memberships.length > 12 ? h('span', { class: 'wg-dim' }, `+${v.memberships.length - 12}`) : null));
}

/** I dati del registro con la data del dato; una stima poco affidabile (confidenza sotto 0,7) ha il segno ≈. */
function dataSection(s: UiState, d: NationDetail) {
  const est = (key: string) => (d.confidence[key] ?? 1) < 0.7;
  const row = (label: string, value: string, key?: string) => h('div', { class: 'wg-row2' }, h('span', { class: 'wg-dim' }, label),
    h('span', { title: key ? `${d.sourceLegend[d.sources[key] ?? ''] ?? d.sources[key] ?? ''} · affidabilità ${Math.round((d.confidence[key] ?? 1) * 100)}%` : undefined }, key && est(key) ? `≈ ${value}` : value));
  const name = (iso: string) => s.nations.find((n) => n.iso3 === iso)?.nameIt ?? iso;
  return h('div', { class: 'wg-nation-body' },
    row('Popolazione', `${num(d.population)} M`, 'population'), row('PIL', `${num(d.gdpUsdB, 0)} mld $`, 'gdpUsdB'),
    row('Spesa militare', d.milexUsdB > 0 ? `${num(d.milexUsdB)} mld $${d.gdpUsdB > 0 ? ` (${(d.milexUsdB / d.gdpUsdB * 100).toFixed(1)}% del PIL)` : ''}` : '—', 'milexUsdB'),
    row('Armi nucleari', NUCLEAR[d.nuclear] ?? d.nuclear),
    d.topTrade.length ? row('Partner', d.topTrade.map((t) => `${name(t.iso3)} ${Math.round(t.share * 100)}%`).join(' · '), 'topTrade') : null,
    h('small', { class: 'wg-dim' }, `Dati ${d.asOf}; ≈ = stima poco affidabile (ordine di grandezza, non misura).`));
}

/** Il giocatore può dare ordini solo nella fase PLAYER_ORDERS: le azioni della scheda aggiungono un ordine alla bozza, non lo inviano. */
function build(row: { kind: string; variant?: string; label: string }, actor: string, me: string, text: string): DiploAction {
  const id = newId('d'); const kind = row.kind; const message = text || 'Messaggio del Governo italiano.';
  if (kind === 'PROPOSE_AGREEMENT') return { id, kind, target: [actor], agreement: { type: row.variant as 'trade', parties: [me, actor], terms: text || row.label, endTurn: null, visibility: 'public' } };
  if (kind === 'ULTIMATUM') return { id, kind, target: actor, demand: text || 'Cessare gli atti ostili.', deadlineTurns: 2 };
  if (kind === 'SANCTION' || kind === 'LIFT_SANCTION') return { id, kind, target: actor, scope: text || 'misure restrittive mirate' };
  if (kind === 'BACKCHANNEL') return { id, kind, target: actor, message };
  if (kind === 'DEMARCHE' || kind === 'THREAT' || kind === 'REASSURANCE') return { id, kind, target: actor, message, visibility: 'public' };
  return { id, kind: kind as 'IMPROVE_RELATIONS', target: actor };
}

const targets = (o: DiploAction): string[] => ('target' in o ? [o.target].flat().filter((x): x is string => !!x) : []);

function actionsSection(s: UiState, v: CountryView, me: string) {
  const phaseOk = s.campaign?.phase === 'PLAYER_ORDERS';
  const left = (s.diplo?.capital.value ?? s.knowledge?.diplomacy?.capital ?? 0) - draftCost(s);
  const msg = h('input', { placeholder: 'Messaggio o richiesta (facoltativo)', 'aria-label': 'Messaggio o richiesta per l\'azione' });
  const add = (row: { kind: string; variant?: string; label: string }) => () => set({ draft: { ...state.draft, diplomacy: [...state.draft.diplomacy, build(row, v.actor, me, msg.value.trim())] }, validation: null, submitted: false });
  const inDraft = (row: { kind: string; variant?: string }) => s.draft.diplomacy.some((o) => o.kind === row.kind && targets(o).includes(v.actor) && (!row.variant || (o.kind === 'PROPOSE_AGREEMENT' && o.agreement.type === row.variant)));
  const cooldown = (kind: string) => s.diploCatalog.find((c) => c.kind === kind)?.cooldown ?? 0;
  /** un pulsante con costo e ricarica; spento con il motivo scritto accanto (e nel suggerimento) */
  const act = (row: { kind: string; variant?: string; label: string; cost: number; coercive: boolean; effects: string; cooldownUntil: number | null; available: boolean; errors: string[] }, extra?: Node | null) => {
    const drafted = inDraft(row);
    const why = !phaseOk ? `gli ordini si danno nella fase PLAYER_ORDERS (ora ${s.campaign?.phase})` : drafted ? 'già in bozza' : row.errors[0] ?? (row.cost > left + 1e-9 ? `servono ${row.cost} CD, ne restano ${num(left)} con la bozza` : '');
    const off = !!why;
    const cd = cooldown(row.kind);
    return h('div', { class: `wg-act${off ? ' off' : ''}` },
      h('button', { disabled: off, title: [row.effects, ...row.errors].join('\n'), onclick: add(row) }, row.label, ' ', h('b', {}, `${row.cost} CD`)),
      h('small', { class: 'wg-dim' }, `${row.cooldownUntil ? `in ricarica fino al T${row.cooldownUntil}` : cd > 0 ? `ricarica ${turns(cd)}` : 'senza ricarica'}${row.coercive ? ' · coercitiva' : ''}`),
      off ? h('small', { class: 'wg-why' }, why) : null, extra);
  };
  const mine = s.draft.diplomacy.filter((o) => targets(o).includes(v.actor));
  return h('div', {},
    msg,
    h('p', { class: 'wg-dim' }, `Capitale diplomatico: ${num(left)} CD disponibili dopo la bozza. Le azioni vanno nella bozza degli ordini; si inviano con «Invia ordini» o ▶.`),
    mine.length ? h('ul', { class: 'wg-draft' }, mine.map((o) => h('li', {}, `In bozza: ${s.diploCatalog.find((c) => c.kind === o.kind)?.label ?? o.kind}${o.kind === 'PROPOSE_AGREEMENT' ? ` (${TREATY_TYPE_LABEL[o.agreement.type] ?? o.agreement.type})` : ''}`,
      h('button', { 'aria-label': 'Togli dalla bozza', onclick: () => set({ draft: { ...state.draft, diplomacy: state.draft.diplomacy.filter((x) => x.id !== o.id) }, validation: null, submitted: false }) }, '×')))) : null,
    GROUPS.map(([title, kinds, open]) => h('details', { open }, h('summary', {}, title), v.actions.filter((a) => kinds.includes(a.kind)).map((a) => act(a)))),
    h('details', { open: true }, h('summary', {}, 'Proposte di trattato'),
      v.proposals.map((p) => act(p, h('div', { class: 'wg-accept' },
        h('b', { class: p.accept ? 'pos' : 'neg' }, `Accetterebbe: ${p.accept ? 'sì' : 'no'} (${signed(p.score)})`), p.exact ? null : h('small', { class: 'wg-dim' }, ' stima'),
        h('details', {}, h('summary', {}, 'perché'), h('ul', { class: 'wg-reasons' }, p.reasons.map((r) => reason(r)))))))),
    h('div', { class: 'wg-actions' },
      // le lettere si compongono verso le fazioni (il pannello Lettere elenca solo quelle)
      v.isFaction ? h('button', { onclick: () => composeTo(v.actor), title: 'Lettera formale al capo di Stato' }, '✉ Lettera') : null,
      v.isFaction ? h('button', { disabled: !phaseOk, onclick: () => set({ draft: { ...state.draft, diplomacy: [...state.draft.diplomacy, { id: newId('d'), kind: 'AID', target: v.actor, amount: 50, type: 'economic' }] }, validation: null, submitted: false }) }, 'Aiuto 50 M€') : null));
}

/** La scheda dell'Italia: postura, forze e obiettivi nazionali (non ha opinione né azioni verso sé stessa). */
function selfCard(s: UiState, close: HTMLElement) {
  const k = s.knowledge;
  return h('div', { class: 'wg-float wg-country wg-cc' }, h('header', {}, h('span', { 'aria-hidden': 'true' }, flagEmoji('IT')), 'ITALIA', close),
    k ? [h('p', {}, `Postura ${k.ownFaction.posture}/5 · stabilità ${k.ownFaction.stability} · credibilità ${k.ownFaction.credibility}`),
      h('p', {}, `${k.ownUnits.filter((u) => u.status === 'deployed' || u.status === 'transit').length} unità schierate su ${k.ownUnits.length}`),
      s.diplo ? h('p', {}, `Capitale diplomatico ${num(s.diplo.capital.value)} CD (+${num(s.diplo.capital.rent)} a settimana) · slot «migliorare le relazioni» ${s.diplo.capital.improving.length}/${s.diplo.capital.improvingSlots}`) : null,
      s.diplo?.agreements.length ? [h('h4', {}, 'Trattati'), h('ul', { class: 'wg-reasons' }, s.diplo.agreements.map((a) => h('li', {}, h('b', {}, TREATY_TYPE_LABEL[a.type] ?? a.type), ` — ${a.parties.filter((p) => p !== k.factionId).map((p) => nameOf(s, p)).join(', ')} · ${STATUS[a.status] ?? a.status}`)))] : null,
      h('h4', {}, 'Obiettivi nazionali'),
      h('div', { class: 'wg-meters' }, k.ownFaction.objectives.map((o) => meter(`P${o.priority} ${o.text}`, Math.round(o.progress * 100), 0, 100))),
      k.ownFaction.redLines.length ? h('p', { class: 'wg-dim' }, `Linee rosse: ${k.ownFaction.redLines.map((r) => r.text).join('; ')}`) : null] : null);
}

/**
 * Scheda paese per tutti i 197 Stati (clic sulla mappa o dall'elenco «Stati»): intestazione, opinione nei due sensi con i motivi, trattati e
 * appartenenze, azioni con costo in CD e accettazione stimata, dati del registro. Opinione, trattati e azioni vengono dal server dal punto di
 * vista dell'Italia (nebbia di guerra): qui non si calcola nulla.
 */
export function countryCard(s: UiState, actor: string) {
  const me = s.campaign?.playerFaction ?? 'ITA';
  const close = h('button', { 'aria-label': 'Chiudi la scheda', onclick: () => selectCountry(null) }, '×');
  if (actor === me) return selfCard(s, close);
  const iso = isoOfActor(actor);
  const sum = iso ? s.nations.find((n) => n.iso3 === iso) : undefined;
  const d: NationDetail | undefined = iso ? s.nationDetail[iso] : undefined;
  const v = s.countryDiplo?.actor === actor ? s.countryDiplo : null;
  const name = v?.name ?? sum?.nameIt ?? NAMES[actor] ?? actor;
  const flag = flagEmoji(v?.iso2 ?? d?.iso2);
  const row = (label: string, value: string) => h('div', { class: 'wg-row2' }, h('span', { class: 'wg-dim' }, label), h('span', {}, value));
  return h('div', { class: 'wg-float wg-country wg-cc' },
    h('header', {}, flag ? h('span', { 'aria-hidden': 'true' }, flag) : null, name.toUpperCase(), close),
    d ? h('div', { class: 'wg-nation-body' }, row('Capo di Stato', d.leaderTitle), row('Governo', `${GOVERNMENT[d.government] ?? d.government} (democrazia ${d.democracyScore.toFixed(1)}/10)`), row('Capitale', d.capital))
      : sum ? h('p', { class: 'wg-dim' }, GOVERNMENT[sum.government] ?? sum.government) : null,
    h('h4', {}, 'Opinione'), v ? opinionSection(v) : h('p', { class: 'wg-dim' }, 'Caricamento…'),
    h('h4', {}, 'Trattati e appartenenze'), v ? treatiesSection(s, v) : null,
    h('h4', {}, 'Azioni'), v ? actionsSection(s, v, me) : h('p', { class: 'wg-dim' }, 'Caricamento…'),
    h('h4', {}, 'Dati'), d ? dataSection(s, d) : h('p', { class: 'wg-dim' }, iso ? 'Caricamento…' : 'Attore non statale: nessun dato di registro.'));
}
