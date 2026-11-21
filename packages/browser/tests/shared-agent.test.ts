/**
 * shared/agent.ts: the chat that acts in the page.
 *
 * The gateway is a fake `fetch` that answers from a script, so what is asserted
 * is the request the loop sends and what it does with each answer. The page
 * engine is shared/drive.ts's `drive`, replaced here: its own suite covers it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/drive.js', () => ({ drive: vi.fn() }));

import { drive } from '../src/shared/drive.js';
import { MAX_RESULT, MAX_STEPS, TOOLS, converse, label, parse, render, startAgent, type AgentState } from '../src/shared/agent.js';

const driven = vi.mocked(drive);

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const says = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });
const wants = (...tool_calls: unknown[]) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls } }] });

/** A gateway that answers each request with the next scripted reply and keeps the requests. */
function gateway(...replies: Array<unknown | (() => Response)>) {
  const requests: any[] = [];
  const fn = vi.fn(async (url: string, init: any) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = replies.shift();
    if (typeof next === 'function') return (next as () => Response)();
    return new Response(JSON.stringify(next), { status: 200 });
  });
  return { fetch: fn as unknown as typeof fetch, requests };
}

describe('converse', () => {
  it('runs the tool the model names and tells it what happened', async () => {
    const gw = gateway(wants(call('c1', 'snapshot', { interactive: true })), says('Found it.'));
    const steps: string[] = [];
    const out = await converse({
      token: 'tok',
      orgId: 'acme',
      model: 'zen6',
      messages: [{ role: 'user', content: 'find the buy button' }],
      fetch: gw.fetch,
      step: (name) => steps.push(name),
      call: async (name, args) => `ran ${name} ${JSON.stringify(args)}`,
    });

    expect(out).toBe('Found it.');
    expect(steps).toEqual(['snapshot']);
    expect(gw.requests[0].url).toBe('https://api.hanzo.ai/v1/chat/completions');
    expect(gw.requests[0].headers).toMatchObject({ Authorization: 'Bearer tok', 'X-Org-Id': 'acme' });
    expect(gw.requests[0].body).toMatchObject({ model: 'zen6', stream: false, tool_choice: 'auto' });
    expect(gw.requests[0].body.tools.map((t: any) => t.function.name)).toEqual(['snapshot', 'read', 'act', 'navigate', 'wait']);
    // The second request carries the model's call and the tool's answer, paired by id.
    const second = gw.requests[1].body.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1' }] });
    expect(second.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ran snapshot {"interactive":true}' });
  });

  it('hands a failing tool to the model as its answer, not as a crash', async () => {
    const gw = gateway(wants(call('c1', 'act', { op: 'click', selector: '@e9' })), says('That ref is gone.'));
    const out = await converse({
      token: 't', model: 'm', messages: [], fetch: gw.fetch, step: () => {},
      call: async () => { throw new Error('ref @e9 is no longer on the page: snapshot again'); },
    });
    expect(out).toBe('That ref is gone.');
    expect(gw.requests[1].body.messages.at(-1).content).toBe('error: ref @e9 is no longer on the page: snapshot again');
  });

  it('answers a model that sends broken arguments with the parse error and never runs the tool', async () => {
    const gw = gateway(wants(call('c1', 'act', '{"op": "click"')), says('ok'));
    const ran = vi.fn(async () => 'x');
    await converse({ token: 't', model: 'm', messages: [], fetch: gw.fetch, step: () => {}, call: ran });
    expect(ran).not.toHaveBeenCalled();
    expect(gw.requests[1].body.messages.at(-1).content).toMatch(/^error: /);
  });

  it('runs several calls in one reply in order', async () => {
    const gw = gateway(wants(call('a', 'navigate', { url: 'https://x.test' }), call('b', 'snapshot', {})), says('done'));
    const order: string[] = [];
    await converse({
      token: 't', model: 'm', messages: [], fetch: gw.fetch, step: () => {},
      call: async (name) => { order.push(name); return name; },
    });
    expect(order).toEqual(['navigate', 'snapshot']);
    const tools = gw.requests[1].body.messages.filter((m: any) => m.role === 'tool');
    expect(tools.map((m: any) => m.tool_call_id)).toEqual(['a', 'b']);
  });

  it('throws the gateway\'s refusal with its status', async () => {
    const gw = gateway(() => new Response('no plan', { status: 402 }));
    await expect(
      converse({ token: 't', model: 'm', messages: [], fetch: gw.fetch, step: () => {}, call: async () => '' }),
    ).rejects.toThrow('Chat API error 402: no plan');
  });

  it('stops a model that never answers in words', async () => {
    const forever = Array.from({ length: MAX_STEPS + 1 }, (_, i) => wants(call(`c${i}`, 'snapshot', {})));
    const gw = gateway(...forever);
    await expect(
      converse({ token: 't', model: 'm', messages: [], fetch: gw.fetch, step: () => {}, call: async () => 'x' }),
    ).rejects.toThrow(`Stopped after ${MAX_STEPS} steps`);
    expect(gw.requests).toHaveLength(MAX_STEPS);
  });

  it('stops between calls once aborted', async () => {
    const ctl = new AbortController();
    const gw = gateway(wants(call('a', 'snapshot', {})), says('never'));
    await expect(
      converse({
        token: 't', model: 'm', messages: [], fetch: gw.fetch, step: () => {}, signal: ctl.signal,
        call: async () => { ctl.abort(); return 'x'; },
      }),
    ).rejects.toThrow();
    expect(gw.requests).toHaveLength(1);
  });
});

describe('tools', () => {
  it('parse takes an object and refuses anything else', () => {
    expect(parse('')).toEqual({});
    expect(parse('{"a":1}')).toEqual({ a: 1 });
    expect(() => parse('[1]')).toThrow('JSON object');
    expect(() => parse('"x"')).toThrow('JSON object');
  });

  it('label says what is being done in a few words', () => {
    expect(label('act', { op: 'click', selector: '@e12' })).toBe('click @e12');
    expect(label('act', { op: 'fill', selector: '@e3', text: 'hello' })).toBe('fill @e3 "hello"');
    expect(label('act', { op: 'press', key: 'Enter' })).toBe('press Enter');
    expect(label('navigate', { url: 'https://a.test/' })).toBe('open https://a.test/');
    expect(label('wait', { text: 'Done' })).toBe('wait "Done"');
    expect(label('snapshot', {})).toBe('look at the page');
    expect(label('read', {})).toBe('read the page');
    expect(label('act', { op: 'fill', selector: '@e1', text: 'x'.repeat(200) }).length).toBeLessThan(90);
  });

  it('render prints the tree and the markdown, and cuts what is too long to read', () => {
    expect(render('snapshot', { title: 'T', url: 'https://a.test/', tree: '- button "Go" [ref=e1]' })).toBe('T — https://a.test/\n- button "Go" [ref=e1]');
    expect(render('read', { title: 'T', url: 'u', markdown: '# Hi' })).toBe('T — u\n\n# Hi');
    expect(render('act', { clicked: 'button "Go"' })).toBe('{"clicked":"button \\"Go\\""}');
    const long = render('snapshot', { title: 'T', url: 'u', tree: 'x'.repeat(MAX_RESULT * 2) });
    expect(long.length).toBeLessThan(MAX_RESULT + 200);
    expect(long).toContain('cut at');
  });

  it('offers every tool as a drive method', () => {
    for (const t of TOOLS) expect(['snapshot', 'read', 'act', 'navigate', 'wait']).toContain(t.function.name);
  });
});

/** The extension API an agent runs on: the corners of it the agent touches. */
function fakeApi(tab = { id: 7, title: 'Shop', url: 'https://shop.test/' } as any) {
  const bucket = (): Record<string, any> => ({});
  const stores = { session: bucket(), local: { activeOrgId: 'acme' } as Record<string, any> };
  const area = (data: Record<string, any>) => ({
    get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))),
    set: vi.fn(async (items: Record<string, any>) => { Object.assign(data, items); }),
  });
  const connected: Array<(port: any) => void> = [];
  const api = {
    stores,
    tabs: { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]) },
    storage: { session: area(stores.session), local: area(stores.local) },
    runtime: { onConnect: { addListener: (l: (port: any) => void) => connected.push(l) }, lastError: undefined },
    action: { setBadgeText: vi.fn(async () => {}) },
    /** A surface opening the `agent` port: what it is sent, as it is sent. */
    open(name = 'agent') {
      const got: AgentState[] = [];
      const gone: Array<() => void> = [];
      const port = {
        name,
        postMessage: (m: any) => { got.push(JSON.parse(JSON.stringify(m.state))); },
        onDisconnect: { addListener: (f: () => void) => gone.push(f) },
      };
      for (const l of connected) l(port);
      return { got, close: () => gone.forEach((f) => f()) };
    },
  };
  return api;
}

