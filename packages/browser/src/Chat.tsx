import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, SizableText, YStack } from '@hanzo/ui/primitives';
import {
  Composer,
  Failure,
  Message,
  Thread,
  type Carried,
  type Chip,
  type Command,
  type Mind,
  type PlusProps,
} from '@hanzo/ui/chat';
import type { ModelCatalogEntry } from '@hanzo/ui/models';
import { Prose } from './shared/Prose.js';

/**
 * The sidebar's chat surface — `@hanzo/ui/chat`, the same shell the new-tab
 * answer engine and every other Hanzo surface draw with.
 *
 * The sidebar is the narrow client: ~360px, an MV3 extension page, and a
 * transport that is the service worker rather than a fetch loop. None of that
 * reaches the presentation. Every turn, the model and the busy flag arrive as
 * props and every action leaves as a callback, so `sidebar.ts` keeps the whole
 * wire — token brokering, retrieval, budgets, dedupe, the stream — and this
 * file keeps none of it.
 *
 * The draft is the one thing held here, as `@hanzo/ui/chat`'s own `Chat` holds
 * it. A half-typed question belongs to this screen and nothing outside it
 * reads it, so it stays in this component, and `onSend` gets its trimmed text.
 * The Composer is controlled and must be handed a value on every render.
 *
 * Width is the one thing the shell is asked to bend on. `Thread` caps prose at a
 * reading measure and centres it, which in a ~360px column would inset the text
 * from both edges, so it is told to fill — and its gutters come from the wrapper
 * here, because the shell drops its own padding along with the cap.
 *
 * The composer draws the sidebar's choices in the quiet line under its frame,
 * as it does on the new tab: retrieval and the open tab as chips at its start,
 * the model as the word at its end.
 */

export interface Turn {
  /** Minted by `sidebar.ts` where the turn is made. The thread keys rows on it. */
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** The turn failed. Rendered as the shell's Failure, with a retry. */
  error?: string;
}

export interface PageAttachment {
  title: string;
  url: string;
}

export interface ChatProps {
  turns: Turn[];
  /** Send the draft's trimmed text. The composer is already empty. */
  onSend: (text: string) => void;
  onStop: () => void;
  /** Run the last question again. */
  onRetry: () => void;
  busy: boolean;
  models: ModelCatalogEntry[];
  model: string;
  onModel: (id: string) => void;
  /** Whether retrieval runs before the turn, and whether it sees the open tab. */
  rag: boolean;
  onRag: (on: boolean) => void;
  tab: boolean;
  onTab: (on: boolean) => void;
  /** What retrieval last did. Shown at the end of the composer's row, before send. */
  status: string;
  signedIn: boolean;
  onSignIn: () => void;
  onSignUp: () => void;
  /** Optional attached active-page context shown as a removable chip inside `+`. */
  pageContext?: PageAttachment | null;
  pageAttached?: boolean;
  onAttachPage?: () => void;
  onDetachPage?: () => void;
  onNewThread?: () => void;
  onOpenTab?: (tab: 'chat' | 'tools' | 'settings') => void;
}

