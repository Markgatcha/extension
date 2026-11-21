/**
 * Usage for a linked browser source (HIP-1350, Usage). The record is the HIP's
 * UsageRecord, field for field; `desktop` carries the source id. A record goes
 * to a local outbox the popup shows verbatim. Nothing sends it: cloud has no
 * usage op yet (slice 3).
 */

import type { Storage } from './source.js';

export interface UsageRecord {
  desktop: string;
  provider: string;
  instance: string;
  window: 'session' | 'weekly' | 'monthly' | 'run';
  used: number;
  limit?: number;
  unit: 'tokens' | 'requests' | 'credits' | 'usd';
  resets_at?: string;
  credits?: { remaining: number; unit: string };
  cost?: { amount: number; currency: string };
  model?: string;
  tokens?: { input: number; output: number; cached: number; reasoning: number };
  started_at: string;
  duration_ms?: number;
  outcome?: 'ok' | 'error' | 'cancelled';
  /** Salted hash of the thread id. */
  run?: string;
}

export const OUTBOX_KEY = 'hanzo_source_outbox';
export const OUTBOX_MAX = 100;

const FIELDS: (keyof UsageRecord)[] = [
  'desktop', 'provider', 'instance', 'window', 'used', 'limit', 'unit', 'resets_at', 'credits',
  'cost', 'model', 'tokens', 'started_at', 'duration_ms', 'outcome', 'run',
];

/** The record with only the HIP's fields: anything else is dropped, never sent on. */
export function usageRecord(r: UsageRecord): UsageRecord {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (r[k] !== undefined) out[k] = r[k];
  return out as unknown as UsageRecord;
}

export interface OutboxBatch {
  at: string;
  state: 'pending' | 'sent';
  records: UsageRecord[];
}

export async function readOutbox(storage: Storage): Promise<OutboxBatch[]> {
  return (await storage.get([OUTBOX_KEY]))[OUTBOX_KEY] ?? [];
}

/** Write a batch to the outbox, newest last, keeping the last 100. */
export async function queueBatch(storage: Storage, records: UsageRecord[], at: Date = new Date()): Promise<void> {
  const next = [...(await readOutbox(storage)), { at: at.toISOString(), state: 'pending' as const, records: records.map(usageRecord) }];
  await storage.set({ [OUTBOX_KEY]: next.slice(-OUTBOX_MAX) });
}
