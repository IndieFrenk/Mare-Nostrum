import type { DiploLetter, LetterAction, LetterTone } from '../api-client';
import { draftLetter, markLettersSeen, queueLetter } from '../actions';
import { h, select } from '../dom';
import { NAMES } from '../layers/factions';
import { newId, set, state, type UiState } from '../state/store';

const LIMITS = { subject: 120, body: 1800, gist: 300, perTurn: 2 };
export const TONES: [LetterTone, string][] = [['cordial', 'cordiale'], ['formal', 'formale'], ['conciliatory', 'conciliante'], ['firm', 'ferma'], ['threatening', 'minacciosa']];
const toneLabel = (t: string) => TONES.find(([k]) => k === t)?.[1] ?? t;
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
/** «2026-03-09» → «9 marzo 2026» */
export const italianDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`; };
const name = (f: string) => NAMES[f] ?? f;
/** «Il Presidente …» → «al Presidente …» (complemento di termine per destinatario e intestazioni) */
const toTitle = (t: string) => (/^Il /.test(t) ? t.replace(/^Il /, 'al ') : /^La /.test(t) ? t.replace(/^La /, 'alla ') : `a ${t}`);

/** Stato locale del pannello: sopravvive ai ridisegni (il testo digitato non sta nello store globale). */
const ui = {
  thread: null as string | null,
  open: null as string | null,
  compose: null as null | { target: string; tone: LetterTone; subject: string; body: string; gist: string; visibility: 'private' | 'public'; inReplyTo?: string; note?: string },
};

/** Interlocutore di una lettera per il giocatore; le lettere pubbliche tra altri finiscono in «pubbliche». */
const party = (l: DiploLetter, me: string) => (l.from === me ? l.to : l.to === me ? l.from : 'PUBBLICHE');

export function queuedLetters(s: UiState) {
  return s.draft.diplomacy.filter((d): d is LetterAction => d.kind === 'LETTER');
}

/** Foglio della lettera: carta chiara dentro il tema scuro, intestazione e firma con la sola carica. */
export function letterSheet(l: Pick<DiploLetter, 'fromTitle' | 'toTitle' | 'place' | 'date' | 'subject' | 'body' | 'tone' | 'visibility'> & { source?: string }) {
  return h('article', { class: 'wg-letter' },
    h('div', { class: 'wg-letter-head' }, h('span', { class: 'wg-letter-from' }, l.fromTitle), h('span', { class: 'wg-letter-date' }, `${l.place}, ${italianDate(l.date)}`)),
    h('div', { class: 'wg-letter-tags' },
      h('span', { class: `wg-letter-tag ${l.visibility}` }, l.visibility === 'public' ? 'pubblica' : 'riservata'),
      h('span', { class: 'wg-letter-tag' }, `tono ${toneLabel(l.tone)}`),
      l.source === 'template' ? h('span', { class: 'wg-letter-tag', title: 'Il consigliere non ha prodotto un testo valido: lettera-modello' }, 'lettera-modello') : null),
    h('p', { class: 'wg-letter-to' }, toTitle(l.toTitle).replace(/^./, (c) => c.toUpperCase())),
    h('p', { class: 'wg-letter-subject' }, h('b', {}, 'Oggetto: '), l.subject),
    h('div', { class: 'wg-letter-body' }, l.body.split(/\n+/).map((p) => h('p', {}, p))),
    h('p', { class: 'wg-letter-sign' }, l.fromTitle));
}

/** Apre la composizione verso una fazione (anche dalla scheda paese). */
export function composeTo(target: string) { startCompose(target); set({ drawer: 'letters' }); }

function startCompose(target: string, reply?: DiploLetter) {
  ui.compose = { target, tone: 'formal', subject: reply ? `Risposta: ${reply.subject.replace(/^(Risposta:\s*)+/i, '')}`.slice(0, LIMITS.subject) : '', body: '', gist: '', visibility: 'private', inReplyTo: reply?.id };
  set({});
}

function composeForm(s: UiState) {
  const c = ui.compose!;
  const me = s.campaign!.playerFaction;
  const targets = Object.keys(s.knowledge?.beliefs ?? {}).filter((f) => f !== me);
  const queued = queuedLetters(s);
  const phaseOk = s.campaign?.phase === 'PLAYER_ORDERS';
  const full = queued.length >= LIMITS.perTurn;
  const replyTo = c.inReplyTo ? s.letters.find((l) => l.id === c.inReplyTo) : undefined;
  const count = (v: string, max: number) => h('small', { class: v.length > max ? 'wg-err' : 'wg-dim' }, `${v.length}/${max}`);
  const bind = (key: 'subject' | 'body' | 'gist') => (e: Event) => { c[key] = (e.target as HTMLInputElement).value; };
  const subject = h('input', { value: c.subject, maxlength: LIMITS.subject, placeholder: 'Oggetto', oninput: bind('subject') });
  const body = h('textarea', { rows: 9, maxlength: LIMITS.body, placeholder: 'Signor Presidente, …', oninput: bind('body') });
  body.value = c.body;
  const gist = h('input', { value: c.gist, maxlength: LIMITS.gist, placeholder: 'Traccia per il consigliere (cosa deve dire la lettera)', oninput: bind('gist') });
  const draft = async () => {
    if (!c.gist.trim()) { c.note = 'Scrivi una traccia per il consigliere.'; set({}); return; }
    const r = await draftLetter({ target: c.target, gist: c.gist, tone: c.tone, inReplyTo: c.inReplyTo });
    if (!r) return;
    Object.assign(c, { subject: r.subject, body: r.body, tone: r.tone, note: r.source === 'template' ? 'Il consigliere non ha prodotto un testo valido: ecco una lettera-modello da completare.' : 'Bozza del consigliere: rivedila prima dell\'invio.' });
    set({});
  };
  const send = () => {
    const errs = [!c.subject.trim() && 'oggetto vuoto', !c.body.trim() && 'testo vuoto', c.subject.length > LIMITS.subject && 'oggetto troppo lungo', c.body.length > LIMITS.body && 'testo troppo lungo'].filter(Boolean);
    if (errs.length) { c.note = `Non inviabile: ${errs.join(', ')}.`; set({}); return; }
    queueLetter({ id: newId('lt'), kind: 'LETTER', target: c.target, subject: c.subject.trim(), body: c.body.trim(), tone: c.tone, visibility: c.visibility, ...(c.inReplyTo ? { inReplyTo: c.inReplyTo } : {}) });
    ui.compose = null;
    set({});
  };
  return h('div', { class: 'wg-card wg-compose' },
    h('div', { class: 'wg-row' }, h('strong', {}, replyTo ? `Risposta ${toTitle(replyTo.fromTitle)}` : 'Nuova lettera'), h('button', { onclick: () => { ui.compose = null; set({}); } }, 'Annulla')),
    h('div', { class: 'wg-row' },
      select('target', targets.map((f) => [f, name(f)] as [string, string]), c.target, { onchange: (e: Event) => { c.target = (e.target as HTMLSelectElement).value; }, disabled: !!replyTo }),
      select('tone', TONES, c.tone, { onchange: (e: Event) => { c.tone = (e.target as HTMLSelectElement).value as LetterTone; set({}); } }),
      select('visibility', [['private', 'riservata'], ['public', 'pubblica']], c.visibility, { onchange: (e: Event) => { c.visibility = (e.target as HTMLSelectElement).value as 'private' | 'public'; } })),
    c.tone === 'threatening' ? h('p', { class: 'wg-warn' }, 'Una lettera minacciosa è una minaccia: se non ha seguito entro due turni costa credibilità.') : null,
    h('div', { class: 'wg-row' }, gist, h('button', { onclick: draft, disabled: s.busy, title: 'Il consigliere diplomatico scrive una bozza (LLM) che puoi modificare' }, 'Fai scrivere una bozza')),
    h('label', {}, 'Oggetto ', count(c.subject, LIMITS.subject)), subject,
    h('label', {}, 'Testo ', count(c.body, LIMITS.body)), body,
    c.note ? h('p', { class: 'wg-dim' }, c.note) : null,
    h('button', { class: 'wg-primary', onclick: send, disabled: !phaseOk || full }, full ? `Già ${LIMITS.perTurn} lettere questo turno` : 'Aggiungi agli ordini del turno'));
}

export function lettersPanel(s: UiState) {
  const me = s.campaign?.playerFaction ?? 'ITA';
  const queued = queuedLetters(s);
  const threads = new Map<string, DiploLetter[]>();
  for (const l of s.letters) threads.set(party(l, me), [...(threads.get(party(l, me)) ?? []), l]);
  const unread = (ls: DiploLetter[]) => ls.filter((l) => l.to === me && !s.lettersSeen.includes(l.id)).length;
  const order = [...threads].sort((a, b) => Math.max(...b[1].map((l) => l.turn)) - Math.max(...a[1].map((l) => l.turn)) || a[0].localeCompare(b[0]));
  const open = ui.open ? s.letters.find((l) => l.id === ui.open) : undefined;
  if (open && open.to === me) queueMicrotask(() => markLettersSeen([open.id]));

  return h('div', {},
    h('div', { class: 'wg-row' },
      h('button', { onclick: () => startCompose(ui.thread && ui.thread !== 'PUBBLICHE' ? ui.thread : 'TUR'), disabled: !!ui.compose }, '✎ Nuova lettera'),
      h('span', { class: 'wg-dim' }, `${queued.length}/${LIMITS.perTurn} lettere negli ordini del turno`)),
    ui.compose ? composeForm(s) : null,
    queued.length ? h('div', { class: 'wg-card' }, h('h4', {}, 'In partenza con il turno'),
      h('ul', { class: 'wg-draft' }, queued.map((l) => h('li', {}, `✉ ${name(l.target)} · «${l.subject}» · ${toneLabel(l.tone)}, ${l.visibility === 'public' ? 'pubblica' : 'riservata'}`,
        h('button', { onclick: () => set({ draft: { ...state.draft, diplomacy: state.draft.diplomacy.filter((x) => x.id !== l.id) }, validation: null, submitted: false }) }, '×'))))) : null,
    open ? [
      h('div', { class: 'wg-row' }, h('button', { onclick: () => { ui.open = null; set({}); } }, '← Corrispondenza'),
        open.to === me ? h('button', { onclick: () => startCompose(open.from, open), disabled: !!ui.compose }, 'Rispondi') : null),
      letterSheet(open),
    ] : [
      h('h4', {}, 'Corrispondenza'),
      order.length ? h('ul', { class: 'wg-threads' }, order.map(([who, ls]) => {
        const n = unread(ls);
        return h('li', { class: ui.thread === who ? 'on' : '' },
          h('button', { class: 'wg-thread', onclick: () => { ui.thread = ui.thread === who ? null : who; set({}); } },
            h('span', {}, who === 'PUBBLICHE' ? 'Lettere pubbliche' : name(who)), h('small', { class: 'wg-dim' }, `${ls.length} lettere`), n ? h('b', { class: 'wg-unread' }, String(n)) : null),
          ui.thread === who ? h('ul', { class: 'wg-thread-list' }, [...ls].reverse().map((l) => h('li', {},
            h('a', { href: '#', class: l.to === me && !s.lettersSeen.includes(l.id) ? 'unread' : '', onclick: (e: Event) => { e.preventDefault(); ui.open = l.id; set({}); } },
              `T${l.turn} · ${l.from === me ? '→' : '←'} ${l.subject}`)))) : null);
      })) : h('p', { class: 'wg-dim' }, 'Nessuna lettera. Le risposte arrivano nel turno successivo all\'invio.'),
    ]);
}
