/**
 * Shared types for Chrome/Firefox/Safari background scripts.
 */

export interface ControlSession {
  active: boolean;
  tabId: number | null;
  task: string | null;
  startedAt: number | null;
}
