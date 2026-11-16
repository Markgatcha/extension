import { test, expect } from './fixtures';

/**
 * Inspect → the agent. A pick on a page is described from the page's MAIN
 * world (where React keeps its fiber), kept in storage.session, and served to
 * hanzo-mcp as `browser action=inspected`.
 */

const PAGE = `<!doctype html><title>Inspect</title>
<section><button id="cta" class="cta border-bright">Try Hanzo</button><p id="plain">plain</p></section>`;

async function open(context: any) {
  await context.route('http://inspect.test/**', (r: any) => r.fulfill({ contentType: 'text/html', body: PAGE }));
  const page = await context.newPage();
  await page.goto('http://inspect.test/');
  // What a React 18 dev build leaves on the node (MAIN world only).
  await page.evaluate(() => {
    function Hero() {}
    function Landing() {}
    const landing = { type: Landing, return: null };
    const hero = { type: Hero, return: landing, _debugSource: { fileName: '/repo/src/Hero.tsx', lineNumber: 42, columnNumber: 7 }, _debugOwner: { type: Hero } };
    (document.getElementById('cta') as any)['__reactFiber$e2e'] = { type: 'button', return: hero };
  });
  await page.waitForTimeout(300); // content script attached
  return page;
}

async function picked(context: any) {
  const [sw] = context.serviceWorkers();
  for (let i = 0; i < 50; i++) {
    const rec = await sw.evaluate(async () => (await chrome.storage.session.get('hanzo.inspected'))['hanzo.inspected']?.latest);
    if (rec) return rec;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

test.describe('Inspect', () => {
  test('the tools are on the popup’s first tab', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator('#tab-chat #tool-picker')).toBeVisible();
    await expect(popup.locator('#tab-chat #tool-screenshot')).toBeVisible();
    await expect(popup.locator('#tool-picker')).toContainText('Inspect');
  });

  test('a shortcut pick reaches the agent with its React source', async ({ context, extensionId }) => {
    void extensionId;
    const page = await open(context);
    await page.locator('#cta').click({ modifiers: ['Control'] });
    const rec = await picked(context);
    expect(rec).toMatchObject({
      picked: true,
      url: 'http://inspect.test/',
      tag: 'button',
      id: 'cta',
      classes: ['cta', 'border-bright'],
      text: 'Try Hanzo',
      components: ['Hero', 'Landing'],
      source: { at: '/repo/src/Hero.tsx:42:7', via: 'react', component: 'Hero' },
    });
    expect(rec.styles).toHaveProperty('border');
    await expect(page.locator('#hanzo-pick-toast')).toContainText('Hero.tsx:42');
    await expect(page.locator('[data-hanzo-picked]')).toHaveCount(0);
  });

  test('Inspect mode picks the clicked element without clicking it', async ({ context, extensionId }) => {
    void extensionId;
    const page = await open(context);
    let clicks = 0;
    await page.exposeFunction('countClick', () => { clicks++; });
    await page.evaluate(() => document.getElementById('plain')!.addEventListener('click', () => (window as any).countClick()));
    const [sw] = context.serviceWorkers();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://inspect.test/*' });
      await chrome.tabs.sendMessage(tab.id!, { action: 'tool.picker.start' });
    });
    await page.locator('#plain').hover();
    await page.locator('#plain').click();
    const rec = await picked(context);
    expect(rec).toMatchObject({ tag: 'p', id: 'plain', selector: '#plain' });
    expect(clicks).toBe(0);
  });
});
