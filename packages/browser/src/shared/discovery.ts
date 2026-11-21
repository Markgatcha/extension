/**
 * OpenID discovery (HIP-1350, Sign-in and token verification). The login host is
 * `iamLoginUrl` (https://hanzo.ai); the issuer and the endpoints come only from
 * its `/.well-known/openid-configuration`, never from a constant, because the
 * issuer may change. The document is cached in extension storage for an hour.
 * When it cannot be read and the cache has expired there is no sign-in and no
 * refresh: the client fails closed rather than guess an endpoint.
 */

export const DISCOVERY_KEY = 'hanzo_oidc_discovery';
export const DISCOVERY_TTL_MS = 3_600_000;

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export class DiscoveryError extends Error {}

interface Store {
  get(keys: string[]): Promise<Record<string, any>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const REQUIRED = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const;

function https(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

function validate(doc: any): Discovery {
  for (const k of REQUIRED) if (!https(doc?.[k])) throw new DiscoveryError(`discovery: ${k} is missing or not https`);
  if (doc.userinfo_endpoint !== undefined && !https(doc.userinfo_endpoint)) throw new DiscoveryError('discovery: userinfo_endpoint is not https');
  return {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
    ...(doc.userinfo_endpoint ? { userinfo_endpoint: doc.userinfo_endpoint } : {}),
  };
}

/** The discovery document of `loginUrl`: from the cache while fresh, else fetched. */
export async function discover(storage: Store, loginUrl: string, now: number = Date.now()): Promise<Discovery> {
  const url = `${loginUrl}/.well-known/openid-configuration`;
  const cached = (await storage.get([DISCOVERY_KEY]))[DISCOVERY_KEY];
  if (cached && cached.url === url && now - cached.at < DISCOVERY_TTL_MS) return cached.doc as Discovery;
  let doc: Discovery;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new DiscoveryError(`discovery: ${res.status}`);
    doc = validate(await res.json());
  } catch (e) {
    throw e instanceof DiscoveryError ? e : new DiscoveryError('discovery: unreachable');
  }
  await storage.set({ [DISCOVERY_KEY]: { url, at: now, doc } });
  return doc;
}
