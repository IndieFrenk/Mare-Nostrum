/** Aspetto delle fazioni sulla mappa politica (ISO3 dei paesi in public/data/countries.geojson). */
export const FACTIONS: Record<string, { iso: string | null; color: string; label: [number, number] }> = {
  ITA: { iso: 'ITA', color: '#3f8f4f', label: [12.6, 42.6] },
  USA: { iso: 'USA', color: '#3b5ba8', label: [-98, 39] },
  FRA: { iso: 'FRA', color: '#4d78c9', label: [2.4, 46.6] },
  GBR: { iso: 'GBR', color: '#a8374a', label: [-2, 53] },
  TUR: { iso: 'TUR', color: '#b5502f', label: [34.5, 39.1] },
  RUS: { iso: 'RUS', color: '#6b2b2b', label: [62, 60] },
  CHN: { iso: 'CHN', color: '#c9a227', label: [103, 35] },
  GRC: { iso: 'GRC', color: '#5aa0d8', label: [22, 39.4] },
  EGY: { iso: 'EGY', color: '#c2a76a', label: [30.5, 25.2] },
  ISR: { iso: 'ISR', color: '#7fb0d4', label: [35, 31] },
  ALG: { iso: 'DZA', color: '#2f6b44', label: [2.6, 28] },
  TUN: { iso: 'TUN', color: '#c24a4a', label: [9.4, 34] },
  LBY_GNU: { iso: 'LBY', color: '#7e8f3c', label: [14.2, 27.5] },
  LBY_LNA: { iso: null, color: '#8f6a3a', label: [21.5, 29.2] },
  IRN: { iso: 'IRN', color: '#3a7a5a', label: [54, 32.5] },
};

/** Etichette brevi sulla mappa. */
export const MAP_LABELS: Record<string, string> = { LBY_GNU: 'Tripolitania', LBY_LNA: 'Cirenaica' };

export const NAMES: Record<string, string> = {
  ITA: 'Italia', USA: 'Stati Uniti', FRA: 'Francia', GBR: 'Regno Unito', TUR: 'Turchia', RUS: 'Russia', CHN: 'Cina', GRC: 'Grecia', EGY: 'Egitto',
  ISR: 'Israele', ALG: 'Algeria', TUN: 'Tunisia', LBY_GNU: 'Libia (GNU)', LBY_LNA: 'Libia (LNA)', IRN: 'Iran',
};

export const EU_ISO = ['AUT', 'BEL', 'BGR', 'HRV', 'CYP', 'CZE', 'DNK', 'EST', 'FIN', 'DEU', 'HUN', 'IRL', 'LVA', 'LTU', 'LUX', 'MLT', 'NLD', 'POL', 'PRT', 'ROU', 'SVK', 'SVN', 'ESP', 'SWE'];
