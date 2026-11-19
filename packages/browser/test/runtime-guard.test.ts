import { describe, expect, it } from 'vitest';
import {
  InFlightRequestDeduper,
  isLegacyModel,
  makeChatRequestKey,
  pickModelForTokenBudget,
  trimMessagesToBudget,
} from '../src/runtime-guard';

describe('runtime-guard', () => {
  it('trims older messages to respect token budget while keeping newest', () => {
    const messages = [
      { role: 'system', content: 'sys '.repeat(200) },
      { role: 'user', content: 'older '.repeat(400) },
      { role: 'assistant', content: 'older answer '.repeat(300) },
      { role: 'user', content: 'latest prompt' },
    ];

    const result = trimMessagesToBudget(messages as any, {
      maxMessages: 24,
      maxInputTokens: 300,
    });

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[result.messages.length - 1].content).toContain('latest prompt');
    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(result.inputTokens).toBeLessThanOrEqual(300 + 10);
  });

  it('creates deterministic chat request keys', () => {
    const messages = [{ role: 'user', content: 'hello   world' }];
    const k1 = makeChatRequestKey('gpt-4o', messages as any, 0.2, 500);
    const k2 = makeChatRequestKey('gpt-4o', messages as any, 0.2, 500);
    const k3 = makeChatRequestKey('gpt-4o', [{ role: 'user', content: 'hello world!' }] as any, 0.2, 500);

    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('dedupes in-flight requests with the same key', async () => {
    const deduper = new InFlightRequestDeduper<string>();
    let runs = 0;

    const first = deduper.getOrCreate('same', async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return 'ok';
    });
    const second = deduper.getOrCreate('same', async () => {
      runs += 1;
      return 'second';
    });

    const [a, b] = await Promise.all([first.promise, second.promise]);

    expect(a).toBe('ok');
    expect(b).toBe('ok');
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(runs).toBe(1);
  });

  it('routes auto to zen6-flash for a short prompt and zen6 otherwise, upgrading legacy ids', () => {
    expect(pickModelForTokenBudget('auto', ['zen6', 'zen6-flash'], 200)).toBe('zen6-flash');
    expect(pickModelForTokenBudget('auto', ['zen6', 'zen6-flash'], 5000)).toBe('zen6');
    expect(pickModelForTokenBudget('auto', [], 200)).toBe('zen6');
    expect(pickModelForTokenBudget('auto', ['enso'], 200)).toBe('enso');
    expect(pickModelForTokenBudget('zen6-coder', ['zen6'], 200)).toBe('zen6-coder');
    expect(pickModelForTokenBudget('zen5', ['enso', 'zen6'], 200)).toBe('enso');
    expect(pickModelForTokenBudget('zen4', ['zen6'], 200)).toBe('zen6');
    expect(pickModelForTokenBudget('qwen2-72b', ['enso'], 200)).toBe('enso');
    expect(isLegacyModel('zen4')).toBe(true);
    expect(isLegacyModel('zen5-flash')).toBe(true);
    expect(isLegacyModel('qwen2.5-72b')).toBe(true);
    expect(isLegacyModel('zen6')).toBe(false);
    expect(isLegacyModel('enso')).toBe(false);
  });
});
