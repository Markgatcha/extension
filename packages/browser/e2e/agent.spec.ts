import { test, expect } from './fixtures';
import type { BrowserContext, Page, Worker } from '@playwright/test';

/**
 * The popup is a chat that acts in the page; everything else is in settings and
 * pinnable to it.
 *
 * Only what is outside the extension is stood in for: the identity (a token
 * seeded into extension storage, which the background's real
 * `getValidAccessToken` accepts) and the model (scripted answers on the service
 * worker's `fetch` for the real `/v1/chat/completions` URL: a page route cannot
 * reach a worker). The thread, the loop, the tools and the page engine are the
 * shipped code, driving a real page.
 */

const SHOP = `<!doctype html><title>Shop</title>
<main>
  <h1>Corner Shop</h1>
  <button id="buy" onclick="document.getElementById('status').textContent = 'Bought one'">Buy</button>
  <p id="status">Nothing yet</p>
</main>`;

async function signedIn(popup: Page) {
  await popup.evaluate(
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
async function gateway(context: BrowserContext, replies: Array<object | null>): Promise<Worker> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate((scripted) => {
    const g = self as any;
    g.__replies = scripted;
    g.__requests = [];
    g.__realFetch ??= self.fetch.bind(self);
    self.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== 'https://api.hanzo.ai/v1/chat/completions') return g.__realFetch(input, init);
      g.__requests.push(JSON.parse(init.body));
      const next = g.__replies.shift();
      if (next === null) {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
      }
      return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  }, replies);
  return sw;
}

const says = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });
const calls = (...tool_calls: Array<{ id: string; name: string; args: object }>) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    },
  }],
});

async function open(context: BrowserContext, extensionId: string) {
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 560 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await signedIn(popup);
  await popup.reload();
  return popup;
}

