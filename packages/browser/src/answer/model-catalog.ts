/**
 * Hanzo model catalog for the answer-engine model picker. Reads the REAL
 * catalog and keeps what can chat — never a hardcoded or fabricated list.
 * Switching the picker actually changes the `model` passed to the @hanzo/ai
 * search primitive.
 *
 * It reads catalog.hanzo.ai, not the API base. This is the PUBLIC catalog: a
 * read-only, edge-cached, tokenless list, and catalog.hanzo.ai is the host that
 * serves it. api.hanzo.ai/v1/models is the authenticated OpenAI-compatible model
 * list and answers 401 without a token — it only looked public here because the
 * ingress used to hand that path to the catalog worker, which is exactly the
 * two-implementations-of-one-address defect that carve was deleted for
 * (hanzoai/universe fd18448).
 *
 * The catalog answers the gateway's own rows (`family`, `owned_by`, `class`,
 * `outputs`), so `@hanzo/ui/models` reads it: `fetchModelCatalog` with the
 * catalog's base, `can(m, 'chat')` for what a question can go to. The picker
 * is the composer's own (`ModelPicker`, as its `mind`) and groups them the way
 * every Hanzo surface does — Enso, Zen, Kai, Zoo, then each maker.
 */

import { can, fetchModelCatalog, type ModelCatalogEntry } from '@hanzo/ui/models';
import { CATALOG_BASE_URL } from '../shared/config.js';
import { isLegacyModel } from '../runtime-guard.js';

/** The "let the router pick" option: no model is pinned and the cloud chooses.
 *  Always valid, so it is the seed and the fallback when the fetch is slow or
 *  fails — a dead selection is never shown. */
export const AUTO = 'auto';

/** The picker groups a model with no Hanzo family by who serves it (`owned_by`),
 *  so these rows keep the sections they had: Router, Connected Accounts, Local
 *  Compute. */
const AUTO_MODEL: ModelCatalogEntry = {
  id: AUTO,
  name: 'Auto',
  owned_by: 'router',
  description: 'Routes to the best model',
};

const CONNECTED_MODELS: ModelCatalogEntry[] = [
  {
    id: 'chatgpt-web',
    name: 'ChatGPT Web (Plus)',
    owned_by: 'connected-accounts',
    description: 'Uses active ChatGPT Plus session (temporary chats)',
  },
  {
    id: 'claude-web',
    name: 'Claude Web',
    owned_by: 'connected-accounts',
    description: 'Uses active Claude session',
  },
  {
    id: 'hanzo-spark',
    name: 'Hanzo Spark (GB10 CUDA)',
    owned_by: 'local-compute',
    description: 'Spark GB10 node (10.0.0.19:1235)',
  },
  {
    id: 'hanzo-evo',
    name: 'Hanzo Evo (Strix Halo ROCm)',
    owned_by: 'local-compute',
    description: 'Evo Strix Halo node (10.0.0.21:1234)',
  },
  {
    id: 'hanzo-desktop',
    name: 'Hanzo Desktop',
    owned_by: 'local-compute',
    description: 'Local Hanzo Desktop (:11435)',
  },
  {
    id: 'webgpu',
    name: 'WebGPU AI (Local)',
    owned_by: 'local-compute',
    description: 'Runs on-device in browser GPU',
  },
];

const CORE_MODELS: ModelCatalogEntry[] = [
  { id: 'enso', name: 'Enso', family: 'enso', owned_by: 'hanzo', class: 'ours', description: 'Autonomous router & planner' },
  { id: 'zen6', name: 'Zen 6', family: 'zen', owned_by: 'zenlm', class: 'ours', description: 'Flagship reasoning & coding' },
  { id: 'zen6-flash', name: 'Zen 6 Flash', family: 'zen', owned_by: 'zenlm', class: 'ours', description: 'Ultra-fast responses' },
  { id: 'zen6-coder', name: 'Zen 6 Coder', family: 'zen', owned_by: 'zenlm', class: 'ours', description: 'Agentic coding & systems' },
  { id: 'zen6-max', name: 'Zen 6 Max', family: 'zen', owned_by: 'zenlm', class: 'ours', description: 'Deep multi-step reasoning' },
  { id: 'zen-vl', name: 'Zen VL', family: 'zen', owned_by: 'zenlm', class: 'ours', description: 'Multimodal vision & page context' },
  { id: 'kai', name: 'Kai', family: 'kai', owned_by: 'hanzo', class: 'ours', description: 'Fast decision & tool model' },
];

export async function fetchCatalog(): Promise<ModelCatalogEntry[]> {
  try {
    const served = await fetchModelCatalog(`${CATALOG_BASE_URL}/v1`);
    const chatServed = served.filter((m) => can(m, 'chat') && !isLegacyModel(m.id));
    if (chatServed.length > 0) {
      return [AUTO_MODEL, ...chatServed, ...CONNECTED_MODELS];
    }
  } catch {
    // Fall back to canonical Enso / Zen 6 models when offline
  }
  return [AUTO_MODEL, ...CORE_MODELS, ...CONNECTED_MODELS];
}
