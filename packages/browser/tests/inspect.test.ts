/**
 * shared/inspect.ts: the inspector's record. The fake API runs the serialized
 * `describe` against jsdom's document, the way executeScript runs it in a page.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApi(tab = { id: 3, url: 'http://localhost:5173/', title: 'App' }) {
  const store: Record<string, any> = {};
  return {
    scripting: { executeScript: vi.fn(async (o: any) => [{ result: o.func(...o.args) }]) },
    tabs: { get: vi.fn(async () => tab) },
    storage: { session: { get: async (k: string) => ({ [k]: store[k] }), set: async (v: any) => Object.assign(store, v) } },
  };
}

async function fresh() {
  vi.resetModules();
  return import('../src/shared/inspect.js');
}

function stamp(el: Element, token = 't1') {
  el.setAttribute('data-hanzo-picked', token);
  return token;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('inspector record', () => {
  it('says nothing is picked before a pick', async () => {
    const { inspected } = await fresh();
    await expect(inspected(fakeApi(), 3)).resolves.toMatchObject({ picked: false });
  });

  it("resolves a React 18 element to its JSX file:line and component chain from the page's fiber", async () => {
    const { recordPick, inspected } = await fresh();
    document.body.innerHTML = '<section><button class="cta border">Try Hanzo</button></section>';
    const btn = document.querySelector('button')!;
    function Hero() {}
    function Page() {}
    const page = { type: Page, return: null };
    const hero = { type: Hero, return: page, _debugSource: { fileName: '/repo/src/Hero.tsx', lineNumber: 42, columnNumber: 7 }, _debugOwner: { type: Hero } };
    (btn as any)['__reactFiber$abc'] = { type: 'button', return: hero };
    const api = fakeApi();
    const rec = await recordPick(api, 3, stamp(btn), { selector: 'button.cta' });
    expect(api.scripting.executeScript.mock.calls[0][0].world).toBe('MAIN');
    expect(rec).toMatchObject({
      picked: true, tabId: 3, url: 'http://localhost:5173/', selector: 'button.cta', tag: 'button',
      classes: ['cta', 'border'], text: 'Try Hanzo', components: ['Hero', 'Page'],
      source: { at: '/repo/src/Hero.tsx:42:7', file: '/repo/src/Hero.tsx', line: 42, component: 'Hero', via: 'react' },
    });
    expect(btn.hasAttribute('data-hanzo-picked')).toBe(false);
    await expect(inspected(api, 3)).resolves.toMatchObject({ source: { at: '/repo/src/Hero.tsx:42:7' } });
    // Another tab with no pick of its own answers with the latest, which names its tab.
    await expect(inspected(api, 99)).resolves.toMatchObject({ tabId: 3 });
  });

  it('reads a React 19 call site from _debugStack, skipping React frames', async () => {
    const { recordPick } = await fresh();
    document.body.innerHTML = '<p>hi</p>';
    const p = document.querySelector('p')!;
    function Card() {}
    const stack = [
      'Error: react-stack-top-frame',
      '    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:33)',
      '    at Card (http://localhost:5173/src/Card.tsx?t=171:12:5)',
    ].join('\n');
    (p as any)['__reactFiber$x'] = { type: 'p', _debugStack: { stack }, return: { type: Card, return: null } };
    const rec = await recordPick(fakeApi(), 3, stamp(p));
    expect(rec?.source).toMatchObject({ at: 'http://localhost:5173/src/Card.tsx:12:5', line: 12, column: 5, via: 'react' });
  });

  it('prefers compile-time annotations (gui data-at, Astro) over everything else', async () => {
    const { recordPick } = await fresh();
    document.body.innerHTML = '<div data-at="Nav.tsx:9" data-is="Nav" data-in="Layout.tsx:3"><a>Docs</a></div><span data-astro-source-file="/s/src/pages/index.astro" data-astro-source-loc="20:4">x</span>';
    const a = await recordPick(fakeApi(), 3, stamp(document.querySelector('a')!, 'a'));
    expect(a?.source).toEqual({ at: 'Nav.tsx:9', component: 'Nav', usedIn: 'Layout.tsx:3', via: 'gui' });
    const s = await recordPick(fakeApi(), 3, stamp(document.querySelector('span')!, 's'));
    expect(s?.source).toMatchObject({ at: '/s/src/pages/index.astro:20:4', line: 20, via: 'astro' });
  });

  it('resolves Vue and Svelte from the node, and keeps styles and grep hints for the rest', async () => {
    const { recordPick } = await fresh();
    document.body.innerHTML = '<i>v</i><b>s</b>';
    (document.querySelector('i') as any).__vueParentComponent = { type: { __file: '/r/src/Badge.vue', __name: 'Badge' } };
    (document.querySelector('b') as any).__svelte_meta = { loc: { file: 'src/Bold.svelte', line: 3, column: 1 } };
    const v = await recordPick(fakeApi(), 3, stamp(document.querySelector('i')!, 'v'));
    expect(v?.source).toMatchObject({ file: '/r/src/Badge.vue', component: 'Badge', via: 'vue' });
    const s = await recordPick(fakeApi(), 3, stamp(document.querySelector('b')!, 's'));
    expect(s?.source).toMatchObject({ at: 'src/Bold.svelte:3:1', via: 'svelte' });
    expect(s?.styles).toHaveProperty('border');
    expect(s?.grep[0]).toBe('s');
  });

  it('falls back to the isolated world when MAIN-world injection is refused', async () => {
    const { recordPick } = await fresh();
    document.body.innerHTML = '<h1 data-at="Title.tsx:1">Hi</h1>';
    const api = fakeApi();
    api.scripting.executeScript.mockImplementationOnce(async () => { throw new Error('world unsupported'); });
    const rec = await recordPick(api, 3, stamp(document.querySelector('h1')!));
    expect(rec?.source?.at).toBe('Title.tsx:1');
    expect(api.scripting.executeScript.mock.calls[1][0].world).toBeUndefined();
  });
});
