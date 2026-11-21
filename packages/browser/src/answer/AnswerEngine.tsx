import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, XStack, YStack } from '@hanzo/ui/primitives';
import { Composer, Message, Thread, type Command, type Mind } from '@hanzo/ui/chat';
import type { ModelCatalogEntry } from '@hanzo/ui/models';
import { Turns } from '../Chat.js';
import { fetchNews, type NewsItem } from './news.js';
import { AUTO, AUTO_MODEL, fetchCatalog } from './model-catalog.js';
import { capture, contributeTrainingSample } from '../shared/consent.js';
import { estimateMessageTokens, pickModelForTokenBudget } from '../runtime-guard.js';
import { follow, reset, send, stop } from '../shared/chat.js';
import type { AgentState } from '../shared/agent.js';
import { Rail, type RailUser } from './Rail.js';
import { Stories } from './Stories.js';
import { DEFAULT_PROVIDER_ID, fallbackUrl, loadProviderId } from './websearch.js';

/**
 * Hanzo Answer Engine, the new tab: the browser's search box over the one chat.
 * The thread, the model call and the tools (the web, the org's own knowledge,
 * pages, this tab) are the background agent's (shared/agent.ts), the same thread
 * the popup, the on-page panel and the sidebar draw. What is local is what is
 * true HERE: the rail, the stories, and a query typed signed out, which goes to
 * the configured search engine (the address bar must never dead-end).
 */

export interface AnswerEngineProps {
  /** Resolves the current IAM bearer, or null when signed out. */
  getToken: () => Promise<string | null>;
  /** Kicks off IAM sign-in (opens the OAuth tab). */
  signIn: () => void;
  /** Signs out of the current IAM session. */
  signOut?: () => void;
  /** Current signed-in user profile, or null when signed out. */
  user?: RailUser | null;
  /** Active organization id (X-Org-Id) when signed in. */
  orgId?: string | null;
  /** Whether the local ZAP router bridge is connected. */
  zapConnected?: boolean;
  /** Optional initial query (from the omnibox / address bar `?q=`). */
  initialQuery?: string;
}

export function AnswerEngine({ getToken, signIn, signOut, user, orgId, zapConnected, initialQuery }: AnswerEngineProps) {
  // Rail hidden by default: a single centered column, like hanzo.chat.
  const [collapsed, setCollapsed] = useState(true);
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<ModelCatalogEntry[]>([AUTO_MODEL]);
  const [catalog, setCatalog] = useState<'reading' | 'read' | string>('reading');
  const [model, setModel] = useState<string>(AUTO);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [thread, setThread] = useState<AgentState>({ turns: [], busy: false });
  const [providerId, setProviderId] = useState<string>(DEFAULT_PROVIDER_ID);

  useEffect(() => {
    fetchCatalog()
      .then((entries) => {
        setModels(entries);
        setCatalog('read');
      })
      .catch(() => setCatalog('The model list could not be read.'));
    fetchNews().then(setNews).catch(() => {});
    loadProviderId().then(setProviderId).catch(() => {});
    return follow(setThread);
  }, []);

  // A finished answer is a training sample only if the person opted in; the consent module gates the send.
  const contributed = useRef('');
  useEffect(() => {
    const last = thread.turns[thread.turns.length - 1];
    const asked = [...thread.turns].reverse().find((t) => t.role === 'user');
    if (thread.busy || last?.role !== 'assistant' || last.error || !asked || contributed.current === last.id) return;
    contributed.current = last.id;
    void capture('answer_shown', { model });
    void contributeTrainingSample({ query: asked.content, answer: last.content, model });
  }, [thread, model]);

  const run = useCallback(
    async (q: string) => {
      const question = q.trim();
      if (!question || thread.busy) return;
      // NO IDENTITY, NO DEAD END: this surface IS the browser's search box, so a
      // signed-out query goes from this browser straight to the engine the person
      // chose, with no token, no proxy and no telemetry.
      let identified = false;
      try {
        identified = Boolean(await getToken());
      } catch {
        identified = false;
      }
      if (!identified) {
        const url = fallbackUrl(providerId, question);
        if (url) {
          void capture('answer_search_fallback', { provider: providerId });
          window.location.assign(url);
          return;
        }
      }
      void capture('answer_search', { model });
      setQuery('');
      const resolved = pickModelForTokenBudget(model, models.map((m) => m.id), estimateMessageTokens([{ role: 'user', content: question }]));
      try {
        await send({ text: question, model: resolved, ...(orgId ? { orgId } : null) });
      } catch {
        // The agent says why in the thread, or it is not running and the thread stays as it was.
      }
    },
    [thread.busy, getToken, providerId, model, models, orgId],
  );

  // Fire the initial (address-bar) query once.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || !initialQuery) return;
    didInit.current = true;
    void run(initialQuery);
  }, [initialQuery, run]);

  const submit = useCallback(() => void run(query), [query, run]);
  const newThread = useCallback(() => {
    void reset();
    setQuery('');
  }, []);

  // The model answering. Nothing here is plan-gated: the gateway refuses what the account may not send.
  const mind = useMemo<Mind>(
    () => ({
      model,
      models,
      loading: catalog === 'reading',
      error: catalog === 'reading' || catalog === 'read' ? null : catalog,
      note: '',
      free: false,
      pick: setModel,
    }),
    [model, models, catalog],
  );

  const commands = useMemo<Command[]>(
    () => [
      { id: 'new-thread', label: 'New thread', keys: '⌘⇧O', run: newThread },
      { id: 'toggle-rail', label: collapsed ? 'Expand sidebar' : 'Collapse sidebar', run: () => setCollapsed((v) => !v) },
    ],
    [newThread, collapsed],
  );

  const composer = (
    <Composer value={query} onChange={setQuery} onSend={submit} onStop={() => void stop()} busy={thread.busy} mind={mind} commands={commands} column />
  );

  const last = thread.turns[thread.turns.length - 1];
  const expired = last?.error && /sign in/i.test(last.error);

  return (
    <div className={'ae-root' + (collapsed ? ' collapsed' : '')}>
      <Rail collapsed={collapsed} toggle={() => setCollapsed((v) => !v)} newThread={newThread} signIn={signIn} signOut={signOut} user={user} />

      <main className="ae-main">
        <header className="ae-header">
          <div className="ae-header-left">
            <span className={'ae-zap-dot' + (zapConnected ? ' connected' : '')} title={zapConnected ? 'ZAP connected' : 'ZAP disconnected'} />
          </div>
          <div className="ae-header-right">
            <button
              type="button"
              className="ae-org-pill"
              onClick={user ? (signOut ?? signIn) : signIn}
              title={user ? `hanzo.id · ${orgId || 'default'}` : 'Sign in with hanzo.id'}
            >
              {user ? (orgId ? `hanzo.id · ${orgId}` : 'hanzo.id') : 'hanzo.id'}
            </button>
            <button type="button" className="ae-header-btn" onClick={newThread} title="New thread" aria-label="New thread">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M8 3v10M3 8h10" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>
        {thread.turns.length === 0 ? (
          <YStack flex={1} justify="center" gap="$6" py="$6">
            {composer}
            <Stories items={news} />
          </YStack>
        ) : (
          <>
            <Thread>
              <Turns turns={thread.turns} busy={thread.busy} />
              {expired ? (
                <XStack gap="$3" items="center">
                  <Button onPress={signIn}>Sign in</Button>
                </XStack>
              ) : null}
            </Thread>
            <YStack width="100%" pb="$4">
              {composer}
            </YStack>
          </>
        )}
      </main>
    </div>
  );
}
