import type { Campaign, Contact, EventType, GameEvent, LedgerEntry, TurnPhase, Visibility, WorldState } from '../schemas/index.js';
import { isActor } from './diplo-actions.js';
import { buildModifier, kindOfNote, type ActRef } from './opinion.js';
import { PARAMS } from './params.js';
import { applyEvent } from './reducer.js';
import { Rng } from './rng.js';
import type { Scenario } from './scenario.js';

type Category = LedgerEntry['category'];

/** Stato di lavoro di un turno: ogni mutazione passa da emit() → evento → reducer. */
export class TurnCtx {
  readonly events: GameEvent[] = [];
  readonly ledger: LedgerEntry[] = [];
  /** contatti con verità di terra (solo motore), per fazione */
  truthContacts: Record<string, Contact[]> = {};
  phase: TurnPhase;

  constructor(public state: WorldState, readonly campaign: Campaign, readonly scenario: Scenario, readonly rng: Rng, private seq: number) {
    this.phase = campaign.phase;
  }

  get turn() { return this.state.turn; }
  get catalog() { return this.scenario.catalog; }
  get nextSeq() { return this.seq; }

  startTurn(turn: number, date: string) {
    this.seq = 0;
    this.rng.setTurn(turn);
    const e: GameEvent = { id: `E${turn}-0`, turn, seq: this.seq++, phase: this.phase, type: 'TURN_ADVANCED', actor: 'world', targets: [], payload: { turn, date }, visibility: 'public', causedBy: null };
    applyEvent(this.state, e);
    this.events.push(e);
  }

  emit(type: EventType, actor: string, payload: Record<string, unknown>, opts: { targets?: string[]; visibility?: Visibility; causedBy?: GameEvent['causedBy'] } = {}): GameEvent {
    const e: GameEvent = {
      id: `E${this.turn}-${this.seq}`, turn: this.turn, seq: this.seq++, phase: this.phase, type, actor,
      targets: opts.targets ?? [], payload, visibility: opts.visibility ?? 'public', causedBy: opts.causedBy ?? null,
    };
    applyEvent(this.state, e);
    this.events.push(e);
    if (type === 'UNIT_DAMAGED' && this.state.units[payload.unitId as string]?.status === 'destroyed')
      this.emit('UNIT_DESTROYED', actor, { unitId: payload.unitId }, { targets: [payload.unitId as string], visibility: opts.visibility, causedBy: opts.causedBy });
    return e;
  }

  spend(factionId: string, amount: number, category: Category, ref: string, note: string) {
    if (!amount) return;
    const delta = Math.round(amount * 10) / 10;
    this.emit('BUDGET_CHANGED', factionId, { factionId, delta, category, ref, note }, { visibility: [factionId] });
    this.ledger.push({ turn: this.turn, factionId, category, amount: delta, balanceAfter: this.state.factions[factionId].budget.discretionary, ref, note });
  }

