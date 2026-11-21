/**
 * Linked source (HIP-1350): this browser, registered with Hanzo as a source of
 * kind "browser". Sign-in is the extension's own IAM session (shared/auth.ts).
 * The device key is an Ed25519 WebCrypto pair whose private half is created
 * non-extractable and lives in IndexedDB, so no code path can read it out.
 *
 * What a heartbeat carries: the version, and which AI web products this browser
 * is signed in to (provider name and state only). The check is whether a
 * session cookie exists; its value is never read into any variable. A browser
 * source is not routable and never submits to or reads from a provider's page.
 */

import { API_BASE_URL } from './config.js';
import { readOutbox } from './source-usage.js';

export const LINK_KEY = 'hanzo_source_link';
export const BEAT_KEY = 'hanzo_source_beat';
export const MESSAGE_PREFIX = 'hanzo-source-heartbeat/1\n';
export const ALARM = 'hanzo-source-beat';
/** Alarms fire no more often than every 30 s in MV3 Chrome (120+); the cloud reads 90 s as online. */
export const ALARM_PERIOD_MINUTES = 0.5;
/** Cloud refuses beats closer than 10 s. */
const MIN_GAP_MS = 10_000;

export interface Storage {
  get(keys: string[]): Promise<Record<string, any>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface KeyStore {
  get(): Promise<CryptoKeyPair | undefined>;
  put(pair: CryptoKeyPair): Promise<void>;
}

export interface SourceProvider {
  provider: string;
  instance: string;
  kind: 'login';
  state: 'ready';
  plan?: string;
}

export interface Beat {
  at: string;
  version: string;
  zap: string;
  providers: SourceProvider[];
  busy: number;
}

// ── Providers ──────────────────────────────────────────────────────────

/** A signed-in marker: a session cookie that exists while the user is signed in. */
const PRODUCTS: { provider: string; url: string; names: string[] }[] = [
  { provider: 'chatgpt', url: 'https://chatgpt.com/', names: ['__Secure-next-auth.session-token', '__Secure-next-auth.session-token.0'] },
  { provider: 'claude', url: 'https://claude.ai/', names: ['sessionKey'] },
  { provider: 'gemini', url: 'https://gemini.google.com/', names: ['__Secure-1PSID'] },
  { provider: 'grok', url: 'https://grok.com/', names: ['sso'] },
  { provider: 'perplexity', url: 'https://www.perplexity.ai/', names: ['__Secure-next-auth.session-token', '__Secure-next-auth.session-token.0'] },
  { provider: 'copilot', url: 'https://github.com/', names: ['user_session'] },
  { provider: 'cursor', url: 'https://cursor.com/', names: ['WorkosCursorSessionToken'] },
];

/** Whether a cookie exists. Answers a boolean; the cookie itself never leaves the adapter. */
export type HasCookie = (url: string, name: string) => Promise<boolean>;

/** The products this browser is signed in to: state only, none when none. */
export async function detectProviders(has: HasCookie): Promise<SourceProvider[]> {
  const found = await Promise.all(
    PRODUCTS.map(async (p) => {
      for (const name of p.names) if (await has(p.url, name).catch(() => false)) return true;
      return false;
    }),
  );
  return PRODUCTS.filter((_, i) => found[i]).map((p) => ({
    provider: p.provider,
    instance: `${p.provider}-1`,
    kind: 'login' as const,
    state: 'ready' as const,
  }));
}

// ── The beat ───────────────────────────────────────────────────────────

/** The exact bytes the device key signs; cloud's beatMessage in apps/source/source.go. */
export function beatMessage(id: string, b: Beat): Uint8Array {
  let m = MESSAGE_PREFIX;
  for (const v of [id, b.at, b.version, b.zap, String(b.busy)]) m += `${v}\n`;
  for (const p of b.providers) m += `${[p.provider, p.instance, p.kind, p.state, p.plan ?? ''].join(',')}\n`;
  return new TextEncoder().encode(m);
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signBeat(priv: CryptoKey, id: string, b: Beat): Promise<string> {
  return b64url(await crypto.subtle.sign('Ed25519', priv, beatMessage(id, b) as BufferSource));
}

// ── Device key in IndexedDB ────────────────────────────────────────────

export function indexedDbKeyStore(): KeyStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('hanzo-source', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('keys');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = f(db.transaction('keys', mode).objectStore('keys'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: () => run('readonly', (s) => s.get('device')) as Promise<CryptoKeyPair | undefined>,
    put: async (pair) => void (await run('readwrite', (s) => s.put(pair, 'device'))),
  };
}

// ── Client ─────────────────────────────────────────────────────────────

export interface SourceDeps {
  storage: Storage;
  keys: KeyStore;
  token: () => Promise<string | null>;
  has: HasCookie;
  /** Browser name and version, e.g. "chrome 137", sent as `os`. */
  browser: string;
  arch: () => Promise<string>;
  version: string;
  fetch?: typeof fetch;
  now?: () => Date;
  base?: string;
}

export interface SourceStatus {
  linked: boolean;
  id?: string;
  interval?: number;
  level?: string;
  /** Last heartbeat body, verbatim as sent. */
  lastBeat?: string;
  lastAt?: string;
  error?: string;
}

const stamp = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');

export function createSource(deps: SourceDeps) {
  const f = deps.fetch ?? fetch.bind(globalThis);
  const now = deps.now ?? (() => new Date());
  const base = deps.base ?? API_BASE_URL;
  let flying = false;

  async function call(method: string, path: string, token: string, body?: string) {
    const res = await f(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body,
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* body is not JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  async function bearer(): Promise<string> {
    const t = await deps.token();
    if (!t) throw new Error('Sign in to Hanzo first.');
    return t;
  }

  async function keyPair(): Promise<CryptoKeyPair> {
    const have = await deps.keys.get();
    if (have) return have;
    let pair: CryptoKeyPair;
    try {
      pair = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
    } catch {
      throw new Error('This browser has no Ed25519 WebCrypto (Chrome 137+, Firefox 129+).');
    }
    await deps.keys.put(pair);
    return pair;
  }

  async function status(): Promise<SourceStatus> {
    const s = await deps.storage.get([LINK_KEY, BEAT_KEY]);
    const link = s[LINK_KEY];
    return {
      linked: !!link,
      id: link?.id,
      interval: link?.interval,
      level: link?.level,
      lastBeat: s[BEAT_KEY]?.body,
      lastAt: s[BEAT_KEY]?.at,
      error: s[BEAT_KEY]?.error,
    };
  }

  async function link(): Promise<SourceStatus> {
    const token = await bearer();
    const pair = await keyPair();
    const key = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
    const name = `${deps.browser.split(' ')[0]} (Hanzo extension)`;
    const r = await call('POST', '/v1/sources', token, JSON.stringify({
      kind: 'browser', name, os: deps.browser, arch: await deps.arch(), version: deps.version, key,
    }));
    if (!r.ok || !r.json?.id) throw new Error(r.json?.error?.message ?? r.json?.error ?? `Link failed (${r.status}).`);
    await deps.storage.set({ [LINK_KEY]: { id: r.json.id, interval: r.json.interval, level: r.json.level } });
    await tick(true);
    return status();
  }

  async function forget(): Promise<void> {
    await deps.storage.remove([LINK_KEY, BEAT_KEY]);
  }

  async function unlink(): Promise<SourceStatus> {
    const { [LINK_KEY]: l } = await deps.storage.get([LINK_KEY]);
    if (l) {
      const r = await call('DELETE', `/v1/sources/${encodeURIComponent(l.id)}`, await bearer());
      if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`Unlink failed (${r.status}).`);
    }
    await forget();
    return status();
  }

  async function list(): Promise<unknown[]> {
    const r = await call('GET', '/v1/sources', await bearer());
    if (!r.ok) throw new Error(`List failed (${r.status}).`);
    return r.json?.sources ?? [];
  }

  /** One heartbeat. `force` skips the 10 s gap; otherwise a call inside it is a no-op. */
  async function tick(force = false): Promise<void> {
    if (flying) return;
    const s = await deps.storage.get([LINK_KEY, BEAT_KEY]);
    const l = s[LINK_KEY];
    if (!l) return;
    if (!force && s[BEAT_KEY]?.at && now().getTime() - Date.parse(s[BEAT_KEY].at) < MIN_GAP_MS) return;
    flying = true;
    const at = stamp(now());
    try {
      const token = await deps.token();
      if (!token) throw new Error('Signed out of Hanzo.');
      const pair = await keyPair();
      const beat: Beat = { at, version: deps.version, zap: '', providers: await detectProviders(deps.has), busy: 0 };
      const body = JSON.stringify({ ...beat, sig: await signBeat(pair.privateKey, l.id, beat) });
      const r = await call('POST', `/v1/sources/${encodeURIComponent(l.id)}/heartbeat`, token, body);
      if (r.status === 410) return await forget();
      const prev = { body, at };
      if (!r.ok) {
        await deps.storage.set({ [BEAT_KEY]: { ...prev, error: r.json?.error?.message ?? r.json?.error ?? `Heartbeat refused (${r.status}).` } });
        return;
      }
      await deps.storage.set({
        [LINK_KEY]: { ...l, interval: r.json?.interval ?? l.interval, level: r.json?.level ?? l.level },
        [BEAT_KEY]: prev,
      });
    } catch (e: any) {
      await deps.storage.set({ [BEAT_KEY]: { ...(s[BEAT_KEY] ?? {}), error: e?.message ?? String(e) } });
    } finally {
      flying = false;
    }
  }

  const ops: Record<string, () => Promise<unknown>> = {
    'source.status': status,
    'source.link': link,
    'source.unlink': unlink,
    'source.list': async () => ({ sources: await list() }),
    'source.outbox': async () => ({ batches: await readOutbox(deps.storage) }),
  };

  return {
    status, link, unlink, list, tick,
    /** Answer a popup message; false when the action is not this module's. */
    handle(action: string, _request: unknown, respond: (r: any) => void): boolean {
      const op = ops[action];
      if (!op) return false;
      op().then(
        (r) => respond({ success: true, ...(r as object) }),
        (e) => respond({ success: false, error: e?.message ?? String(e) }),
      );
      return true;
    },
  };
}

/** A HasCookie over the extension cookies API: it reduces the cookie to whether it exists. */
export function cookieChecker(api: any): HasCookie {
  return async (url, name) => (await api.cookies.get({ url, name })) != null;
}

/** The browser's name and major version from its user agent, e.g. "chrome 137". */
export function browserLabel(ua: string): string {
  const m = /(Edg|Firefox|Chrome)\/(\d+)/.exec(ua);
  const name = m ? ({ Edg: 'edge', Firefox: 'firefox', Chrome: 'chrome' } as Record<string, string>)[m[1]] : 'browser';
  return m ? `${name} ${m[2]}` : name;
}

/** Wire the source to a browser's extension API (`chrome` or `browser`) and start its alarm. */
export function startSource(opts: { api: any; token: () => Promise<string | null> }) {
  const { api } = opts;
  const source = createSource({
    storage: api.storage.local,
    keys: indexedDbKeyStore(),
    token: opts.token,
    has: cookieChecker(api),
    browser: browserLabel(navigator.userAgent),
    arch: async () => {
      try {
        return (await (navigator as any).userAgentData?.getHighEntropyValues(['architecture']))?.architecture || 'unknown';
      } catch {
        return 'unknown';
      }
    },
    version: api.runtime.getManifest().version,
  });
  try {
    api.alarms.create(ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES });
    api.alarms.onAlarm.addListener((alarm: { name: string }) => {
      if (alarm.name === ALARM) void source.tick();
    });
  } catch (e) {
    console.warn('[Hanzo] source alarm unavailable:', e);
  }
  return source;
}
