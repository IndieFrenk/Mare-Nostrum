import { expect, test } from '@playwright/test';

const ALLOWED = new Set(['127.0.0.1:5174', '127.0.0.1:8788']);

test('un turno completo con LLM mock, senza rete verso servizi esterni', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && !ALLOWED.has(u.host)) external.push(r.url()); });
  await page.goto('/wargame.html');
  await page.getByPlaceholder('Seed (opzionale)').fill(`e2e-${Date.now()}`);
  await page.getByRole('button', { name: 'Crea' }).click();
  await expect(page.getByText('PLAYER_ORDERS')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Quadro strategico')).toBeVisible();

  await page.getByRole('button', { name: /^Console Ordini/ }).click();
  await page.getByPlaceholder(/Manda la Bergamini/).fill('Manda la Margottini a pattugliare il Canale di Sicilia');
  await page.getByRole('button', { name: 'Interpreta → bozza' }).click();
  await expect(page.getByText(/Margottini → ITA-F592/)).toBeVisible();
  await page.getByRole('button', { name: 'Valida' }).click();
  await expect(page.getByText(/Ordini validi/)).toBeVisible();

  // grand strategy: selezione dall'OOB, tasto destro su una zona di mare, clic su un paese
  await page.getByRole('button', { name: 'Ordine di Battaglia' }).click();
  await page.getByText('Carlo Bergamini (F 590)').click();
  await page.getByRole('button', { name: 'Ordine di Battaglia' }).click(); // chiude il pannello: la mappa resta libera
  type M = { jumpTo: (o: object) => void; project: (p: number[]) => { x: number; y: number }; getCanvas: () => HTMLCanvasElement };
  await page.evaluate(() => (window as unknown as { __wgMap: M }).__wgMap.jumpTo({ center: [18, 36], zoom: 3.6 }));
  await page.waitForTimeout(1500);
  const at = (lon: number, lat: number) => page.evaluate(([a, b]) => {
    const m = (window as unknown as { __wgMap: M }).__wgMap;
    const r = m.project([a!, b!]); const c = m.getCanvas().getBoundingClientRect();
    return { x: r.x + c.left, y: r.y + c.top };
  }, [lon, lat]);
  let p = await at(16, 33.8);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await expect(page.getByText('PATROL → MAR_LIBICO')).toBeVisible();
  p = await at(34.5, 39.1);
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('.wg-country header')).toContainText('TURCHIA');
  await page.getByRole('button', { name: 'Rassicurare' }).click();
  await page.getByRole('button', { name: /^Briefing/ }).click(); // i pulsanti del menu aprono/chiudono il pannello

  await page.getByRole('button', { name: 'Esegui turno' }).click();
  await expect(page.getByText(/^T2 ·/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Ordine di Battaglia/ }).click();
  await expect(page.getByRole('row', { name: /Carlo Margottini.*CANALE_SICILIA.*deployed/ })).toBeVisible();
  await page.getByRole('button', { name: /^Briefing/ }).click();
  await expect(page.getByText('Debriefing')).toBeVisible();
  expect(external).toEqual([]);
});
