import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, SizableText, YStack } from '@hanzo/ui/primitives';
import { Composer, Failure, Message, Step, Thread, type Command, type Mind } from '@hanzo/ui/chat';
import type { ModelCatalogEntry } from '@hanzo/ui/models';
import { Widgets } from './answer/WidgetView.js';
import { extractWidgets } from './answer/widget.js';
import type { Turn } from './shared/agent.js';
import { Prose } from './shared/Prose.js';

/**
 * The chat surface the sidebar draws: `@hanzo/ui/chat`'s Thread and Composer over
 * the background agent's thread (shared/agent.ts). The thread, the model call and
 * the tools are the agent's; this file draws turns and hands the person's words
 * back. `Turns` is the one drawing of a thread, the new tab's too.
 */

export interface ChatProps {
  turns: Turn[];
  busy: boolean;
  /** Send the draft's trimmed text. The composer is already empty. */
  onSend: (text: string) => void;
  onStop: () => void;
  models: ModelCatalogEntry[];
  model: string;
  onModel: (id: string) => void;
  signedIn: boolean;
  onSignIn: () => void;
  onSignUp: () => void;
  onNewThread?: () => void;
  onOpenTab?: (tab: 'chat' | 'tools' | 'settings') => void;
}

/** A thread: what was asked, the steps taken on the way, and what came back. */
export function Turns({ turns, busy }: { turns: Turn[]; busy: boolean }) {
  const last = turns[turns.length - 1];
  return (
    <>
      {turns.map((t, i) =>
        t.role === 'step' ? (
          <Step key={t.id} name={t.content} status={busy && i === turns.length - 1 ? 'running' : 'done'} />
        ) : t.role === 'user' ? (
          <Message key={t.id} role="user">
            {t.content}
          </Message>
        ) : (
          <Message key={t.id} role="assistant">
            {t.error ? <Failure>{t.error}</Failure> : <Answer text={t.content} />}
          </Message>
        ),
      )}
      {busy && last?.role === 'user' ? <Message role="assistant" busy /> : null}
    </>
  );
}

/** An answer picks its own presentation: widget blocks render as components, the prose is what is left. */
function Answer({ text }: { text: string }) {
  const { prose, widgets } = extractWidgets(text);
  return (
    <>
      <Widgets widgets={widgets} />
      <Prose text={prose} />
    </>
  );
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
  const commands: Command[] = [
    ...(props.onNewThread
      ? [{ id: 'new-thread', label: 'New thread', keys: '⌘⇧O', run: props.onNewThread }]
      : []),
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
          {turns.length === 0 ? <Message role="system">Ask anything, or tell me what to do on this page.</Message> : <Turns turns={turns} busy={busy} />}
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
          mind={mind}
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
