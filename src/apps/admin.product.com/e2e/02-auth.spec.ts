import { expect, test, type Page } from '@playwright/test';

async function waitForBoot(page: Page): Promise<void> {
  await expect(page.getByText('Loading…')).not.toBeVisible({ timeout: 10_000 });
}

test.describe('Authentication', () => {
  test('login page renders', async ({ page }) => {
    await page.goto('/login');
    await waitForBoot(page);
    await expect(page.getByRole('heading', { name: 'Sign in to Tsir Admin' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('login with valid credentials succeeds', async ({ page }) => {
    await page.goto('/login');
    await waitForBoot(page);
    await page.getByLabel('Email').fill('admin@tsir.local');
    await page.getByLabel('Password').fill('supersecret123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 5_000 });
  });

  test('login with invalid credentials shows an error', async ({ page }) => {
    await page.goto('/login');
    await waitForBoot(page);
    await page.getByLabel('Email').fill('nobody@tsir.local');
    await page.getByLabel('Password').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(/invalid credentials/i)).toBeVisible({ timeout: 5_000 });
  });
});