type SpeechRecognitionCtor = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function Chat(props: ChatProps) {
  const { turns, busy, signedIn } = props;
  const [draft, setDraft] = useState('');
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<InstanceType<SpeechRecognitionCtor> | null>(null);
  const speechSupported = useMemo(() => Boolean(getSpeechRecognition()), []);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {}
    };
  }, []);

  const toggleVoice = () => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    if (listening) {
      try {
        recognitionRef.current?.stop();
      } catch {}
      setListening(false);
      return;
    }
    try {
      const rec = new Ctor();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = navigator.language || 'en-US';
      rec.onresult = (ev: any) => {
        const transcript = Array.from(ev?.results ?? [])
          .map((r: any) => r?.[0]?.transcript ?? '')
          .join(' ')
          .trim();
        if (transcript) {
          setDraft((prev) => (prev.trim() ? `${prev.trimEnd()} ${transcript}` : transcript));
        }
      };
      rec.onerror = () => setListening(false);
      rec.onend = () => setListening(false);
      recognitionRef.current = rec;
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  };

  // The Composer calls this only with something to send and no turn in flight.
  const send = () => {
    setDraft('');
    props.onSend(draft.trim());
  };

  // The catalog is the sidebar's to read; the picker only shows it. Nothing
  // here is plan-gated: the gateway refuses what the account may not send.
  const mind: Mind = {
    model: props.model,
    models: props.models,
    loading: false,
    error: null,
    note: '',
    free: false,
    pick: props.onModel,
  };
  // `on` is the toggle's state, so a chip in the full ink is one in force.
  const chips: Chip[] = [
    { id: 'rag', label: 'RAG', on: props.rag, onPress: () => props.onRag(!props.rag) },
    { id: 'tab', label: 'Tab', on: props.tab, onPress: () => props.onTab(!props.tab) },
  ];

  const plus: PlusProps = {
    ...(props.onAttachPage ? { upload: props.onAttachPage } : null),
    memory: { on: props.rag, set: props.onRag },
    research: { on: props.tab, set: props.onTab },
  };

  const carried: Carried[] | undefined =
    props.pageAttached && props.pageContext && props.onDetachPage
      ? [
          {
            id: 'active-page',
            label: props.pageContext.title || props.pageContext.url || 'Active page',
            onRemove: props.onDetachPage,
          },
        ]
      : undefined;

  const commands: Command[] = [
    ...(props.onNewThread
      ? [{ id: 'new-thread', label: 'New thread', keys: '⌘⇧O', run: props.onNewThread }]
      : []),
    ...(props.onAttachPage
      ? [{ id: 'attach-page', label: 'Attach active page', keys: '⌘U', run: props.onAttachPage }]
      : []),
    { id: 'toggle-rag', label: props.rag ? 'Disable RAG retrieval' : 'Enable RAG retrieval', run: () => props.onRag(!props.rag) },
    { id: 'toggle-tab', label: props.tab ? 'Disable Tab context' : 'Enable Tab context', run: () => props.onTab(!props.tab) },
    ...(props.onOpenTab
      ? [
          { id: 'open-tools', label: 'Open Tools', run: () => props.onOpenTab?.('tools') },
          { id: 'open-settings', label: 'Open Settings', run: () => props.onOpenTab?.('settings') },
        ]
      : []),
  ];

  if (!signedIn) {
    return (
      <YStack flex={1} justify="center" items="center" gap="$3" p="$5">
        <SizableText size="$5" fontWeight="600">
          Sign in to Hanzo AI
        </SizableText>
        <SizableText size="$2" color="$color10" text="center">
          Chat with Zen AI models, use browser tools, and build with AI agents.
        </SizableText>
        <Button width="100%" onPress={props.onSignIn}>
          Sign in
        </Button>
        <Button width="100%" variant="outline" onPress={props.onSignUp}>
          Create account
        </Button>
        <SizableText size="$1" color="$color10" text="center">
          Browser tools work without sign-in.{' '}
          <a href="https://docs.hanzo.ai" target="_blank" rel="noreferrer">
            Learn more
          </a>
        </SizableText>
      </YStack>
    );
  }

  return (
    <YStack flex={1} minH={0}>
      <YStack flex={1} minH={0} px="$3">
        <Thread maxWidth={0} gap={16}>
          {turns.length === 0 ? (
            <Message role="system">Ask anything. Powered by Hanzo Cloud.</Message>
          ) : (
            turns.map((t, i) => (
              <Message
                key={t.id}
                role={t.role}
                busy={busy && i === turns.length - 1 && t.role === 'assistant' && !t.content}
              >
                {t.error ? (
                  <Failure onRetry={props.onRetry}>{t.error}</Failure>
                ) : t.role === 'assistant' ? (
                  <Prose text={t.content} />
                ) : (
                  t.content
                )}
              </Message>
            ))
          )}
        </Thread>
      </YStack>

      <YStack p="$2">
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={props.onStop}
          busy={busy}
          placeholder="Ask anything…"
          hint={props.status}
          mind={mind}
          chips={chips}
          plus={plus}
          carried={carried}
          commands={commands}
        >
          {speechSupported ? (
            <button
              type="button"
              className="composer-mic-btn"
              data-listening={listening ? 'true' : 'false'}
              title={listening ? 'Stop dictation' : 'Voice dictation'}
              aria-label={listening ? 'Stop dictation' : 'Voice dictation'}
              onClick={toggleVoice}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0" strokeLinecap="round" />
                <line x1="12" y1="17" x2="12" y2="22" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
        </Composer>
      </YStack>
    </YStack>
  );
}
