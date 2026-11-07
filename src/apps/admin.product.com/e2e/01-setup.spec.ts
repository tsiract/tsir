import { expect, test, type Page } from '@playwright/test';

/**
 * The SPA shows "Loading…" while it boots and checks install/auth state.
 * Wait for it to disappear before asserting on the routed page.
 */
async function waitForBoot(page: Page): Promise<void> {
  await expect(page.getByText('Loading…')).not.toBeVisible({ timeout: 10_000 });
}

test.describe('Setup flow', () => {
  test('shows the setup page when the app is not installed', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: 'Set up Tsir Admin' })).toBeVisible();
  });

  test('creates the first admin account', async ({ page }) => {
    await page.goto('/setup');
    await waitForBoot(page);
    await page.getByLabel('Email').fill('admin@tsir.local');
    await page.getByLabel('Password').fill('supersecret123');
    await page.getByRole('button', { name: 'Install admin' }).click();
    await expect(page.getByText(/Admin created/)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/, { timeout: 5_000 });
  });
});
