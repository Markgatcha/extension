/**
 * The inspector's record: what the person last picked on a page, and where in
 * SOURCE it came from, so an agent asked to "change what I clicked" can open
 * the file and edit it instead of asking which element was meant.
 *
 * The content script's picker stamps the element with `data-hanzo-picked` and
 * reports it; `recordPick` then describes it from the page's MAIN world. Only
 * there are a framework's own properties visible — React's fiber, Vue's
 * component, Svelte's meta are JS expandos on the DOM node, and an isolated
 * world (the content script's) sees the node without them. The record is kept
 * per tab and served by `hanzo.inspected` (browser action `inspected`).
 *
 * Shared by background.ts (`chrome`) and background-firefox.ts (`browser`).
 */

export interface Source {
  /** `file:line[:column]`, the one string an editor or `rg` opens. */
  at: string;
  file?: string;
  line?: number;
  column?: number;
  /** The component that rendered the element, and the one that used it. */
  component?: string;
  usedIn?: string;
  /** gui | react | vue | svelte | astro | attribute | dom */
  via: string;
}

export interface Picked {
  picked: true;
  tabId: number;
  url: string;
  title: string;
  time: number;
  selector: string;
  path: string;
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  href: string | null;
  src: string | null;
  rect: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
  html: string;
  /** Where it lives in source; absent on a production bundle with no dev metadata. */
  source?: Source;
  /** Rendering components, innermost first. */
  components: string[];
  /** Strings to search the repo for when `source` is absent. */
  grep: string[];
}

const KEY = 'hanzo.inspected';
const byTab = new Map<number, Picked>();
let latest: Picked | null = null;

/**
 * Runs in the page (MAIN world, or isolated as a fallback). Self-contained:
 * scripting.executeScript serializes the function, so it may not close over
 * anything in this module.
 */
function describe(token: string) {
  const find = (root: Document | ShadowRoot): Element | null => {
    const hit = root.querySelector(`[data-hanzo-picked="${token}"]`);
    if (hit) return hit;
    for (const host of Array.from(root.querySelectorAll('*'))) {
      if (host.shadowRoot) {
        const inner = find(host.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  };
  const el = find(document) as HTMLElement | null;
  if (!el) return null;
  el.removeAttribute('data-hanzo-picked');

  const base = (f: string) => String(f).split('?')[0];
  const at = (file: string, line?: number, col?: number) =>
    `${base(file)}${line ? `:${line}` : ''}${line && col ? `:${col}` : ''}`;
  const nameOf = (t: any): string =>
    typeof t === 'function' ? t.displayName || t.name || ''
      : t && typeof t === 'object' ? t.displayName || t.render?.displayName || t.render?.name || t.type?.name || ''
        : '';

  // React fiber, by its per-render key.
  const fiberOf = (node: any) => {
    for (const k of Object.keys(node)) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return node[k];
    }
    return null;
  };

  // React 19 dropped _debugSource; a fiber carries the Error from its JSX call
  // instead. Its first frame outside React is the call site, with the module's
  // served URL — a real path under Vite, a chunk under webpack.
  const fromStack = (stack: unknown): { file: string; line: number; column: number } | null => {
    const text = typeof stack === 'string' ? stack : (stack as any)?.stack;
    if (typeof text !== 'string') return null;
    for (const raw of text.split('\n')) {
      const m = raw.match(/\(?((?:https?|file|webpack[^:]*):\/\/[^\s)]+?):(\d+):(\d+)\)?\s*$/);
      if (!m) continue;
      if (/react-dom|react-server|react\.development|jsx-dev-runtime|jsx-runtime|node_modules|scheduler/.test(m[1])) continue;
      return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
    }
    return null;
  };

  const components: string[] = [];
  let source: any;

  // 1. Compile-time annotations: the most trustworthy, written by the build
  //    from the AST. @hanzo/gui writes data-at/data-is/data-in; Astro dev,
  //    react-dev-inspector, and the common data-source/data-loc plugins too.
  for (let n: Element | null = el; n && !source; n = n.parentElement) {
    const a = (k: string) => n!.getAttribute(k);
    if (a('data-at')) {
      source = { at: a('data-at'), component: a('data-is') || undefined, usedIn: a('data-in') || undefined, via: 'gui' };
    } else if (a('data-astro-source-file')) {
      const [line, column] = (a('data-astro-source-loc') || '').split(':').map(Number);
      source = { at: at(a('data-astro-source-file')!, line, column), file: a('data-astro-source-file'), line, column, via: 'astro' };
    } else if (a('data-inspector-relative-path')) {
      const line = Number(a('data-inspector-line')) || undefined;
      const column = Number(a('data-inspector-column')) || undefined;
      const file = a('data-inspector-relative-path')!;
      source = { at: at(file, line, column), file, line, column, via: 'attribute' };
    } else {
      const loc = a('data-source') || a('data-loc') || a('data-source-loc') || a('data-component-source');
      const m = loc?.match(/^(.+?):(\d+)(?::(\d+))?$/);
      if (m) source = { at: loc, file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined, via: 'attribute' };
    }
  }

  // 2. React: the nearest fiber with a source, and the component chain.
  let fiber: any = null;
  for (let n: Element | null = el; n && !fiber; n = n.parentElement) fiber = fiberOf(n);
  for (let f = fiber, hops = 0; f && hops < 200; f = f.return, hops++) {
    const name = nameOf(f.type);
    if (name && components.length < 8 && !components.includes(name)) components.push(name);
    if (source) continue;
    const ds = f._debugSource;
    if (ds?.fileName) {
      source = { at: at(ds.fileName, ds.lineNumber, ds.columnNumber), file: ds.fileName, line: ds.lineNumber, column: ds.columnNumber, component: nameOf(f._debugOwner?.type) || name || undefined, via: 'react' };
      continue;
    }
    const st = fromStack(f._debugStack);
    if (st) source = { at: at(st.file, st.line, st.column), ...st, component: nameOf(f._debugOwner?.type) || name || undefined, via: 'react' };
  }

  // 3. Svelte and Vue keep it on the node.
  for (let n: any = el; n && !source; n = n.parentElement) {
    const loc = n.__svelte_meta?.loc;
    if (loc?.file) source = { at: at(loc.file, loc.line, loc.column), file: loc.file, line: loc.line, column: loc.column, via: 'svelte' };
    const inst = n.__vueParentComponent || n.__vue__;
    const file = inst?.type?.__file || inst?.$options?.__file;
    if (!source && file) source = { at: file, file, component: inst?.type?.name || inst?.type?.__name || inst?.$options?.name || undefined, via: 'vue' };
  }

  // 4. A page with no build step IS its own source: the URL and the selector.
  if (!source && !document.querySelector('script[src*="/_next/"], script[src*="/assets/index-"], script[type="module"][src]')) {
    source = { at: location.pathname, file: location.href, via: 'dom' };
  }

  const cs = getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const k of ['display', 'position', 'color', 'backgroundColor', 'border', 'borderColor', 'borderRadius', 'outline', 'boxShadow', 'fontFamily', 'fontSize', 'fontWeight', 'padding', 'margin', 'opacity']) {
    styles[k] = (cs as any)[k];
  }
  const rect = el.getBoundingClientRect();
  const html = el.outerHTML.length > 2000 ? el.outerHTML.slice(0, 2000) + '…' : el.outerHTML;
  const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
  const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  const grep = [text.slice(0, 60), el.id && `id="${el.id}"`, classes.slice(0, 4).join(' ')].filter(Boolean) as string[];
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes,
    text: text.slice(0, 200),
    href: (el as HTMLAnchorElement).href || null,
    src: (el as HTMLImageElement).src || null,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    styles,
    html,
    source,
    components,
    grep,
  };
}

