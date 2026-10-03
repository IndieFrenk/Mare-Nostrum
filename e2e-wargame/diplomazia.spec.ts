import { expect, test, type Page } from '@playwright/test';

/** Con WG_SHOTS=<cartella> il test salva gli screenshot per la PR (scheda con i motivi, modalità Opinione, modalità Voto). */
const shot = async (page: Page, name: string) => { if (process.env.WG_SHOTS) await page.screenshot({ path: `${process.env.WG_SHOTS}/${name}.png` }); };
const num = (t: string) => Number(t.replace(',', '.'));

async function newCampaign(page: Page, errors: string[]) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/wargame.html');
  await page.getByPlaceholder('Seed (opzionale)').fill(`e2e-diplo-${Date.now()}`);
  await page.getByRole('button', { name: 'Crea' }).click();
  await expect(page.getByText('PLAYER_ORDERS')).toBeVisible({ timeout: 60_000 });
}
/** Apre la scheda di uno Stato dall'elenco «Stati» (anche da tastiera: ricerca, Invio). */
async function openState(page: Page, name: string) {
  await page.getByRole('button', { name: 'Stati', exact: true }).click();
  await page.getByPlaceholder('Cerca uno Stato…').fill(name);
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await page.getByRole('button', { name: 'Stati', exact: true }).click(); // chiude il pannello: la scheda resta
}

test('scheda di uno Stato del mondo: motivi dell\'opinione, bozza, accettazione stimata, turno e capitale diplomatico', async ({ page }) => {
  const errors: string[] = [];
  await newCampaign(page, errors);
  await openState(page, 'Polonia');
  const card = page.locator('.wg-cc');
  await expect(card.locator('header')).toContainText('POLONIA');
  // i motivi dell'opinione, con valore e segno (stile HOI4)
  await expect(card.getByText('L\'Italia verso Polonia')).toBeVisible();
  await expect(card.locator('.wg-reasons li').filter({ hasText: /Alleanza difensiva in comune/ }).first()).toContainText(/^\+\d/);
  await expect(card.getByText(/Di come ci vede si conosce solo la fascia/)).toBeVisible();
  await shot(page, 'scheda-paese');

  const left = async () => num((await card.getByText(/CD disponibili dopo la bozza/).innerText()).match(/([\d.,]+) CD disponibili/)![1]!);
  const before = await left();

  // azioni dal catalogo con costo e ricarica; entrano nella bozza (niente invio diretto)
  await card.getByRole('button', { name: /^Migliorare le relazioni/ }).click();
  await expect(card.getByText('In bozza: Migliorare le relazioni')).toBeVisible();
  await expect(card.getByRole('button', { name: /^Migliorare le relazioni/ })).toBeDisabled();
  await card.getByRole('button', { name: /^Rassicurazione/ }).click();

  // accettazione stimata di un patto di non aggressione, con i motivi, prima di inviarlo
  const pact = card.locator('.wg-act', { hasText: 'Patto di non aggressione' });
  await expect(pact).toContainText(/Accetterebbe: (sì|no) \([+−]?\d/);
  await expect(pact).toContainText('stima');
  await pact.locator('summary', { hasText: 'perché' }).click();
  await expect(pact).toContainText(/Opinione verso il proponente \(stima: /);
  await pact.getByRole('button', { name: /^Patto di non aggressione/ }).click();
  expect(await left()).toBeCloseTo(before - 5, 1);

  await page.getByRole('button', { name: 'Esegui turno' }).click();
  await expect(page.getByText(/^T2 ·/)).toBeVisible({ timeout: 60_000 });

  // dopo il turno: il capitale è sceso (spesi 5 CD, la rendita ne rida meno), e la scheda mostra l'effetto
  await expect(card.getByText(/migliorare le relazioni in corso dal turno 1/)).toBeVisible();
  await expect(card.getByText(/CD disponibili dopo la bozza/)).toBeVisible();
  expect(await left()).toBeLessThan(before);
  await expect(card.locator('.wg-reasons li').filter({ hasText: 'Migliorare le relazioni' }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('modalità mappa Opinione, Trattati e Voto: cambio senza errori in console, legenda e voto di una risoluzione', async ({ page }) => {
  const errors: string[] = [];
  await newCampaign(page, errors);
  type M = { getPaintProperty: (layer: string, prop: string) => unknown[]; getCanvas: () => HTMLCanvasElement };
  const colors = () => page.evaluate(() => ((window as unknown as { __wgMap: M }).__wgMap.getPaintProperty('countries-fill', 'fill-color') as unknown[]).length);

  // un'unica espressione `match` per tutti gli Stati: ISO3 e colore a coppie, non un layer per paese
  const modes = page.locator('#wg-modes');
  await modes.getByRole('button', { name: 'opinione' }).click();
  await expect(page.locator('#wg-legend')).toContainText('Opinione');
  await expect(page.locator('#wg-legend')).toContainText('ostile');
  await expect.poll(colors).toBeGreaterThan(300);
  await page.locator('#wg-legend').getByRole('button', { name: 'Stati → Italia' }).click();
  await expect(page.locator('#wg-legend')).toContainText('solo la fascia');
  await shot(page, 'modalita-opinione');
  await modes.getByRole('button', { name: 'trattati' }).click();
  await expect(page.locator('#wg-legend')).toContainText('Difesa');
  await openState(page, 'Polonia');
  await expect(page.locator('#wg-legend')).toContainText('Trattati: Polonia');
  await modes.getByRole('button', { name: 'voto' }).click();
  await expect(page.locator('#wg-legend')).toContainText('Nessuna votazione ancora');

  // una risoluzione all'Assemblea generale dal pannello Istituzioni: entra nella bozza, il voto si tiene col turno
  await page.getByRole('button', { name: 'Istituzioni', exact: true }).click();
  await page.getByPlaceholder('Oggetto della risoluzione').fill('Appello umanitario nel Mediterraneo');
  await page.getByRole('button', { name: 'Proponi risoluzione' }).click();
  await expect(page.getByText(/RESOLUTION/)).toBeVisible();
  await page.getByRole('button', { name: 'Esegui turno' }).click();
  await expect(page.getByText(/^T2 ·/)).toBeVisible({ timeout: 60_000 });

  await modes.getByRole('button', { name: 'voto' }).click();
  await expect(page.locator('#wg-legend')).toContainText('Appello umanitario nel Mediterraneo');
  await expect(page.locator('#wg-legend')).toContainText(/approvata|respinta/);
  await expect(page.locator('#wg-legend')).toContainText(/\d+ sì · \d+ no · \d+ astenuti/);
  await expect.poll(colors).toBeGreaterThan(300);
  await shot(page, 'modalita-voto');
  for (const m of ['opinione', 'trattati', 'voto', 'politica']) await modes.getByRole('button', { name: m, exact: true }).click();

  // reazioni internazionali: nessun evento, nessun errore
  await page.getByRole('button', { name: 'Reazioni internazionali', exact: true }).click();
  await expect(page.getByText(/Nessuna reazione registrata|Condannano|Tacciono|Sostengono/).first()).toBeVisible();
  expect(errors).toEqual([]);
});
