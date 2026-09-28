import { z } from 'zod';
import { Agreement, FactionId, LatLon, MEur, Roe, Turn, Visibility, ZoneId } from './world.js';

const base = { id: z.string(), unitIds: z.array(z.string()) };
export const Order = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('MOVE'), to: z.union([ZoneId, LatLon]), speed: z.enum(['slow', 'cruise', 'flank']) }),
  z.object({ ...base, kind: z.enum(['PATROL', 'PRESENCE', 'SHOW_OF_FORCE']), zoneId: ZoneId, roe: Roe }),
  z.object({ ...base, kind: z.literal('ESCORT'), protect: z.string(), roe: Roe }),
  z.object({ ...base, kind: z.enum(['BLOCKADE', 'EXCLUSION_ZONE']), zoneId: ZoneId, roe: Roe }),
  z.object({ ...base, kind: z.literal('STRIKE'), targetRef: z.string(), munitions: z.record(z.string(), z.number()), roe: Roe }),
  z.object({ id: z.string(), kind: z.literal('ISR'), assetIds: z.array(z.string()), zoneId: ZoneId }),
  z.object({ ...base, kind: z.literal('SOF_OP'), objective: z.string(), zoneId: ZoneId, deniability: z.enum(['overt', 'covert']) }),
  z.object({ id: z.string(), kind: z.literal('CYBER_OP'), target: FactionId, targetRef: z.string(), effect: z.enum(['espionage', 'disruption', 'defense_hardening']) }),
  z.object({ ...base, kind: z.literal('AIR_DEFENSE'), zoneId: ZoneId, alert: z.enum(['low', 'high']) }),
  z.object({ ...base, kind: z.enum(['REPAIR', 'RETURN_TO_BASE', 'STAND_DOWN']) }),
  z.object({ ...base, kind: z.literal('EVACUATION'), zoneId: ZoneId }),
]);

/** Limiti delle lettere (anche nello schema JSON mandato al modello: i modelli piccoli si fermano prima). */
export const LETTER_LIMITS = { subject: 120, body: 1800, gist: 300, perTurnHuman: 2 } as const;
const LetterTone = z.enum(['cordial', 'formal', 'firm', 'threatening', 'conciliatory']);
/** Lettera formale tra capi di Stato; le lunghezze le controlla il validatore (errore leggibile, non un 400 di schema). */
export const LetterAction = z.object({
  id: z.string(), kind: z.literal('LETTER'), target: FactionId, subject: z.string(), body: z.string(), tone: LetterTone,
  visibility: z.enum(['private', 'public']), inReplyTo: z.string().optional(),
  /** chi ha scritto il testo per una fazione IA: modello LLM o 'template' (lettera-modello di ripiego) */
  model: z.string().optional(),
});

const DIPLO_BASE = [
  z.object({ id: z.string(), kind: z.enum(['DEMARCHE', 'THREAT', 'REASSURANCE']), target: FactionId, message: z.string(), visibility: Visibility }),
  z.object({ id: z.string(), kind: z.literal('PROPOSE_AGREEMENT'), target: z.array(FactionId), agreement: Agreement.omit({ id: true, status: true, startTurn: true }) }),
  z.object({ id: z.string(), kind: z.literal('RESPOND_AGREEMENT'), agreementId: z.string(), response: z.enum(['accept', 'reject', 'counter']), counterTerms: z.string().optional() }),
  z.object({ id: z.string(), kind: z.enum(['SANCTION', 'LIFT_SANCTION']), target: FactionId, scope: z.string() }),
  z.object({ id: z.string(), kind: z.literal('BACKCHANNEL'), target: FactionId, message: z.string() }),
  z.object({ id: z.string(), kind: z.enum(['NATO_ART4', 'EU_COUNCIL', 'UNSC_DRAFT']), subject: z.string() }),
  z.object({ id: z.string(), kind: z.literal('ENERGY_DEAL'), target: FactionId, infrastructureId: z.string(), terms: z.string() }),
  z.object({ id: z.string(), kind: z.literal('AID'), target: FactionId, amount: MEur, type: z.enum(['economic', 'military']) }),
] as const;
export const DiploAction = z.discriminatedUnion('kind', [...DIPLO_BASE, LetterAction]);
/** Azioni diplomatiche che una fazione IA può mettere direttamente negli ordini (le lettere passano da letterIntents). */
export const DiploActionNoLetter = z.discriminatedUnion('kind', [...DIPLO_BASE]);

export const ProcurementOrder = z.object({ id: z.string(), itemId: z.string(), qty: z.number().int().min(1), destinationBaseId: z.string() });
export const PublicStatement = z.object({ id: z.string(), audience: z.string(), text: z.string(), tone: z.enum(['conciliatory', 'firm', 'threatening']) });

export const OrdersBody = z.object({
  military: z.array(Order).default([]), diplomacy: z.array(DiploAction).default([]),
  procurement: z.array(ProcurementOrder).default([]), statements: z.array(PublicStatement).default([]),
});
export const FactionOrders = OrdersBody.extend({
  schemaVersion: z.literal(1), factionId: FactionId, turn: Turn,
  source: z.enum(['human', 'ai', 'fallback_doctrine', 'replay']),
});

/**
 * Postura per zona: l'IA dice DOVE e COME impiegare le forze (scelte chiuse), il motore sceglie QUALI unità
 * (engine/stances.ts) e le traduce in ordini `Order` normali, validati come quelli del giocatore.
 */
export const STANCES = ['patrol', 'presence', 'show_of_force', 'escort_shipping', 'blockade', 'air_defense', 'withdraw'] as const;
export const Stance = z.enum(STANCES);
export const ZoneStance = z.object({ zoneId: ZoneId, stance: Stance, intensity: z.number().int().min(1).max(3) });

export type Order = z.infer<typeof Order>;
export type Stance = z.infer<typeof Stance>;
export type ZoneStance = z.infer<typeof ZoneStance>;
export type DiploAction = z.infer<typeof DiploAction>;
export type LetterAction = z.infer<typeof LetterAction>;
export type ProcurementOrder = z.infer<typeof ProcurementOrder>;
export type PublicStatement = z.infer<typeof PublicStatement>;
export type OrdersBody = z.infer<typeof OrdersBody>;
export type FactionOrders = z.infer<typeof FactionOrders>;
