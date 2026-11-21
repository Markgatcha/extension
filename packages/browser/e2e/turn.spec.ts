import { test, expect } from './fixtures';
import { gateway, says, signedIn } from './gateway';

/**
 * One whole turn in the real sidebar: type, send, watch the agent's answer land
 * as a thread, at the bottom.
 *
 * A unit test proves almost nothing about this surface. The chat is
 * `@hanzo/ui/chat` on the gui runtime, inside an MV3 extension page under a
 * `script-src 'self'` policy, over a thread the service worker runs, none of
 * which a jsdom render exercises. So this runs the built extension in Chrome.
 */

/** Enough prose to overflow a 800px-tall sidebar, so following is observable. */
const REPLY = [
  '# Anchoring\n\n',
  'The thread follows an answer to the bottom.\n\n',
  ...Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of the answer.\n\n`),
  'Here is a fenced block:\n\n```ts\nexport const pong = () => "pong";\n```\n',
].join('');

test.describe('a turn in the sidebar', () => {
  test('types, sends, answers, and stays at the bottom', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/sidebar.html`);
    await signedIn(page);
    await page.reload();
    await gateway(context, [says(REPLY)]);

    const composer = page.locator('[data-slot="composer"]');
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const field = page.locator('[data-slot="composer-field"]');
    const send = page.locator('[data-slot="composer-send"]');
    const turns = page.locator('[data-slot="message"]');

    // An empty thread says so, as a system turn.
    await expect(turns).toHaveCount(1);
    await expect(turns).toHaveAttribute('data-role', 'system');

    // Send is dead until there is something other than whitespace to send.
    await expect(send).toBeDisabled();
    await field.fill('   ');
    await expect(send).toBeDisabled();

    // Shift+Enter writes a newline instead of sending.
    await field.fill('first line');
    await field.press('Shift+Enter');
    await field.pressSequentially('second line');
    expect(await field.inputValue()).toContain('\n');
    await expect(turns).toHaveCount(1);

    // Enter sends.
    await field.fill('Say pong.');
    await expect(send).toBeEnabled();
    await field.press('Enter');

    // The question is a user turn; the answer is an assistant turn.
    await expect(turns).toHaveCount(2, { timeout: 15_000 });
    await expect(turns.nth(0)).toHaveAttribute('data-role', 'user');
    await expect(turns.nth(0)).toContainText('Say pong.');
    await expect(turns.nth(1)).toHaveAttribute('data-role', 'assistant');

    // Markdown became real elements, and the fenced block became the shell's Code.
    const answer = turns.nth(1);
    await expect(answer.locator('h2')).toHaveText('Anchoring', { timeout: 20_000 });
    await expect(answer).toContainText('Line 24 of the answer.');
    const code = answer.locator('[data-slot="code"]');
    await expect(code).toContainText('export const pong');
    await expect(answer).not.toContainText('```');

    // The draft is cleared and the composer is live again.
    expect(await field.inputValue()).toBe('');

    // Scroll anchoring: the thread followed the answer down.
    const atBottom = await page
      .locator('[data-slot="thread"]')
      .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(atBottom).toBeLessThanOrEqual(48);
    await page.screenshot({ path: 'test-results/sidebar-turn.png' });

    // The question sits inside the column's gutter rather than against the edge.
    const thread = page.locator('[data-slot="thread"]');
    await thread.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForFunction(() => (document.querySelector('[data-slot="thread"]') as HTMLElement).scrollTop === 0);
    const bubble = page.locator('[data-bubble="true"]');
    const [right, width] = await Promise.all([bubble.evaluate((el) => el.getBoundingClientRect().right), page.evaluate(() => window.innerWidth)]);
    expect(width - right).toBeGreaterThanOrEqual(8);
  });

  test('the same thread is in the popup: one chat everywhere', async ({ context, extensionId }) => {
    const sidebar = await context.newPage();
    await sidebar.goto(`chrome-extension://${extensionId}/sidebar.html`);
    await signedIn(sidebar);
    await sidebar.reload();
    await gateway(context, [says('One chat.')]);
    await sidebar.locator('[data-slot="composer-field"]').fill('hello');
    await sidebar.locator('[data-slot="composer-field"]').press('Enter');
    await expect(sidebar.locator('[data-slot="message"][data-role="assistant"]')).toContainText('One chat.', { timeout: 15_000 });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator('#thread .msg-user')).toHaveText('hello');
    await expect(popup.locator('#thread .msg-assistant')).toHaveText('One chat.');
  });
});