async function inPage(api: any, tabId: number, token: string) {
  try {
    const [res] = await api.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: describe, args: [token] });
    if (res?.result) return res.result;
  } catch { /* a browser without MAIN-world injection: describe it from the isolated world */ }
  const [res] = await api.scripting.executeScript({ target: { tabId }, func: describe, args: [token] });
  return res?.result ?? null;
}

/** Describe the stamped element and keep it as this tab's pick. */
export async function recordPick(
  api: any,
  tabId: number,
  token: string,
  base: { selector?: string; path?: string } = {},
): Promise<Picked | null> {
  const found = await inPage(api, tabId, token);
  if (!found) return null;
  const tab = await api.tabs.get(tabId).catch(() => null);
  const record: Picked = {
    picked: true,
    tabId,
    url: tab?.url || '',
    title: tab?.title || '',
    time: Date.now(),
    selector: base.selector || '',
    path: base.path || '',
    ...found,
  };
  byTab.set(tabId, record);
  latest = record;
  try {
    await api.storage.session.set({ [KEY]: { latest: record, byTab: Object.fromEntries(byTab) } });
  } catch { /* no storage.session: the in-memory copy serves until the worker sleeps */ }
  return record;
}

/** This tab's pick, else the most recent anywhere (its tabId says which). */
export async function inspected(api: any, tabId?: number): Promise<Picked | { picked: false; hint: string }> {
  if (!latest) {
    try {
      const saved = (await api.storage.session.get(KEY))?.[KEY];
      if (saved) {
        latest = saved.latest;
        for (const [k, v] of Object.entries(saved.byTab || {})) byTab.set(Number(k), v as Picked);
      }
    } catch { /* nothing saved */ }
  }
  const hit = (tabId !== undefined && byTab.get(tabId)) || latest;
  return hit ?? { picked: false, hint: 'Nothing picked yet: click Inspect in the Hanzo extension (or use the inspect shortcut) and click an element.' };
}
