import { expect, test } from '@playwright/test';

/**
 * Regression tests for the super-admin authorization gate.
 *
 * These tests verify that a normal (non-super-admin) authenticated user
 * cannot access admin-only endpoints. The super-admin guard runs after the
 * session guard and returns null (→ 401) when `principal.data.isSuperAdmin`
 * is false.
 *
 * The DB is shared across the run (reset once at server boot), so the
 * super-admin created by 01-setup.spec.ts is available here.
 */
test.describe('Authorization', () => {
  test('super admin can create a normal user', async ({ request }) => {
    // Login as super admin to get a session cookie for API calls.
    const loginResp = await request.post('/api/auth/login', {
      data: { email: 'admin@tsir.local', password: 'supersecret123', captchaToken: '' },
    });
    expect(loginResp.status()).toBe(200);

    // Create a normal user.
    const createResp = await request.post('/api/users', {
      data: { email: 'normal@tsir.local', password: 'normalpass123' },
    });
    expect(createResp.status()).toBe(201);
    const body = (await createResp.json()) as { isSuperAdmin: boolean };
    expect(body.isSuperAdmin).toBe(false);
  });

  test('normal user is denied admin API endpoints', async ({ request }) => {
    // Login as the normal user.
    const loginResp = await request.post('/api/auth/login', {
      data: { email: 'normal@tsir.local', password: 'normalpass123', captchaToken: '' },
    });
    expect(loginResp.status()).toBe(200);

    // Every admin endpoint must return 401 (unauthorized) for a non-super-admin.
    const adminEndpoints = [
      { method: 'GET', url: '/api/users' },
      { method: 'GET', url: '/api/roles' },
      { method: 'GET', url: '/api/permissions' },
      { method: 'GET', url: '/api/groups' },
      { method: 'GET', url: '/api/i18n/keys' },
      { method: 'GET', url: '/api/email-templates' },
      { method: 'GET', url: '/api/requests' },
      { method: 'GET', url: '/api/queues/counts' },
      { method: 'GET', url: '/api/features' },
    ];

    for (const endpoint of adminEndpoints) {
      const resp = await request.fetch(endpoint.url, { method: endpoint.method });
      expect(
        resp.status(),
        `${endpoint.method} ${endpoint.url} should be denied for normal user`,
      ).toBe(401);
    }
  });

  test('normal user can still log out', async ({ request }) => {
    // Login as the normal user.
    const loginResp = await request.post('/api/auth/login', {
      data: { email: 'normal@tsir.local', password: 'normalpass123', captchaToken: '' },
    });
    expect(loginResp.status()).toBe(200);

    // Logout must work for any authenticated user (session-only, not super-admin).
    const logoutResp = await request.post('/api/auth/logout');
    expect(logoutResp.status()).toBe(200);
  });
});
