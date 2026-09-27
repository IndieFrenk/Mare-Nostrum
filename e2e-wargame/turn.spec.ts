import { expect, test } from '@playwright/test';

const ALLOWED = new Set(['127.0.0.1:5174', '127.0.0.1:8788', 'tiles.openfreemap.org']);

test('un turno completo con LLM mock, senza rete verso servizi esterni', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && !ALLOWED.has(u.host)) external.push(r.url()); });
  await page.goto('/wargame.html');
  await page.getByPlaceholder('Seed (opzionale)').fill(`e2e-${Date.now()}`);
  await page.getByRole('button', { name: 'Crea' }).click();
  await expect(page.getByText('PLAYER_ORDERS')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Quadro strategico')).toBeVisible();

  await page.getByRole('button', { name: /^Console Ordini/ }).click();
  await page.getByPlaceholder(/Pattugliare/).fill('Pattugliare CANALE_SICILIA con ITA-F592');
  await page.getByRole('button', { name: 'Interpreta → bozza' }).click();
  await page.getByRole('button', { name: 'Valida' }).click();
  await expect(page.getByText(/Ordini validi/)).toBeVisible();

  await page.getByRole('button', { name: 'Esegui turno' }).click();
  await expect(page.getByText(/^T2 ·/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Ordine di Battaglia/ }).click();
  await expect(page.getByRole('row', { name: /Carlo Margottini.*CANALE_SICILIA.*deployed/ })).toBeVisible();
  await page.getByRole('button', { name: /^Briefing/ }).click();
  await expect(page.getByText('Debriefing')).toBeVisible();
  expect(external).toEqual([]);
});
