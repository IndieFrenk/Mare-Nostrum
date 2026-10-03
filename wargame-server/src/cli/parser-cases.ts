import type { OrdersBody } from '../schemas/index.js';
import type { ParsedDraft } from '../engine/parse-review.js';

/**
 * Banco «parser» (bench-models): frasi italiane di un giocatore con il risultato atteso. Ogni attesa è un ordine
 * che deve comparire nella bozza finale (dopo nomi, posture e controlli del motore): tipo ammesso, unità, zona, destinatario.
 */
export interface Expect { kinds: string[]; unit?: string; zone?: string; target?: string }
export interface ParserCase { text: string; expect: Expect[] }
export type Verdict = 'corretto' | 'sbagliato' | 'pericoloso';

const PRESENZA = ['PATROL', 'PRESENCE', 'MOVE', 'SHOW_OF_FORCE'];
export const PARSER_CASES: ParserCase[] = [
  { text: 'Manda la fregata Bergamini a pattugliare il Canale di Sicilia e chiedi alla Tunisia più controlli sulle partenze',
    expect: [{ kinds: ['PATROL', 'MOVE', 'PRESENCE'], unit: 'ITA-F590', zone: 'CANALE_SICILIA' }, { kinds: ['DEMARCHE', 'BACKCHANNEL'], target: 'TUN' }] },
  { text: 'Porta la Cavour nel Mar Ionio con una dimostrazione di forza e rassicura la Grecia',
    expect: [{ kinds: ['SHOW_OF_FORCE'], unit: 'ITA-CAVOUR', zone: 'IONIO' }, { kinds: ['REASSURANCE'], target: 'GRC' }] },
  { text: 'La Margottini pattugli il Mar Libico con regole d\'ingaggio restrittive', expect: [{ kinds: ['PATROL'], unit: 'ITA-F592', zone: 'MAR_LIBICO' }] },
  { text: 'Il cacciatorpediniere Andrea Doria vada nell\'Egeo in presenza, armi in sicura', expect: [{ kinds: PRESENZA, unit: 'ITA-D553', zone: 'EGEO' }] },
  { text: 'Fai rientrare alla base la Luigi Rizzo dal Mar Rosso', expect: [{ kinds: ['RETURN_TO_BASE'], unit: 'ITA-F595' }] },
  { text: 'Voglio più presenza navale nel Canale di Sicilia', expect: [{ kinds: PRESENZA, zone: 'CANALE_SICILIA' }] },
  { text: 'Protesta formalmente con la Turchia per le attività delle sue navi nell\'Egeo', expect: [{ kinds: ['DEMARCHE'], target: 'TUR' }] },
  { text: 'Minaccia la Russia di conseguenze se le sue navi continuano a seguire le nostre fregate', expect: [{ kinds: ['THREAT'], target: 'RUS' }] },
  { text: 'Offri 50 milioni di aiuti economici alla Tunisia', expect: [{ kinds: ['AID'], target: 'TUN' }] },
  { text: 'Rassicura la Francia sul nostro impegno comune nel Mediterraneo occidentale', expect: [{ kinds: ['REASSURANCE'], target: 'FRA' }] },
  { text: 'Avvia un\'operazione cyber di spionaggio contro l\'Iran', expect: [{ kinds: ['CYBER_OP'], target: 'IRN' }] },
  { text: 'Il sottomarino Todaro pattugli lo Ionio senza farsi vedere', expect: [{ kinds: ['PATROL'], unit: 'ITA-S526', zone: 'IONIO' }] },
  { text: 'Manda la Fasan a scortare i mercantili nel Mar Rosso', expect: [{ kinds: ['ESCORT', 'PATROL'], unit: 'ITA-F591', zone: 'MAR_ROSSO' }] },
  { text: 'Chiedi all\'Egitto di collaborare sui flussi migratori e manda la Morosini nel Mar Libico',
    expect: [{ kinds: ['DEMARCHE', 'BACKCHANNEL', 'PROPOSE_AGREEMENT'], target: 'EGY' }, { kinds: PRESENZA, unit: 'ITA-P431', zone: 'MAR_LIBICO' }] },
];

const zoneOf = (o: OrdersBody['military'][number]) =>
  'zoneId' in o ? o.zoneId : o.kind === 'MOVE' && typeof o.to === 'string' ? o.to : o.kind === 'ESCORT' ? o.protect.replace(/^convoglio\s*/i, '') : null;

/** Confronta la bozza finale con il risultato atteso. Pericoloso: azione ostile verso un alleato (avvisi «⚠»); le CYBER_OP non chieste le toglie il motore. */
export function scoreParsed(c: ParserCase, d: ParsedDraft): { verdict: Verdict; reasons: string[] } {
  const danger = d.validation.risks.filter((r) => r.startsWith('⚠'));
  if (danger.length) return { verdict: 'pericoloso', reasons: danger };
  const reasons: string[] = [];
  for (const e of c.expect) {
    const ok = d.orders.military.some((o) => e.kinds.includes(o.kind)
      && (!e.unit || ('unitIds' in o && o.unitIds.includes(e.unit))) && (e.unit || !('unitIds' in o) || o.unitIds.length > 0)
      && (!e.zone || zoneOf(o) === e.zone) && (!e.target || ('target' in o && o.target === e.target)))
      || d.orders.diplomacy.some((o) => e.kinds.includes(o.kind) && (!e.target || ('target' in o && (Array.isArray(o.target) ? o.target.includes(e.target) : o.target === e.target))));
    if (!ok) reasons.push(`manca ${e.kinds.join('/')}${e.unit ? ` ${e.unit}` : ''}${e.zone ? ` in ${e.zone}` : ''}${e.target ? ` → ${e.target}` : ''}`);
  }
  reasons.push(...d.validation.errors);
  return { verdict: reasons.length ? 'sbagliato' : 'corretto', reasons };
}
