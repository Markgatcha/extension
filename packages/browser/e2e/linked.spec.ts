import { test, expect } from './fixtures';

const shots = process.env.LINKED_SHOTS;

test.describe('Linked to Hanzo', () => {
  test('unlinked, then linked with the exact last heartbeat', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 380, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.locator('#open-settings').click();
    await page.locator('#sec-linked > summary').click();

    await expect(page.locator('#linked-status')).toHaveText('Not linked.');
    await expect(page.locator('#linked-link')).toBeVisible();
    await expect(page.locator('#linked-unlink')).toBeHidden();
    if (shots) await page.locator('#sec-linked').screenshot({ path: `${shots}/unlinked.png` });

    const [worker] = context.serviceWorkers();
    const body = JSON.stringify({
      at: '2026-11-20T10:00:00Z',
      version: '1.9.75',
      zap: '',
      providers: [{ provider: 'claude', instance: 'claude-1', kind: 'login', state: 'ready' }],
      busy: 0,
      sig: 'c2lnbmF0dXJl',
    });
    await worker.evaluate(
      (b) =>
        chrome.storage.local.set({
          hanzo_source_link: { id: 'src_0123456789abcdef0123456789abcdef', interval: 30, level: 'metadata' },
          hanzo_source_beat: { body: b, at: '2026-11-20T10:00:00Z' },
        }),
      body,
    );

    // Signed in, so the shared sources view mounts; cloud answers one browser source.
    await worker.evaluate(() =>
      chrome.storage.local.set({ hanzo_iam_access_token: 'e2e-token', hanzo_iam_expires_at: Date.now() + 3_600_000 }),
    );
    await context.route('https://api.hanzo.ai/v1/sources**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          sources: [{ id: 'src_0123456789abcdef0123456789abcdef', kind: 'browser', name: 'chrome (Hanzo extension)', os: 'chrome 137', arch: 'arm', version: '1.9.78', state: 'online', linked_at: '2026-11-20T09:00:00Z', providers: [{ provider: 'claude', instance: 'claude-1', kind: 'login', state: 'ready', shared: false }] }],
        }),
      }),
    );

    await page.reload();
    await page.locator('#open-settings').click();
    await page.locator('#sec-linked > summary').click();
    await page.locator('#linked-sent > summary').click();

    await expect(page.locator('#linked-status')).toContainText('Linked.');
    await expect(page.locator('#linked-unlink')).toBeVisible();
    await expect(page.locator('#linked-link')).toBeHidden();
    await expect(page.locator('#linked-beat')).toContainText('"provider": "claude"');
    await expect(page.locator('#linked-beat')).not.toContainText(/token|cookie/i);
    await expect(page.locator('#linked-sources')).toContainText(/chrome/i, { timeout: 10_000 });
    if (shots) await page.locator('#sec-linked').screenshot({ path: `${shots}/linked.png` });
  });
});