const ask = (agent: ReturnType<typeof startAgent>, action: string, request: any = {}) =>
  new Promise<any>((resolve) => { agent.handle(action, request, resolve); });

/** Wait until the turn in flight has ended. */
const settled = async (agent: ReturnType<typeof startAgent>) => {
  await vi.waitFor(() => expect(agent.state.busy).toBe(false));
};

describe('the agent', () => {
  beforeEach(() => driven.mockReset());

  it('answers only agent.* messages', () => {
    const agent = startAgent({ api: fakeApi(), token: async () => 't' });
    expect(agent.handle('zap.status', {}, () => {})).toBe(false);
  });

  it('works a page: looks, acts, answers, and keeps the thread', async () => {
    driven
      .mockResolvedValueOnce({ title: 'Shop', url: 'https://shop.test/', tree: '- button "Buy" [ref=e1]', refs: 1, last: 1 })
      .mockResolvedValueOnce({ clicked: 'button "Buy"' });
    const gw = gateway(
      wants(call('1', 'snapshot', { interactive: true })),
      wants(call('2', 'act', { op: 'click', selector: '@e1' })),
      says('Bought.'),
    );
    const api = fakeApi();
    const agent = startAgent({ api, token: async () => 'tok', fetch: gw.fetch });
    const surface = api.open();
    await vi.waitFor(() => expect(surface.got).toHaveLength(1));

    expect(await ask(agent, 'agent.send', { text: 'buy it', model: 'zen6', tabId: 7 })).toEqual({ success: true });
    expect(agent.state.busy).toBe(true);
    await settled(agent);

    expect(driven.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      [7, 'hanzo.snapshot', { interactive: true }],
      [7, 'hanzo.act', { op: 'click', selector: '@e1' }],
    ]);
    expect(agent.state.turns.map((t) => [t.role, t.content])).toEqual([
      ['user', 'buy it'],
      ['step', 'look at the page'],
      ['step', 'click @e1'],
      ['assistant', 'Bought.'],
    ]);
    // The system prompt names the tab, and the org rides along from storage.
    expect(gw.requests[0].body.messages[0].content).toContain('"Shop" (https://shop.test/)');
    expect(gw.requests[0].headers['X-Org-Id']).toBe('acme');
    // A page's contents reach the model, never storage.
    expect(JSON.stringify(api.stores.session)).not.toContain('Buy');
    expect(api.stores.session.agentThread.turns).toHaveLength(4);
    expect(api.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });

    // A surface on the port saw the thread grow, step by step, and the turn end.
    expect(surface.got[0]).toMatchObject({ turns: [], busy: false });
    expect(surface.got.map((st) => st.turns.length)).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    expect(surface.got.at(-1)).toMatchObject({ busy: false });
    expect(surface.got.at(-1)!.turns.at(-1)).toMatchObject({ role: 'assistant', content: 'Bought.' });

    // A follow-up sees the words said, not the tool traffic.
    const follow = gateway(says('Yes.'));
    const again = startAgent({ api, token: async () => 'tok', fetch: follow.fetch });
    await ask(again, 'agent.send', { text: 'did it work?', model: 'zen6' });
    await settled(again);
    expect(follow.requests[0].body.messages.slice(1).map((m: any) => [m.role, m.content])).toEqual([
      ['user', 'buy it'],
      ['assistant', 'Bought.'],
      ['user', 'did it work?'],
    ]);
  });

  it('asks for sign-in instead of calling the gateway without a session', async () => {
    const gw = gateway();
    const agent = startAgent({ api: fakeApi(), token: async () => undefined, fetch: gw.fetch });
    await ask(agent, 'agent.send', { text: 'hi', model: 'zen6' });
    await settled(agent);
    expect(gw.requests).toHaveLength(0);
    expect(agent.state.turns.at(-1)).toMatchObject({ role: 'assistant', content: '', error: 'Sign in to Hanzo to chat.' });
  });

  it('shows a gateway failure as a failed turn and takes the next question', async () => {
    const gw = gateway(() => new Response('upstream down', { status: 502 }), says('back'));
    const agent = startAgent({ api: fakeApi(), token: async () => 't', fetch: gw.fetch });
    await ask(agent, 'agent.send', { text: 'one', model: 'zen6' });
    await settled(agent);
    expect(agent.state.turns.at(-1)?.error).toBe('Chat API error 502: upstream down');
    await ask(agent, 'agent.send', { text: 'two', model: 'zen6' });
    await settled(agent);
    expect(agent.state.turns.at(-1)).toMatchObject({ role: 'assistant', content: 'back' });
    // The failed turn is not replayed to the model.
    expect(gw.requests[1].body.messages.map((m: any) => m.content)).not.toContain('');
  });

  it('refuses a second turn while one runs, and an empty question', async () => {
    let release: ((r: Response) => void) | undefined;
    const slow = (() => new Promise<Response>((r) => { release = r; })) as unknown as () => Response;
    const gw = gateway(slow);
    const agent = startAgent({ api: fakeApi(), token: async () => 't', fetch: gw.fetch });
    await ask(agent, 'agent.send', { text: 'first', model: 'zen6' });
    expect(await ask(agent, 'agent.send', { text: 'second', model: 'zen6' })).toEqual({ success: false, error: 'a turn is already running' });
    expect(await ask(agent, 'agent.send', { text: '  ', model: 'zen6' })).toMatchObject({ success: false });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release?.(new Response(JSON.stringify(says('ok')), { status: 200 }));
    await settled(agent);
  });

  it('only opens http and https addresses', async () => {
    const gw = gateway(wants(call('1', 'navigate', { url: 'javascript:alert(1)' })), wants(call('2', 'navigate', { url: 'file:///etc/passwd' })), says('no'));
    const agent = startAgent({ api: fakeApi(), token: async () => 't', fetch: gw.fetch });
    await ask(agent, 'agent.send', { text: 'go', model: 'zen6' });
    await settled(agent);
    expect(driven).not.toHaveBeenCalled();
    const answers = gw.requests[2].body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    expect(answers).toEqual(['error: only http and https addresses open', 'error: only http and https addresses open']);
  });

  it('works with no tab: the tools say so and the model can answer', async () => {
    const api = fakeApi();
    api.tabs.query.mockResolvedValue([]);
    const gw = gateway(wants(call('1', 'snapshot', {})), says('Open a page first.'));
    const agent = startAgent({ api, token: async () => 't', fetch: gw.fetch });
    await ask(agent, 'agent.send', { text: 'what is this page', model: 'zen6' });
    await settled(agent);
    expect(driven).not.toHaveBeenCalled();
    expect(gw.requests[1].body.messages.at(-1).content).toBe('error: there is no open tab to work on');
  });

  it('stops the turn in flight', async () => {
    let started!: () => void;
    const began = new Promise<void>((r) => { started = r; });
    const gw = {
      fetch: vi.fn((_u: string, init: any) => new Promise((_, reject) => {
        started();
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      })) as unknown as typeof fetch,
    };
    const agent = startAgent({ api: fakeApi(), token: async () => 't', fetch: gw.fetch });
    await ask(agent, 'agent.send', { text: 'slow', model: 'zen6' });
    await began;
    expect(await ask(agent, 'agent.stop')).toEqual({ success: true });
    await settled(agent);
    expect(agent.state.turns.at(-1)).toMatchObject({ role: 'assistant', content: 'Stopped.' });
  });

  it('reset clears the thread, mid-turn too, and leaves nothing behind', async () => {
    const gw = {
      fetch: vi.fn((_u: string, init: any) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      })) as unknown as typeof fetch,
    };
    const api = fakeApi();
    const agent = startAgent({ api, token: async () => 't', fetch: gw.fetch });
    await ask(agent, 'agent.send', { text: 'slow', model: 'zen6' });
    const out: { state: AgentState } = await ask(agent, 'agent.reset');
    expect(out.state.turns).toEqual([]);
    expect(agent.state.busy).toBe(false);
    expect(api.stores.session.agentThread.turns).toEqual([]);
  });

  it('hands a surface the thread the moment it connects, even after the worker restarted', async () => {
    const api = fakeApi();
    api.stores.session.agentThread = { turns: [{ id: 'a', role: 'user', content: 'before' }] };
    startAgent({ api, token: async () => 't' });
    const surface = api.open();
    await vi.waitFor(() => expect(surface.got).toHaveLength(1));
    expect(surface.got[0]).toEqual({ turns: [{ id: 'a', role: 'user', content: 'before' }], busy: false });
  });

  it('ignores a port that is not the agent\'s, and stops sending to one that closed', async () => {
    const gw = gateway(says('hi'));
    const api = fakeApi();
    const agent = startAgent({ api, token: async () => 't', fetch: gw.fetch });
    const other = api.open('zap-keepalive');
    const closed = api.open();
    await vi.waitFor(() => expect(closed.got).toHaveLength(1));
    closed.close();
    await ask(agent, 'agent.send', { text: 'hello', model: 'zen6' });
    await settled(agent);
    expect(other.got).toHaveLength(0);
    expect(closed.got).toHaveLength(1);
  });

  it('aims a turn at the tab the message came from, and adds a surface\'s context to the prompt', async () => {
    const gw = gateway(says('ok'));
    const api = fakeApi();
    api.tabs.get.mockImplementation(async (id: number) => ({ id, title: 'From the overlay', url: 'https://o.test/' }) as any);
    const agent = startAgent({ api, token: async () => 't', fetch: gw.fetch });
    await new Promise<void>((resolve) => {
      agent.handle('agent.send', { text: 'what is this', model: 'zen6', context: 'ElementSelector: #hero' }, () => resolve(), { tab: { id: 42 } });
    });
    await settled(agent);
    expect(api.tabs.get).toHaveBeenCalledWith(42);
    expect(gw.requests[0].body.messages[0].content).toContain('"From the overlay" (https://o.test/)');
    expect(gw.requests[0].body.messages[0].content).toContain('ElementSelector: #hero');
  });
});
