import type { UiState } from './state/store';
import { briefingPanel, crisesPanel, intelPanel, newsPanel } from './panels/intel';
import { foedPanel, oobPanel, procurementPanel } from './panels/forces';
import { diplomacyPanel } from './panels/diplomacy';
import { lettersPanel } from './panels/letters';
import { institutionsPanel } from './panels/institutions';
import { reactionsPanel } from './panels/reactions';
import { statesPanel } from './panels/states';
import { ordersPanel } from './panels/orders';
import { cmoPanel, postmortemPanel } from './panels/cmo';

export interface PanelDef { id: string; title: string; render: (s: UiState, ctx: { flyTo: (lon: number, lat: number) => void; rerender: () => void }) => HTMLElement }

/** Variante "wargame": pannelli e layer registrati (sostituiscono i feed reali di World Monitor). */
export const WARGAME_VARIANT = {
  id: 'wargame',
  layers: ['crises', 'lanes', 'infrastructure', 'ranges', 'contacts', 'units'],
  panels: [
    { id: 'briefing', title: 'Briefing', render: (s) => briefingPanel(s) },
    { id: 'orders', title: 'Console Ordini', render: (s) => ordersPanel(s) },
    { id: 'oob', title: 'Ordine di Battaglia', render: (s, c) => oobPanel(s, c.flyTo) },
    { id: 'intel', title: 'Intel Feed', render: (s) => intelPanel(s) },
    { id: 'news', title: 'Notizie', render: (s) => newsPanel(s) },
    { id: 'crises', title: 'Crisi', render: (s) => crisesPanel(s) },
    { id: 'diplomacy', title: 'Diplomazia', render: (s) => diplomacyPanel(s) },
    { id: 'states', title: 'Stati', render: (s) => statesPanel(s) },
    { id: 'institutions', title: 'Istituzioni', render: (s) => institutionsPanel(s) },
    { id: 'reactions', title: 'Reazioni internazionali', render: (s) => reactionsPanel(s) },
    { id: 'letters', title: 'Lettere', render: (s) => lettersPanel(s) },
    { id: 'foed', title: 'FOED', render: (s) => foedPanel(s) },
    { id: 'procurement', title: 'Procurement', render: (s) => procurementPanel(s) },
    { id: 'cmo', title: 'Coda CMO', render: (s) => cmoPanel(s) },
    { id: 'postmortem', title: 'Post-mortem', render: (s, c) => postmortemPanel(s, c.rerender) },
  ] satisfies PanelDef[] as PanelDef[],
};