  /**
   * Costruttore di modificatori (docs/wargame/DIPLOMAZIA.md §5.2): un'azione di `a` verso `b` cambia **come b vede a**, cioè
   * `opinion(b→a)`, con tipo e decadimento dedotti dalla nota (tabella in engine/opinion.ts: minaccia, démarche, sanzioni…); `trust` è il
   * valore del modificatore (già tarato da chi chiama) e `tension` cambia la tensione di coppia (simmetrica). Gli alleati stretti di b
   * (`propagate` ≠ false) ne ricevono il 30%. Gli scontri e gli accordi accettati valgono per entrambe le parti. Emette OPINION_MODIFIER
   * e TENSION_CHANGED; l'atto (`act`) viaggia sul primo dei due, per chi legge incidenti, minacce e distensioni.
   * detente: azione distensiva (rassicurazione, canale riservato, lettera cordiale/conciliante, accordo accettato) che raffredda le crisi comuni.
   */
  relate(a: string, b: string, trust: number, tension: number, note: string, opts: { incident?: boolean; propagate?: boolean; visibility?: Visibility; detente?: boolean } = {}) {
    // vale per ogni coppia di attori: fazioni dello scenario e Stati del registro (ISO3)
    if (a === b || !isActor(this.state, a) || !isActor(this.state, b)) return;
    const visibility = opts.visibility ?? 'public';
    // chi ha ricevuto un ultimatum e cerca la distensione verso chi lo ha mandato lo «soddisfa» (si verifica alla scadenza)
    if (opts.detente) for (const u of this.state.diplomacy?.ultimatums ?? []) if (u.status === 'pending' && !u.answered && u.from === b && u.to === a) this.emit('DIPLOMACY_CHANGED', a, { change: { op: 'ultimatum_answered', id: u.id } }, { visibility: [a, b] });
    const { kind, label } = kindOfNote(note);
    const act: ActRef = { id: `A${this.turn}-${this.seq}`, a, b, note, ...(opts.incident ? { incident: true } : {}), ...(opts.detente ? { detente: true } : {}) };
    let carried = false;
    /** OPINION_MODIFIER su opinion(from→to) */
    const modify = (from: string, to: string, value: number, o: { propagated?: boolean; mirror?: boolean; of?: string; label?: string } = {}) => {
      const m = buildModifier(this.state, { kind: o.of ?? kind, label: o.label ?? label, from, to, value, turn: this.turn, act: act.id, causeRef: `E${this.turn}-${this.seq}`, visibility });
      const withAct = !carried && !o.propagated && !o.mirror;
      if (withAct) carried = true;
      this.emit('OPINION_MODIFIER', a, { modifier: m, ...(withAct ? { act } : {}), ...(o.propagated ? { propagated: true } : {}) }, { targets: [o.propagated ? from : b], visibility });
    };
    const tense = (x: string, y: string, delta: number, propagated = false) => {
      const withAct = !carried && !propagated;
      if (withAct) carried = true;
      this.emit('TENSION_CHANGED', a, { a: x, b: y, delta, ...(withAct ? { act } : {}), ...(propagated ? { propagated: true } : {}) }, { targets: [y], visibility });
    };
    if (kind === 'sanction_lifted') {
      // la revoca trasforma le sanzioni in vigore in un residuo che decade (−15 → −7,5, come prima il valore netto), non ne aggiunge altre
      for (const m of (this.state.diplomacy?.modifiers ?? []).filter((x) => x.kind === 'sanction' && x.from === b && x.to === a)) {
        carried = true;
        this.emit('OPINION_MODIFIER', a, { modifier: { ...m, kind, label, value: +(m.value / 2).toFixed(1), decayPerWeek: PARAMS.opinion.modifiers.sanction_lifted!.decayPerWeek, causeRef: `E${this.turn}-${this.seq}`, turn: this.turn }, act }, { targets: [b], visibility });
        break;
      }
    } else if (trust) {
      modify(b, a, trust);
      if (PARAMS.opinion.modifiers[kind]?.mutual) modify(a, b, trust, { mirror: true });
    }
    if (tension || !carried) tense(a, b, tension);
    if (opts.propagate === false || kind === 'sanction_lifted') return;
    const k = PARAMS.diplo.propagation;
    for (const ally of alliesOf(this.state, b)) {
      if (ally === a || !this.state.relations[a]?.[ally]) continue;
      if (trust) modify(ally, a, +(trust * k).toFixed(1), { propagated: true });
      if (tension) tense(a, ally, +(tension * k).toFixed(1), true);
    }
  }

  /** escalation già dovuta agli ordini in questo turno, per crisi (tetto PARAMS.crisisOrderCapPerTurn) */
  private byOrders = new Map<string, number>();

  /**
   * Variazione di una crisi. Con `byOrders` (blocchi, strike, ingaggi) la salita dovuta agli ordini è limitata a
   * PARAMS.crisisOrderCapPerTurn per crisi e per turno: le singole azioni continuano a pesare su tensioni e relazioni.
   */
  escalate(crisisId: string, delta: number, cause: string, opts: { byOrders?: boolean } = {}) {
    if (!this.state.crises[crisisId] || !delta) return;
    if (opts.byOrders && delta > 0) {
      const key = `${this.turn}:${crisisId}`;
      const used = this.byOrders.get(key) ?? 0;
      delta = Math.min(delta, PARAMS.crisisOrderCapPerTurn - used);
      if (delta <= 0) return;
      this.byOrders.set(key, used + delta);
    }
    this.emit('CRISIS_CHANGED', 'world', { crisisId, delta, cause, ...(opts.byOrders ? { byOrders: true } : {}) }, { targets: [crisisId] });
  }

  isVisibleTo(e: GameEvent, factionId: string) {
    return e.visibility === 'public' || e.visibility.includes(factionId) || e.actor === factionId;
  }
}

export function alliesOf(s: WorldState, f: string): string[] {
  return Object.values(s.agreements)
    .filter((a) => a.status === 'active' && (a.type === 'defense' || a.type === 'defense_cooperation') && a.parties.includes(f) && a.parties.length <= 3)
    .flatMap((a) => a.parties).filter((x) => x !== f);
}

export const newRng = (c: Campaign) => new Rng(c.seed, c.rngCursor, c.currentTurn);
