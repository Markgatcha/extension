// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The in-page assistant, from the real content script.
 *
 * Its model picker offers Auto and the Zen chat rows of GET /v1/models, which
 * it reads the way the sidebar does (`chat.listModels`), and Auto resolves the
 * way the sidebar's does. Nothing in it is a model name the extension typed
 * itself. Its chat is the background agent's: a question goes out as
 * `agent.send`, and the thread comes back on the `agent` port.
 */

vi.mock('webextension-polyfill', () => ({}));

/** Rows in the shape api.hanzo.ai/v1/models answers. */
const rows = [
  { id: 'aion-labs/aion-2.0', owned_by: 'aion-labs' },
  { id: 'enso', owned_by: 'hanzo' },
  { id: 'zen6', owned_by: 'zenlm', name: 'Zen 6' },
  { id: 'zen5', owned_by: 'zenlm', name: 'Legacy Zen5' },
  { id: 'qwen2-72b', owned_by: 'zenlm', name: 'Legacy Qwen2' },
  { id: 'zen-embedding', owned_by: 'zenlm' },
  { id: 'zen-guard', owned_by: 'zenlm' },
  { id: 'zen6-flash', owned_by: 'zenlm' },
  { id: 'openai/gpt-oss-120b', owned_by: 'openai' },
];

const sent: Array<Record<string, unknown>> = [];
type Port = { name: string; push: (m: unknown) => void };
const ports: Port[] = [];
const listeners: Array<(request: unknown, sender: unknown, respond: (r: unknown) => void) => unknown> = [];

beforeAll(async () => {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: 'test',
      getURL: (p: string) => p,
      connect: ({ name }: { name: string }) => {
        const received: Array<(m: unknown) => void> = [];
        ports.push({ name, push: (m) => received.forEach((f) => f(m)) });
        return { onMessage: { addListener: (f: (m: unknown) => void) => received.push(f) }, onDisconnect: { addListener: () => {} } };
      },
      onMessage: { addListener: (fn: (typeof listeners)[number]) => listeners.push(fn) },
      sendMessage: async (message: Record<string, unknown>) => {
        sent.push(message);
        if (message.action === 'chat.listModels') return { success: true, models: rows };
        return { success: true };
      },
    },
    storage: {
      local: { get: async () => ({}) },
      sync: { get: async () => ({}), set: () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  await import('../src/content-script');
});

const select = () => document.querySelector<HTMLSelectElement>('#hanzo-page-overlay-root select[data-role="model"]')!;
const offered = () => Array.from(select().options, (o) => [o.value, o.textContent]);

describe('page assistant models', () => {
  it('offers Auto, then the Zen chat models of /v1/models, with Auto selected', async () => {
    expect(offered()).toEqual([['auto', 'Auto']]);
    for (const fn of listeners) fn({ action: 'page.overlay.show' }, {}, () => {});
    await vi.waitFor(() => expect(offered().length).toBe(3));
    expect(offered()).toEqual([['auto', 'Auto'], ['zen6', 'Zen 6'], ['zen6-flash', 'zen6-flash']]);
    expect(select().value).toBe('auto');
  });

  it('sends Auto as the sidebar does: zen6-flash for a short question', async () => {
    const input = document.querySelector<HTMLTextAreaElement>('#hanzo-page-overlay-root [data-role="input"]')!;
    input.value = 'What is this page?';
    document.querySelector<HTMLButtonElement>('#hanzo-page-overlay-root [data-role="send"]')!.click();
    await vi.waitFor(() => expect(sent.some((m) => m.action === 'agent.send')).toBe(true));
    const turn = sent.find((m) => m.action === 'agent.send')!;
    expect(turn.model).toBe('zen6-flash');
    expect(turn.text).toBe('What is this page?');
    // The page rides along as context for the model; the tab is the sender's.
    expect(String(turn.context)).toContain('URL: ');
    expect(turn).not.toHaveProperty('tabId');
  });
});

describe('page assistant thread', () => {
  const messages = () => Array.from(document.querySelectorAll('#hanzo-page-overlay-root .hanzo-page-msg'), (m) => [m.className.replace('hanzo-page-msg ', ''), m.textContent]);
  const send = () => document.querySelector<HTMLButtonElement>('#hanzo-page-overlay-root [data-role="send"]')!;
  const push = (state: unknown) => ports.filter((p) => p.name === 'agent').forEach((p) => p.push({ action: 'agent.update', state }));

  it('draws the agent\'s thread, steps and failures included, and turns Send into Stop while it works', () => {
    push({
      busy: true,
      page: null,
      turns: [
        { id: '1', role: 'user', content: 'buy it' },
        { id: '2', role: 'step', content: 'click @e1' },
        { id: '3', role: 'assistant', content: '', error: 'Chat API error 402: no plan' },
      ],
    });
    expect(messages()).toEqual([
      ['user', 'buy it'],
      ['step', 'click @e1'],
      ['assistant', 'Error: Chat API error 402: no plan'],
    ]);
    expect(send().textContent).toBe('Stop');

    // Stop is the agent's stop, not another question.
    const before = sent.length;
    send().click();
    expect(sent.slice(before).map((m) => m.action)).toEqual(['agent.stop']);
  });

  it('goes back to the introduction when the thread is cleared', () => {
    push({ busy: false, page: null, turns: [] });
    expect(messages()).toHaveLength(1);
    expect(messages()[0][1]).toContain('Ask about this page');
    expect(send().textContent).toBe('Send');
  });
});
