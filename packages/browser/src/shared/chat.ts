/** A surface's side of the background agent (shared/agent.ts): follow its thread, talk to it. */

import type { AgentState } from './agent.js';

const api = (): typeof chrome => (globalThis as any).browser ?? (globalThis as any).chrome;

/** The thread, on connect and after every change. A stopped worker closes the port, so connect again. Returns the close. */
export function follow(onState: (state: AgentState) => void): () => void {
  let port: chrome.runtime.Port;
  let closed = false;
  const connect = () => {
    port = api().runtime.connect({ name: 'agent' });
    port.onMessage.addListener((m: { action?: string; state?: AgentState }) => {
      if (m?.action === 'agent.update' && m.state) onState(m.state);
    });
    port.onDisconnect.addListener(() => {
      void api().runtime.lastError;
      if (!closed) setTimeout(connect, 500);
    });
  };
  connect();
  return () => {
    closed = true;
    port.disconnect();
  };
}

export interface Send {
  text: string;
  model: string;
  orgId?: string;
  tabId?: number;
  context?: string;
}

/** Start a turn. Rejects with why it could not start. */
export async function send(turn: Send): Promise<void> {
  const resp = await api().runtime.sendMessage({ action: 'agent.send', ...turn });
  if (!resp?.success) throw new Error(resp?.error || 'The agent is not running.');
}

export const stop = (): Promise<unknown> => api().runtime.sendMessage({ action: 'agent.stop' });
export const reset = (): Promise<unknown> => api().runtime.sendMessage({ action: 'agent.reset' });
