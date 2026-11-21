/** The gateway's model list. */

import { API_BASE_URL } from './shared/config.js';

export interface ChatModel {
  id: string;
  name?: string;
  description?: string;
  owned_by?: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
}

/**
 * List available models from Hanzo Cloud.
 * The /v1/models endpoint is public — token is optional but provides
 * user-specific model access when present.
 */
export async function listModels(token?: string): Promise<ChatModel[]> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}/v1/models`, { headers });

  if (!response.ok) {
    throw new Error(`Failed to list models: ${response.status}`);
  }

  const data = await response.json();
  return data.data || data.models || data || [];
}
