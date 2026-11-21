// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuiProvider } from '@hanzo/gui';
import guiConfig from '@hanzo/ui/gui-config';
import { AnswerEngine } from '../src/answer/AnswerEngine.js';

/**
 * The new tab asks the one chat: its composer offers the model, in the line
 * under the frame, and no modes or sources of its own. What the answer looks
 * for (the web, the org's knowledge, pages) is the agent's tools, not a switch.
 */

const html = renderToStaticMarkup(
  React.createElement(
    GuiProvider,
    { config: guiConfig, defaultTheme: 'dark' },
    React.createElement(AnswerEngine, { getToken: async () => null, signIn: () => {} }),
  ),
);
const doc = new DOMParser().parseFromString(html, 'text/html');

describe('the new tab composer', () => {
  it('draws the model picker under the frame, not in it', () => {
    const frame = doc.querySelector('[data-slot="composer"]')?.outerHTML ?? '';
    const foot = doc.querySelector('[data-slot="composer-foot"]')?.outerHTML ?? '';
    expect(foot).toContain('data-slot="model-picker"');
    expect(frame).not.toContain('data-slot="model-picker"');
  });

  it('has no modes and no source chips', () => {
    expect(doc.querySelector('[data-slot="mode"]')).toBeNull();
    expect(doc.querySelector('[data-slot="composer-chip"]')).toBeNull();
  });
});
