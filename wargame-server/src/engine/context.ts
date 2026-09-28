import type { Campaign, Contact, EventType, GameEvent, LedgerEntry, TurnPhase, Visibility, WorldState } from '../schemas/index.js';
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

  relate(a: string, b: string, trust: number, tension: number, note: string, opts: { incident?: boolean; propagate?: boolean; visibility?: Visibility } = {}) {
    if (a === b || !this.state.relations[a]?.[b]) return;
    this.emit('RELATION_CHANGED', a, { a, b, trust, tension, note, incident: opts.incident ?? false }, { targets: [b], visibility: opts.visibility ?? 'public' });
    if (opts.propagate === false) return;
    const k = 0.3;
    for (const ally of alliesOf(this.state, b)) if (ally !== a) this.emit('RELATION_CHANGED', a, { a, b: ally, trust: +(trust * k).toFixed(1), tension: +(tension * k).toFixed(1), note: `propagazione: ${note}` }, { targets: [ally], visibility: opts.visibility ?? 'public' });
  }

  escalate(crisisId: string, delta: number, cause: string) {
    if (!this.state.crises[crisisId] || !delta) return;
    this.emit('CRISIS_CHANGED', 'world', { crisisId, delta, cause }, { targets: [crisisId] });
  }

  isVisibleTo(e: GameEvent, factionId: string) {
    return e.visibility === 'public' || e.visibility.includes(factionId) || e.actor === factionId;
  }
}

export function alliesOf(s: WorldState, f: string): string[] {
  return Object.values(s.agreements)
    .filter((a) => a.status === 'active' && a.type === 'defense' && a.parties.includes(f) && a.parties.length <= 3)
    .flatMap((a) => a.parties).filter((x) => x !== f);
}

export const newRng = (c: Campaign) => new Rng(c.seed, c.rngCursor, c.currentTurn);
