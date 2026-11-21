/**
 * The new tab's model picker: Auto, and the Zen chat models of catalog.hanzo.ai,
 * the public, tokenless list (api.hanzo.ai/v1/models answers 401 without a
 * token). Nothing is typed in by hand.
 */

import { can, fetchModelCatalog, type ModelCatalogEntry } from '@hanzo/ui/models';
import { CATALOG_BASE_URL } from '../shared/config.js';
import { zenModels } from '../runtime-guard.js';

/** No model is pinned: always valid, so the picker is never empty and a failed fetch leaves a live choice. */
export const AUTO = 'auto';

export const AUTO_MODEL: ModelCatalogEntry = {
  id: AUTO,
  name: 'Auto',
  owned_by: 'router',
  description: 'Routes to the best model',
};

/** Auto, and the Zen chat models of the public catalog. */
export async function fetchCatalog(): Promise<ModelCatalogEntry[]> {
  const served = await fetchModelCatalog(`${CATALOG_BASE_URL}/v1`);
  return [AUTO_MODEL, ...zenModels(served.filter((m) => can(m, 'chat')))];
}
