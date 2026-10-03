import type { Institution } from '../../src/schemas/nations.js';

/**
 * Istituzioni internazionali (stato a ottobre 2026, a memoria: da verificare con le fonti ufficiali quando c'è rete).
 * `members` è un elenco di ISO3 separati da spazio. Le adesioni delle nazioni (`memberships`) si ricavano da qui.
 * Coesione e regola di decisione sono giudizi ragionati, non misure: tarare con `npm run balance`.
 */
export interface InstitutionSrc extends Omit<Institution, 'members' | 'observers' | 'leaders'> {
  members: string;
  observers?: string;
  leaders?: string;
}

const AFRICA = 'DZA EGY LBY MAR SDN TUN BEN BFA CPV CIV GMB GHA GIN GNB LBR MLI MRT NER NGA SEN SLE TGO AGO CMR CAF TCD COG COD GNQ GAB STP BDI COM DJI ERI ETH KEN MDG MWI MUS MOZ RWA SYC SOM SSD UGA TZA ZMB ZWE BWA SWZ LSO NAM ZAF';

export const INSTITUTIONS: InstitutionSrc[] = [
  {
    id: 'NATO', name: 'North Atlantic Treaty Organization', nameIt: 'NATO', kind: 'alliance', decision: 'consensus', cohesion: 0.8,
    effects: ['collective_defense', 'joint_command'], leaders: 'USA GBR FRA DEU',
    members: 'ALB BEL BGR CAN HRV CZE DNK EST FIN FRA DEU GRC HUN ISL ITA LVA LTU LUX MNE NLD MKD NOR POL PRT ROU SVK SVN ESP SWE TUR GBR USA',
    notes: 'Art. 5 difesa collettiva; decisioni per consenso (anche un solo veto blocca).',
  },
  {
    id: 'EU', name: 'European Union', nameIt: 'Unione Europea', kind: 'union', decision: 'qmv', cohesion: 0.7,
    effects: ['single_market', 'common_sanctions'], leaders: 'FRA DEU ITA',
    members: 'AUT BEL BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT ROU SVK SVN ESP SWE',
    notes: 'Maggioranza qualificata (55% degli Stati, 65% della popolazione); unanimità per sanzioni e politica estera e di sicurezza comune.',
  },
  {
    id: 'UNGA', name: 'United Nations General Assembly', nameIt: 'Assemblea generale delle Nazioni Unite', kind: 'un', decision: 'majority', cohesion: 0.45,
    effects: ['non_binding'], members: '@UN', observers: 'VAT PSE', notes: '193 membri con voto; Santa Sede e Palestina osservatori. Risoluzioni non vincolanti.',
  },
  {
    id: 'UNSC', name: 'United Nations Security Council', nameIt: 'Consiglio di sicurezza delle Nazioni Unite', kind: 'un', decision: 'unsc', cohesion: 0.35,
    effects: ['veto_members'], leaders: 'USA GBR FRA RUS CHN',
    members: 'USA GBR FRA RUS CHN DNK GRC PAK PAN SOM BHR COL COD LVA LBR',
    terms: { DNK: '2025–26', GRC: '2025–26', PAK: '2025–26', PAN: '2025–26', SOM: '2025–26', BHR: '2026–27', COL: '2026–27', COD: '2026–27', LVA: '2026–27', LBR: '2026–27' },
    notes: '15 membri: 5 permanenti con veto più 10 eletti (mandato biennale). Servono 9 voti e nessun veto.',
  },
  {
    id: 'AU', name: 'African Union', nameIt: 'Unione Africana', kind: 'regional', decision: 'consensus', cohesion: 0.5,
    effects: ['non_binding'], members: AFRICA, notes: 'Tutti i 54 Stati africani del registro (Repubblica Araba Sahrawi esclusa dal registro). Sospensioni per colpi di Stato non modellate.',
  },
  {
    id: 'ARAB_LEAGUE', name: 'League of Arab States', nameIt: 'Lega Araba', kind: 'regional', decision: 'consensus', cohesion: 0.45,
    effects: ['non_binding'], leaders: 'SAU EGY',
    members: 'DZA BHR COM DJI EGY IRQ JOR KWT LBN LBY MRT MAR OMN PSE QAT SAU SOM SDN SYR TUN ARE YEM',
  },
  {
    id: 'GCC', name: 'Gulf Cooperation Council', nameIt: 'Consiglio di cooperazione del Golfo', kind: 'security', decision: 'unanimity', cohesion: 0.65,
    effects: ['collective_defense'], leaders: 'SAU', members: 'BHR KWT OMN QAT SAU ARE',
  },
  {
    id: 'ASEAN', name: 'Association of Southeast Asian Nations', nameIt: 'ASEAN', kind: 'regional', decision: 'consensus', cohesion: 0.5,
    effects: [], leaders: 'IDN', members: 'BRN KHM IDN LAO MYS MMR PHL SGP THA VNM TLS', notes: 'Timor Est membro dall\'ottobre 2025.',
  },
  {
    id: 'SCO', name: 'Shanghai Cooperation Organisation', nameIt: 'Organizzazione per la cooperazione di Shanghai', kind: 'security', decision: 'consensus', cohesion: 0.45,
    effects: [], leaders: 'CHN RUS', members: 'CHN RUS KAZ KGZ TJK UZB IND PAK IRN BLR',
  },
  {
    id: 'BRICS', name: 'BRICS', nameIt: 'BRICS', kind: 'economic', decision: 'consensus', cohesion: 0.4,
    effects: [], leaders: 'CHN IND BRA RUS ZAF', members: 'BRA RUS IND CHN ZAF EGY ETH IRN ARE IDN', notes: 'Arabia Saudita invitata, adesione non confermata: non inclusa.',
  },
  {
    id: 'CSTO', name: 'Collective Security Treaty Organization', nameIt: 'Organizzazione del trattato di sicurezza collettiva', kind: 'alliance', decision: 'consensus', cohesion: 0.35,
    effects: ['collective_defense', 'joint_command'], leaders: 'RUS', members: 'ARM BLR KAZ KGZ RUS TJK', notes: 'Armenia ha congelato la partecipazione dal 2024.',
  },
  {
    id: 'OPEC_PLUS', name: 'OPEC+', nameIt: 'OPEC+', kind: 'economic', decision: 'consensus', cohesion: 0.6,
    effects: ['energy_quotas'], leaders: 'SAU RUS', members: 'DZA COG GNQ GAB IRN IRQ KWT LBY NGA SAU ARE VEN AZE BHR BRN KAZ MYS MEX OMN RUS SDN SSD',
  },
  {
    id: 'OAS', name: 'Organization of American States', nameIt: 'Organizzazione degli Stati americani', kind: 'regional', decision: 'majority', cohesion: 0.4,
    effects: ['non_binding'], leaders: 'USA', members: 'USA CAN BLZ CRI SLV GTM HND MEX PAN ATG BHS BRB CUB DMA DOM GRD HTI JAM KNA LCA VCT TTO ARG BOL BRA CHL COL ECU GUY PRY PER SUR URY VEN',
    notes: 'Nicaragua ha lasciato l\'organizzazione nel 2023; Cuba non partecipa.',
  },
  {
    id: 'COMMONWEALTH', name: 'Commonwealth of Nations', nameIt: 'Commonwealth', kind: 'regional', decision: 'consensus', cohesion: 0.3,
    effects: ['non_binding'], leaders: 'GBR',
    members: 'BWA CMR GMB GHA KEN LSO MWI MUS MOZ NAM NGA RWA SYC SLE ZAF SWZ UGA TZA ZMB GAB TGO ATG BHS BRB BLZ CAN DMA GRD GUY JAM KNA LCA VCT TTO BGD BRN IND MYS MDV PAK SGP LKA CYP MLT GBR AUS FJI KIR NRU NZL PNG WSM SLB TON TUV VUT',
  },
  { id: 'G7', name: 'Group of Seven', nameIt: 'G7', kind: 'economic', decision: 'consensus', cohesion: 0.75, effects: [], leaders: 'USA', members: 'CAN FRA DEU ITA JPN GBR USA' },
  {
    id: 'G20', name: 'Group of Twenty', nameIt: 'G20', kind: 'economic', decision: 'consensus', cohesion: 0.3, effects: [], leaders: 'USA CHN',
    members: 'ARG AUS BRA CAN CHN FRA DEU IND IDN ITA JPN KOR MEX RUS SAU ZAF TUR GBR USA', notes: 'Più UE e Unione Africana come blocchi (non rappresentati qui).',
  },
  {
    id: 'COE', name: 'Council of Europe', nameIt: 'Consiglio d\'Europa', kind: 'regional', decision: 'majority', cohesion: 0.6, effects: ['non_binding'],
    members: 'ALB AND ARM AUT AZE BEL BIH BGR HRV CYP CZE DNK EST FIN FRA GEO DEU GRC HUN ISL IRL ITA LVA LIE LTU LUX MLT MDA MCO MNE NLD MKD NOR POL PRT ROU SMR SRB SVK SVN ESP SWE CHE TUR UKR GBR',
    notes: 'Russia espulsa nel 2022; Bielorussia mai membro.',
  },
  {
    id: 'OSCE', name: 'Organization for Security and Co-operation in Europe', nameIt: 'OSCE', kind: 'security', decision: 'consensus', cohesion: 0.3, effects: ['non_binding'],
    members: 'ALB AND ARM AUT AZE BLR BEL BIH BGR CAN HRV CYP CZE DNK EST FIN FRA GEO DEU GRC VAT HUN ISL IRL ITA KAZ KGZ LVA LIE LTU LUX MLT MDA MCO MNG MNE NLD MKD NOR POL PRT ROU RUS SMR SRB SVK SVN ESP SWE CHE TJK TUR TKM UKR GBR USA UZB',
  },
  {
    id: 'OIC', name: 'Organisation of Islamic Cooperation', nameIt: 'Organizzazione della cooperazione islamica', kind: 'regional', decision: 'consensus', cohesion: 0.4,
    effects: ['non_binding'], leaders: 'SAU TUR',
    members: 'AFG ALB DZA AZE BHR BGD BEN BRN BFA CMR TCD COM CIV DJI EGY GAB GMB GIN GNB GUY IDN IRN IRQ JOR KAZ KWT KGZ LBN LBY MYS MDV MLI MRT MAR MOZ NER NGA OMN PAK PSE QAT SAU SEN SLE SOM SDN SUR SYR TJK TGO TUN TUR TKM UGA ARE UZB YEM',
  },
  { id: 'ECOWAS', name: 'Economic Community of West African States', nameIt: 'ECOWAS (CEDEAO)', kind: 'regional', decision: 'consensus', cohesion: 0.5, effects: ['common_sanctions'], leaders: 'NGA', members: 'BEN CPV CIV GMB GHA GIN GNB LBR NGA SEN SLE TGO', notes: 'Mali, Burkina Faso e Niger l\'hanno lasciata nel 2025.' },
  { id: 'AES', name: 'Alliance of Sahel States', nameIt: 'Alleanza degli Stati del Sahel', kind: 'security', decision: 'consensus', cohesion: 0.85, effects: ['collective_defense'], leaders: 'MLI', members: 'MLI BFA NER' },
  { id: 'SADC', name: 'Southern African Development Community', nameIt: 'SADC', kind: 'regional', decision: 'consensus', cohesion: 0.5, effects: [], leaders: 'ZAF', members: 'AGO BWA COM COD SWZ LSO MDG MWI MUS MOZ NAM SYC ZAF TZA ZMB ZWE' },
  { id: 'EAC', name: 'East African Community', nameIt: 'Comunità dell\'Africa orientale', kind: 'regional', decision: 'consensus', cohesion: 0.5, effects: ['single_market'], leaders: 'KEN', members: 'BDI COD KEN RWA SSD SOM TZA UGA' },
  { id: 'MERCOSUR', name: 'Mercosur', nameIt: 'Mercosur', kind: 'economic', decision: 'consensus', cohesion: 0.5, effects: ['single_market'], leaders: 'BRA ARG', members: 'ARG BRA PRY URY BOL' },
  { id: 'CELAC', name: 'Community of Latin American and Caribbean States', nameIt: 'CELAC', kind: 'regional', decision: 'consensus', cohesion: 0.3, effects: ['non_binding'], leaders: 'BRA MEX', members: 'MEX BLZ CRI SLV GTM HND NIC PAN ATG BHS BRB CUB DMA DOM GRD HTI JAM KNA LCA VCT TTO ARG BOL BRA CHL COL ECU GUY PRY PER SUR URY VEN' },
  { id: 'CARICOM', name: 'Caribbean Community', nameIt: 'CARICOM', kind: 'regional', decision: 'consensus', cohesion: 0.6, effects: ['single_market'], members: 'ATG BHS BRB BLZ DMA GRD GUY HTI JAM LCA KNA VCT SUR TTO' },
  { id: 'PIF', name: 'Pacific Islands Forum', nameIt: 'Forum delle isole del Pacifico', kind: 'regional', decision: 'consensus', cohesion: 0.5, effects: [], leaders: 'AUS NZL', members: 'AUS NZL FJI PNG SLB VUT KIR MHL FSM NRU PLW WSM TON TUV' },
  { id: 'QUAD', name: 'Quadrilateral Security Dialogue', nameIt: 'Quad', kind: 'security', decision: 'consensus', cohesion: 0.75, effects: [], leaders: 'USA', members: 'USA JPN IND AUS' },
  { id: 'AUKUS', name: 'AUKUS', nameIt: 'AUKUS', kind: 'security', decision: 'consensus', cohesion: 0.95, effects: ['joint_command'], leaders: 'USA', members: 'USA GBR AUS' },
  { id: 'FIVE_EYES', name: 'Five Eyes', nameIt: 'Five Eyes', kind: 'security', decision: 'consensus', cohesion: 0.95, effects: [], leaders: 'USA', members: 'USA GBR CAN AUS NZL', notes: 'Condivisione di intelligence (SIGINT).' },
  {
    id: 'UFM', name: 'Union for the Mediterranean', nameIt: 'Unione per il Mediterraneo', kind: 'regional', decision: 'consensus', cohesion: 0.35, effects: ['non_binding'], leaders: 'FRA EGY',
    members: 'AUT BEL BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT ROU SVK SVN ESP SWE ALB DZA BIH EGY ISR JOR LBN MRT MCO MNE MAR PSE SYR TUN TUR',
    notes: 'Siria sospesa; Libia osservatore.',
  },
  { id: 'EMGF', name: 'East Mediterranean Gas Forum', nameIt: 'Forum del gas del Mediterraneo orientale', kind: 'economic', decision: 'consensus', cohesion: 0.6, effects: [], leaders: 'EGY', members: 'EGY CYP GRC ISR ITA JOR PSE FRA', notes: 'Sede al Cairo; Turchia esclusa.' },
];
