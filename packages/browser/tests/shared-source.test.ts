import { describe, it, expect } from 'vitest';
import {
  LINK_KEY,
  beatMessage,
  cookieChecker,
  createSource,
  detectProviders,
  signBeat,
  b64url,
  type KeyStore,
  type Storage,
} from '../src/shared/source.js';
import { OUTBOX_MAX, queueBatch, readOutbox, usageRecord, type UsageRecord } from '../src/shared/source-usage.js';

const ID = 'src_0123456789abcdef0123456789abcdef';

function memory(): Storage {
  const m: Record<string, any> = {};
  return {
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in m).map((k) => [k, m[k]])),
    set: async (items) => void Object.assign(m, items),
    remove: async (keys) => void keys.forEach((k) => delete m[k]),
  };
}

function memoryKeys(): KeyStore {
  let pair: CryptoKeyPair | undefined;
  return { get: async () => pair, put: async (p) => void (pair = p) };
}

const dec = (u: Uint8Array) => new TextDecoder().decode(u);

describe('heartbeat signing bytes', () => {
  it('matches the hand-written message for a fixed beat', () => {
    const bytes = beatMessage(ID, {
      at: '2026-11-20T10:00:00Z',
      version: '1.9.75',
      zap: '',
      busy: 0,
      providers: [
        { provider: 'claude', instance: 'claude-1', kind: 'login', state: 'ready', plan: 'max' },
        { provider: 'chatgpt', instance: 'chatgpt-1', kind: 'login', state: 'ready' },
      ],
    });
    expect(dec(bytes)).toBe(
      'hanzo-source-heartbeat/1\n' +
        'src_0123456789abcdef0123456789abcdef\n' +
        '2026-11-20T10:00:00Z\n' +
        '1.9.75\n' +
        '\n' +
        '0\n' +
        'claude,claude-1,login,ready,max\n' +
        'chatgpt,chatgpt-1,login,ready,\n',
    );
  });

  it('with no providers ends after busy', () => {
    const bytes = beatMessage(ID, { at: 'A', version: 'V', zap: 'https://z', busy: 2, providers: [] });
    expect(dec(bytes)).toBe(`hanzo-source-heartbeat/1\n${ID}\nA\nV\nhttps://z\n2\n`);
  });

  it('is signed by the device key and verifies under its public half', async () => {
    const pair = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
    const beat = { at: '2026-11-20T10:00:00Z', version: '1.9.75', zap: '', busy: 0, providers: [] };
    const sig = await signBeat(pair.privateKey, ID, beat);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const raw = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/') + '=='), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify('Ed25519', pair.publicKey, raw, beatMessage(ID, beat) as BufferSource)).toBe(true);
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();
  });
});

describe('provider detection', () => {
  it('returns state only, for products with a marker', async () => {
    const present = new Set(['https://claude.ai/|sessionKey', 'https://github.com/|user_session']);
    const found = await detectProviders(async (url, name) => present.has(`${url}|${name}`));
    expect(found).toEqual([
      { provider: 'claude', instance: 'claude-1', kind: 'login', state: 'ready' },
      { provider: 'copilot', instance: 'copilot-1', kind: 'login', state: 'ready' },
    ]);
    for (const p of found) expect(Object.keys(p).sort()).toEqual(['instance', 'kind', 'provider', 'state']);
  });

  it('is empty when nothing is signed in', async () => {
    expect(await detectProviders(async () => false)).toEqual([]);
  });

  it('never lets a cookie value out of the checker', async () => {
    const has = cookieChecker({ cookies: { get: async () => ({ name: 'sessionKey', value: 'SECRET-VALUE' }) } });
    expect(await has('https://claude.ai/', 'sessionKey')).toBe(true);
    const none = cookieChecker({ cookies: { get: async () => null } });
    expect(await none('https://claude.ai/', 'sessionKey')).toBe(false);
  });
});

function rig(reply: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  let clock = Date.parse('2026-11-20T10:00:00Z');
  const storage = memory();
  const source = createSource({
    storage,
    keys: memoryKeys(),
    token: async () => 'iam-access-token',
    has: async (_u, name) => name === 'sessionKey',
    browser: 'chrome 137',
    arch: async () => 'arm',
    version: '1.9.75',
    base: 'https://api.test',
    now: () => new Date(clock),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = reply(url, init);
      return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
    }) as typeof fetch,
  });
  return { source, storage, calls, advance: (ms: number) => void (clock += ms) };
}

const linkReply = (url: string, init: RequestInit) =>
  url.endsWith('/v1/sources') && init.method === 'POST'
    ? { status: 201, body: { id: ID, interval: 30, level: 'metadata' } }
    : { status: 200, body: { interval: 30, level: 'metadata', revoked: false } };

