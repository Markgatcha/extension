import type { BrowserContext, Page, Worker } from '@playwright/test';

/**
 * What is outside the extension, stood in for: the identity (a token seeded into
 * extension storage, which the background's real `getValidAccessToken` accepts)
 * and the model (scripted answers on the service worker's `fetch` for the real
 * gateway URLs: a page route cannot reach a worker). Everything between them is
 * the shipped code.
 */

export async function signedIn(page: Page) {
  await page.evaluate(
    (expiresAt) =>
      new Promise<void>((resolve) =>
        chrome.storage.local.set(
          { hanzo_iam_access_token: 'e2e-token', hanzo_iam_expires_at: expiresAt, hanzo_iam_user: { name: 'E2E', email: 'z@hanzo.ai' } },
          () => resolve(),
        ),
      ),
    Date.now() + 3_600_000,
  );
}

/** Script the gateway inside the worker: each call takes the next reply; a reply of null waits for the abort. */
export async function gateway(context: BrowserContext, replies: Array<object | null>): Promise<Worker> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate((scripted) => {
    const g = self as any;
    g.__replies = scripted;
    g.__requests = [];
    g.__realFetch ??= self.fetch.bind(self);
    self.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.hanzo.ai/v1/') || url === 'https://api.hanzo.ai/v1/models') return g.__realFetch(input, init);
      g.__requests.push({ url, ...JSON.parse(init.body) });
      const next = g.__replies.shift();
      if (next === null) {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
      }
      return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  }, replies);
  return sw;
}

export const says = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });

export const calls = (...tool_calls: Array<{ id: string; name: string; args: object }>) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    },
  }],
});