test.describe('the popup is a chat', () => {
  test('the main view is the thread and the composer, nothing else', async ({ context, extensionId }) => {
    const popup = await open(context, extensionId);

    await expect(popup.locator('#thread')).toBeVisible();
    await expect(popup.locator('#search-input')).toBeVisible();
    await expect(popup.locator('#model-select-btn')).toBeVisible();
    // The tools, usage and bridges live in settings, and nothing is pinned yet.
    await expect(popup.locator('#tool-picker')).toBeHidden();
    await expect(popup.locator('#usage-list')).toBeHidden();
    await expect(popup.locator('#zap-status')).toBeHidden();
    await expect(popup.locator('#pins')).toBeHidden();
    await popup.screenshot({ path: 'test-results/popup-chat.png' });
  });

  test('settings holds every feature, and a pin puts one on the chat view', async ({ context, extensionId }) => {
    const popup = await open(context, extensionId);

    await popup.locator('#open-settings').click();
    await expect(popup.locator('#main-section')).toBeHidden();
    for (const id of ['picker', 'screenshot', 'pageinfo', 'accessibility', 'performance', 'console']) {
      await expect(popup.locator(`#tool-${id}`)).toBeVisible();
    }
    await expect(popup.locator('#sec-accounts')).toBeVisible();
    await expect(popup.locator('#sec-bridges')).toBeVisible();
    await popup.screenshot({ path: 'test-results/popup-settings.png' });

    // Pin a tool and a panel; a pin on a section's summary does not open the section.
    await popup.locator('[data-pin="picker"]').click();
    await popup.locator('[data-pin="bridges"]').click();
    await expect(popup.locator('[data-pin="picker"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(popup.locator('#sec-bridges')).not.toHaveAttribute('open', '');

    await popup.locator('#back-btn').click();
    const chips = popup.locator('#pins .pin-chip');
    await expect(chips).toHaveText(['Inspect', 'Bridges']);
    await popup.screenshot({ path: 'test-results/popup-pinned.png' });

    // Pins survive the popup closing.
    await popup.reload();
    await expect(popup.locator('#pins .pin-chip')).toHaveText(['Inspect', 'Bridges']);

    // A panel chip opens its section in settings, loaded.
    await popup.locator('#pins .pin-chip', { hasText: 'Bridges' }).click();
    await expect(popup.locator('#settings-section')).toBeVisible();
    await expect(popup.locator('#sec-bridges')).toHaveAttribute('open', '');

    // Unpin and it leaves the chat view.
    await popup.locator('[data-pin="picker"]').click();
    await popup.locator('[data-pin="bridges"]').click();
    await popup.locator('#back-btn').click();
    await expect(popup.locator('#pins')).toBeHidden();
  });

  test('signing out in settings leaves you in settings', async ({ context, extensionId }) => {
    const popup = await open(context, extensionId);
    await popup.locator('#open-settings').click();
    await expect(popup.locator('#user-info-section')).toBeVisible();

    await popup.locator('#logout-btn').click();
    // The session change reaches the popup; the view it is in does not change.
    await expect(popup.locator('#user-info-section')).toBeHidden();
    await expect(popup.locator('#settings-section')).toBeVisible();
    await expect(popup.locator('#main-section')).toBeHidden();

    await popup.locator('#back-btn').click();
    await expect(popup.locator('#login-section')).toBeVisible();
  });

  test('typing a question and pressing Enter draws the exchange', async ({ context, extensionId }) => {
    const popup = await open(context, extensionId);
    await gateway(context, [says('Pong.')]);

    await popup.locator('#search-input').fill('Say pong.');
    await popup.locator('#search-input').press('Enter');

    await expect(popup.locator('#thread .msg-user')).toHaveText('Say pong.');
    await expect(popup.locator('#thread .msg-assistant')).toHaveText('Pong.');
    await expect(popup.locator('#search-input')).toHaveValue('');
    await expect(popup.locator('#ask-btn')).toHaveAttribute('data-busy', 'false');
    await popup.screenshot({ path: 'test-results/popup-answer.png' });

    // A new thread clears it, here and in the worker.
    await popup.locator('#popup-new-thread-btn').click();
    await expect(popup.locator('#thread .msg')).toHaveCount(0);
    await expect(popup.locator('#thread-empty')).toBeVisible();
  });

  test('the chat acts in the page: looks, clicks, answers', async ({ context, extensionId }) => {
    await context.route('http://shop.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SHOP }));
    const shop = await context.newPage();
    await shop.goto('http://shop.test/');

    const popup = await open(context, extensionId);
    const sw = await gateway(context, [
      calls({ id: 'a', name: 'snapshot', args: { interactive: true } }),
      // The ref is the one the snapshot above hands out: the first element.
      calls({ id: 'b', name: 'act', args: { op: 'click', selector: '@e1' } }),
      says('Bought one.'),
    ]);

    // The popup is its own tab in this harness, so the turn is aimed at the shop
    // the way the button aims it at the active tab: with its id.
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://shop.test/*' }))[0].id);
    await popup.evaluate(
      (id) => chrome.runtime.sendMessage({ action: 'agent.send', text: 'buy one', model: 'zen6', tabId: id }),
      tabId,
    );

    const steps = popup.locator('#thread .msg-step');
    await expect(steps).toHaveText(['look at the page', 'click @e1']);
    await expect(popup.locator('#thread .msg-assistant')).toHaveText('Bought one.');
    // The page really changed.
    await expect(shop.locator('#status')).toHaveText('Bought one');

    // What the model was shown: the page as text, with a ref on the button.
    const requests = await sw.evaluate(() => (self as any).__requests);
    const shown = requests[1].messages.at(-1).content as string;
    expect(shown).toContain('Shop — http://shop.test/');
    expect(shown).toMatch(/button "Buy" \[ref=e1\]/);
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(['snapshot', 'read', 'act', 'navigate', 'wait']);
    await popup.screenshot({ path: 'test-results/popup-acting.png' });
  });

  test('the on-page chat is the same agent, and acts on its own tab', async ({ context, extensionId }) => {
    await context.route('http://shop.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SHOP }));
    const shop = await context.newPage();
    await shop.goto('http://shop.test/');
    await open(context, extensionId); // seeds the identity
    const sw = await gateway(context, [
      calls({ id: 'a', name: 'snapshot', args: { interactive: true } }),
      calls({ id: 'b', name: 'act', args: { op: 'click', selector: '@e1' } }),
      says('Done: bought one.'),
    ]);

    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://shop.test/*' });
      await chrome.tabs.sendMessage(tab.id!, { action: 'page.overlay.show' });
    });
    await shop.bringToFront();
    const panel = shop.locator('#hanzo-page-overlay-root');
    await expect(panel).toHaveAttribute('data-open', 'true');

    await panel.locator('[data-role="input"]').fill('buy one');
    await panel.locator('[data-role="input"]').press('Enter');

    // No tab id was sent: the background took it from the page that asked.
    await expect(panel.locator('.hanzo-page-msg.step')).toHaveText(['look at the page', 'click @e1']);
    await expect(panel.locator('.hanzo-page-msg.assistant').last()).toHaveText('Done: bought one.');
    await expect(shop.locator('#status')).toHaveText('Bought one');
    await expect(panel.locator('[data-role="send"]')).toHaveText('Send');
    await shop.screenshot({ path: 'test-results/overlay-acting.png' });
  });

  test('the thread outlives the popup: close it, open it, the work is there', async ({ context, extensionId }) => {
    const popup = await open(context, extensionId);
    await gateway(context, [says('Still here.')]);
    await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'agent.send', text: 'hello', model: 'enso' }));
    await expect(popup.locator('#thread .msg-assistant')).toHaveText('Still here.');
    await popup.close();

    const again = await context.newPage();
    await again.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(again.locator('#thread .msg-user')).toHaveText('hello');
    await expect(again.locator('#thread .msg-assistant')).toHaveText('Still here.');
  });

  test('send is Stop while a turn runs', async ({ context, extensionId }) => {
    const popup = await open(context, extensionId);
    await gateway(context, [null]);

    await popup.locator('#search-input').fill('take your time');
    await popup.locator('#ask-btn').click();
    await expect(popup.locator('#ask-btn')).toHaveAttribute('data-busy', 'true');
    await expect(popup.locator('#thread .working')).toBeVisible();

    await popup.locator('#ask-btn').click();
    await expect(popup.locator('#thread .msg-assistant')).toHaveText('Stopped.');
    await expect(popup.locator('#ask-btn')).toHaveAttribute('data-busy', 'false');
  });

  test('signed out, the chat asks for sign-in instead of failing silently', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator('#login-section')).toBeVisible();

    await popup.locator('#search-input').fill('hello');
    await popup.locator('#search-input').press('Enter');
    await expect(popup.locator('#thread .msg-error')).toContainText('Sign in to Hanzo');
  });
});