describe('link and heartbeat', () => {
  it('registers with kind browser, the public key, and no secret', async () => {
    const { source, calls } = rig(linkReply);
    const st = await source.link();
    expect(st.linked).toBe(true);
    expect(st.id).toBe(ID);
    const reg = JSON.parse(calls[0].init.body as string);
    expect(Object.keys(reg).sort()).toEqual(['arch', 'key', 'kind', 'name', 'os', 'version']);
    expect(reg.kind).toBe('browser');
    expect(reg.os).toBe('chrome 137');
    expect(reg.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer iam-access-token');
  });

  it('heartbeat body is the beat and its signature, nothing else', async () => {
    const { source, calls } = rig(linkReply);
    await source.link();
    const hb = calls[1];
    expect(hb.url).toBe(`https://api.test/v1/sources/${ID}/heartbeat`);
    const body = JSON.parse(hb.init.body as string);
    expect(Object.keys(body).sort()).toEqual(['at', 'busy', 'providers', 'sig', 'version', 'zap']);
    expect(body.providers).toEqual([{ provider: 'claude', instance: 'claude-1', kind: 'login', state: 'ready' }]);
    expect(hb.init.body as string).not.toMatch(/iam-access-token|cookie|token|email|password/i);
    expect((await source.status()).lastBeat).toBe(hb.init.body);
  });

  it('sends an empty provider list when none is signed in', async () => {
    const { source, calls } = rig(linkReply);
    const s2 = createSource({
      storage: memory(), keys: memoryKeys(), token: async () => 't', has: async () => false, browser: 'chrome 137',
      arch: async () => 'arm', version: '1', base: 'https://api.test',
      fetch: (async (u: string, i: RequestInit) => { calls.push({ url: u, init: i }); const r = linkReply(u, i); return new Response(JSON.stringify(r.body), { status: r.status }); }) as typeof fetch,
    });
    await s2.link();
    expect(JSON.parse(calls.at(-1)!.init.body as string).providers).toEqual([]);
    expect(source).toBeDefined();
  });

  it('a 410 forgets the link', async () => {
    let revoked = false;
    const { source, storage, advance } = rig((u, i) => (revoked && u.endsWith('/heartbeat') ? { status: 410, body: { error: 'source revoked' } } : linkReply(u, i)));
    await source.link();
    expect((await storage.get([LINK_KEY]))[LINK_KEY].id).toBe(ID);
    revoked = true;
    advance(30_000);
    await source.tick();
    expect((await source.status()).linked).toBe(false);
    expect(await storage.get([LINK_KEY])).toEqual({});
  });

  it('keeps the link when a heartbeat is refused for another reason', async () => {
    let refuse = false;
    const { source, advance } = rig((u, i) => (refuse && u.endsWith('/heartbeat') ? { status: 429, body: { error: 'heartbeat too soon' } } : linkReply(u, i)));
    await source.link();
    refuse = true;
    advance(30_000);
    await source.tick();
    const st = await source.status();
    expect(st.linked).toBe(true);
    expect(st.error).toBe('heartbeat too soon');
  });

  it('does not beat twice inside the 10 s gap', async () => {
    const { source, calls, advance } = rig(linkReply);
    await source.link();
    const n = calls.length;
    advance(5_000);
    await source.tick();
    expect(calls.length).toBe(n);
    advance(30_000);
    await source.tick();
    expect(calls.length).toBe(n + 1);
  });

  it('unlink revokes at cloud and forgets', async () => {
    const { source, calls } = rig((u, i) => (i.method === 'DELETE' ? { status: 200, body: { id: ID, revoked: true } } : linkReply(u, i)));
    await source.link();
    await source.unlink();
    expect(calls.at(-1)!.init.method).toBe('DELETE');
    expect((await source.status()).linked).toBe(false);
  });
});

describe('usage record and outbox', () => {
  const rec: UsageRecord = { desktop: ID, provider: 'claude', instance: 'claude-1', window: 'run', used: 1, unit: 'requests', started_at: '2026-11-20T10:00:00Z', outcome: 'ok' };

  it('keeps only the HIP fields', () => {
    const dirty = { ...rec, prompt: 'hello', url: 'https://claude.ai/chat/1' } as unknown as UsageRecord;
    expect(usageRecord(dirty)).toEqual(rec);
  });

  it('queues pending batches and keeps the last 100', async () => {
    const storage = memory();
    for (let i = 0; i < OUTBOX_MAX + 5; i++) await queueBatch(storage, [{ ...rec, used: i }], new Date(2026, 10, 20, 10, 0, i));
    const out = await readOutbox(storage);
    expect(out).toHaveLength(OUTBOX_MAX);
    expect(out[0].records[0].used).toBe(5);
    expect(out.every((b) => b.state === 'pending')).toBe(true);
  });
});

describe('encoding', () => {
  it('base64url is unpadded', () => {
    expect(b64url(new Uint8Array([251, 255]))).toBe('-_8');
  });
});
