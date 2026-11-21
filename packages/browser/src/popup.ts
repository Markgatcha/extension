// Hanzo AI — Popup Script
// Uses background message passing for auth (not direct storage access).
//
// Polyfill the WebExtension API surface so this script can read/write
// chrome.storage with Promise-returning calls on every browser. Chrome
// gets the polyfill wrapper, Firefox/Safari get a no-op.
import 'webextension-polyfill';

import {
  DEFAULT_INSPECT_SHORTCUT,
  formatShortcut,
  loadInspectShortcut,
  saveInspectShortcut,
  shortcutFromEvent,
  type Shortcut,
} from './shared/shortcut.js';
import { API_BASE_URL } from './shared/config.js';
import { getConsent, setConsent, capture } from './shared/consent.js';
import { renderMarkdown } from './shared/markdown.js';
import { estimateMessageTokens, pickModelForTokenBudget, zenModels } from './runtime-guard.js';
import type { AgentState } from './shared/agent.js';

declare const browser: typeof chrome & {
  sidebarAction?: {
    open(): Promise<void>;
    close(): Promise<void>;
    toggle(): Promise<void>;
  };
};

document.addEventListener('DOMContentLoaded', () => {
  const loginSection = document.getElementById('login-section');
  const mainSection = document.getElementById('main-section');
  const settingsSection = document.getElementById('settings-section');

  // Footer version — pulled from manifest at runtime so it always tracks build.
  const versionEl = document.getElementById('footer-version');
  if (versionEl) {
    try {
      versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
    } catch { /* manifest unavailable in some contexts */ }
  }

  // Model picker: Auto and the Zen chat models of the gateway's own list.
  const modelSelectBtn = document.getElementById('model-select-btn');
  const modelBadge = document.getElementById('model-badge');
  const modelDropdown = document.getElementById('model-dropdown');
  let models: Array<{ id: string; name: string }> = [{ id: 'auto', name: 'Auto' }];
  let selectedModel = 'auto';

  // Every pinnable feature is declared once, in the markup: a tool button, or a section of settings.
  const FEATURES = Array.from(document.querySelectorAll<HTMLElement>('[data-pin]'), (pin) => {
    const id = pin.dataset.pin as string;
    const tool = document.querySelector<HTMLElement>(`[data-tool="${id}"]`);
    return {
      id,
      label: (tool ?? pin.closest('summary'))?.textContent?.trim() ?? id,
      tool: tool !== null,
      section: pin.closest('details.sec')?.id,
    };
  });

  function showMain() {
    settingsSection?.classList.add('hidden');
    mainSection?.classList.remove('hidden');
  }

  function showSettings(sectionId?: string) {
    mainSection?.classList.add('hidden');
    settingsSection?.classList.remove('hidden');
    loadSettings();
    const section = sectionId ? document.getElementById(sectionId) as HTMLDetailsElement | null : null;
    if (section) {
      section.open = true;
      section.scrollIntoView({ block: 'nearest' });
    }
  }

  function drawModels() {
    if (modelBadge) modelBadge.textContent = models.find((m) => m.id === selectedModel)?.name ?? selectedModel;
    modelDropdown?.replaceChildren(
      ...models.map((m) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `model-item${m.id === selectedModel ? ' active' : ''}`;
        item.innerHTML = '<div class="model-item-text"><span class="model-name"></span></div>';
        item.querySelector('.model-name')!.textContent = m.name;
        item.addEventListener('click', () => {
          selectedModel = m.id;
          chrome.storage.local.set({ hanzo_selected_model: m.id });
          drawModels();
          modelDropdown?.classList.add('hidden');
          modelSelectBtn?.classList.remove('open');
        });
        return item;
      }),
    );
  }

  chrome.storage.local.get(['hanzo_selected_model'], (res) => {
    selectedModel = res.hanzo_selected_model || 'auto';
    drawModels();
  });
  chrome.runtime.sendMessage({ action: 'chat.listModels' }, (resp) => {
    if (chrome.runtime.lastError || !resp?.success) return;
    models = [{ id: 'auto', name: 'Auto' }, ...zenModels(resp.models as Array<{ id: string; name?: string; owned_by?: string }>).map((m) => ({ id: m.id, name: m.name || m.id }))];
    drawModels();
  });

  // Quiet Header: hanzo.ai + X-Org-Id switcher & New Thread
  const headerZapDot = document.getElementById('header-zap-dot');
  const orgPillBtn = document.getElementById('org-pill-btn');
  const orgPillLabel = document.getElementById('org-pill-label');
  const orgDropdown = document.getElementById('org-dropdown');
  const popupNewThreadBtn = document.getElementById('popup-new-thread-btn');
  let isAuthenticated = false;
  let activeOrgId: string | null = null;
  let orgList: Array<{ id: string; name: string; displayName?: string }> = [];

  function renderOrgDropdown() {
    if (orgPillLabel) {
      orgPillLabel.textContent = isAuthenticated
        ? (activeOrgId ? `hanzo.ai · ${activeOrgId}` : 'hanzo.ai')
        : 'hanzo.ai';
    }
    if (!orgDropdown) return;
    orgDropdown.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'org-dropdown-title';
    title.textContent = 'X-Org-Id';
    orgDropdown.appendChild(title);
    const items = orgList.length ? orgList : [{ id: activeOrgId || 'hanzo', name: activeOrgId || 'hanzo' }];
    for (const org of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `org-dropdown-item${org.id === activeOrgId ? ' active' : ''}`;
      btn.textContent = org.displayName || org.name || org.id;
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'org.switch', orgId: org.id }, () => {
          void chrome.runtime.lastError;
          activeOrgId = org.id;
          renderOrgDropdown();
          orgDropdown.classList.add('hidden');
        });
      });
      orgDropdown.appendChild(btn);
    }
  }

  function loadOrgs() {
    chrome.runtime.sendMessage({ action: 'org.list' }, (resp) => {
      if (chrome.runtime.lastError || !resp?.success) return;
      orgList = Array.isArray(resp.orgs) ? resp.orgs : [];
      activeOrgId = resp.activeOrgId || orgList[0]?.id || null;
      renderOrgDropdown();
    });
  }

  orgPillBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isAuthenticated) {
      chrome.runtime.sendMessage({ action: 'auth.login' }, () => {
        void chrome.runtime.lastError;
        checkAuth();
      });
      return;
    }
    orgDropdown?.classList.toggle('hidden');
  });

  modelSelectBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = modelDropdown?.classList.contains('hidden');
    if (isHidden) {
      modelDropdown?.classList.remove('hidden');
      modelSelectBtn.classList.add('open');
    } else {
      modelDropdown?.classList.add('hidden');
      modelSelectBtn.classList.remove('open');
    }
  });

  document.addEventListener('click', (e) => {
    if (!modelSelectBtn?.contains(e.target as Node) && !modelDropdown?.contains(e.target as Node)) {
      modelDropdown?.classList.add('hidden');
      modelSelectBtn?.classList.remove('open');
    }
    if (!orgPillBtn?.contains(e.target as Node) && !orgDropdown?.contains(e.target as Node)) {
      orgDropdown?.classList.add('hidden');
    }
  });

  // Auth
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');

  // Open panel
  const openPanel = document.getElementById('open-panel');
  const pinLeftBtn = document.getElementById('pin-left');
  const pinRightBtn = document.getElementById('pin-right');
  const overlayEnabledCheckbox = document.getElementById('overlay-enabled') as HTMLInputElement | null;
  const widthBtns = Array.from(document.querySelectorAll('.width-btn')) as HTMLButtonElement[];
  const overlaySideRow = document.getElementById('overlay-side-row');
  const overlayWidthRow = document.getElementById('overlay-width-row');

  type OverlayWidth = 'compact' | 'default' | 'wide';

  function syncSettingsUi(enabled: boolean, side: 'left' | 'right', width: OverlayWidth) {
    if (overlayEnabledCheckbox) overlayEnabledCheckbox.checked = enabled;
    pinLeftBtn?.setAttribute('data-active', side === 'left' ? 'true' : 'false');
    pinRightBtn?.setAttribute('data-active', side === 'right' ? 'true' : 'false');
    widthBtns.forEach((b) => b.setAttribute('data-active', b.getAttribute('data-width') === width ? 'true' : 'false'));
    // Grey out side/width when on-page overlay is disabled.
    [overlaySideRow, overlayWidthRow].forEach((row) => {
      if (!row) return;
      (row as HTMLElement).style.opacity = enabled ? '1' : '0.5';
      (row as HTMLElement).style.pointerEvents = enabled ? '' : 'none';
    });
  }

  // Status dots
  const zapStatus = document.getElementById('zap-status');
  const zapDetail = document.getElementById('zap-detail');
  const zapPair = document.getElementById('zap-pair') as HTMLElement;
  const zapCode = document.getElementById('zap-code') as HTMLInputElement;
  const zapPairError = document.getElementById('zap-pair-error') as HTMLElement;
  const mcpStatus = document.getElementById('mcp-status');
  const mcpPort = document.getElementById('mcp-port');
  const cdpStatus = document.getElementById('cdp-status');
  const cdpDetail = document.getElementById('cdp-detail');
  const gpuStatus = document.getElementById('gpu-status');
  const gpuDetail = document.getElementById('gpu-detail');

  // Settings
  const openSettings = document.getElementById('open-settings');
  const backBtn = document.getElementById('back-btn');
  const saveSettings = document.getElementById('save-settings');
  const testConnection = document.getElementById('test-connection');

  const userInfoSection = document.getElementById('user-info-section');

  // --- Auth via background ---
  function checkAuth() {
    // Which view shows is not the session's call.
    refreshStatus();

    chrome.runtime.sendMessage({ action: 'auth.status' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.success && response.authenticated) {
        isAuthenticated = true;
        loginSection.classList.add('hidden');
        userInfoSection?.classList.remove('hidden');
        if (response.user) {
          const avatar = document.getElementById('user-avatar') as HTMLImageElement;
          const name = document.getElementById('user-name');
          const email = document.getElementById('user-email');
          avatar.src = response.user.picture || response.user.avatar || 'icon48.png';
          name.textContent = response.user.name || response.user.displayName || 'Hanzo User';
          email.textContent = response.user.email || '';
        }
        loadOrgs();
      } else {
        isAuthenticated = false;
        activeOrgId = null;
        orgList = [];
        renderOrgDropdown();
        loginSection.classList.remove('hidden');
        userInfoSection?.classList.add('hidden');
      }
    });
  }

  loginBtn?.addEventListener('click', () => {
    (loginBtn as HTMLButtonElement).disabled = true;
    loginBtn.textContent = 'Signing in...';
    chrome.runtime.sendMessage({ action: 'auth.login' }, (response) => {
      (loginBtn as HTMLButtonElement).disabled = false;
      loginBtn.textContent = 'Sign in';
      if (response?.success) {
        checkAuth();
      }
    });
  });

  // Signup button in login card
  const signupBtnPopup = document.getElementById('signup-btn-popup');
  signupBtnPopup?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'auth.signup' });
  });

  logoutBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'auth.logout' }, () => {
      loginSection.classList.remove('hidden');
      userInfoSection?.classList.add('hidden');
    });
  });

  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area && area !== 'local') return;
      if ('hanzo_iam_access_token' in changes || 'hanzo_iam_user' in changes) {
        checkAuth();
      }
    });
  } catch {}

  // --- The thread ---
  // The agent lives in the background so it outlives this popup; this page
  // follows it on a port and draws the thread it is sent.
  const tabContextTitle = document.getElementById('tab-context-title');
  const askBtn = document.getElementById('ask-btn') as HTMLButtonElement | null;
  const voiceMicBtn = document.getElementById('voice-mic-btn');
  const thread = document.getElementById('thread');
  const threadEmpty = document.getElementById('thread-empty');
  let activeTabId: number | undefined;
  let busy = false;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab) {
      activeTabId = tab.id;
      if (tabContextTitle) tabContextTitle.textContent = tab.title || tab.url || 'Active Tab';
    }
  });

  const searchForm = document.getElementById('search-form') as HTMLFormElement | null;
  const searchInput = document.getElementById('search-input') as HTMLTextAreaElement | HTMLInputElement | null;

  function resizeComposer() {
    if (!searchInput) return;
    if (searchInput instanceof HTMLTextAreaElement) {
      searchInput.style.height = 'auto';
      searchInput.style.height = `${Math.min(searchInput.scrollHeight, 140)}px`;
    }
    // While a turn runs the button stops it, so it stays pressable.
    if (askBtn) askBtn.disabled = !busy && !searchInput.value.trim();
  }
  searchInput?.addEventListener('input', resizeComposer);
  resizeComposer();

  function drawThread(state: AgentState) {
    if (!thread) return;
    busy = state.busy;
    if (askBtn) {
      askBtn.dataset.busy = String(busy);
      askBtn.title = busy ? 'Stop' : 'Send (Enter)';
      askBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    }
    resizeComposer();
    if (threadEmpty) threadEmpty.classList.toggle('hidden', state.turns.length > 0);
    thread.querySelectorAll('.msg').forEach((n) => n.remove());
    const last = state.turns[state.turns.length - 1];
    for (const turn of state.turns) {
      const row = document.createElement('div');
      row.className = `msg msg-${turn.role}`;
      if (turn.error) {
        row.className = 'msg msg-error';
        row.textContent = turn.error;
        if (/sign in/i.test(turn.error)) loginSection?.classList.remove('hidden');
      } else if (turn.role === 'assistant') {
        row.innerHTML = renderMarkdown(turn.content);
      } else if (turn.role === 'step') {
        row.innerHTML = '<span class="step-dot"></span>';
        row.appendChild(document.createTextNode(turn.content));
      } else {
        row.textContent = turn.content;
      }
      thread.appendChild(row);
    }
    if (state.busy && last?.role !== 'step') {
      const row = document.createElement('div');
      row.className = 'msg msg-step working';
      row.innerHTML = '<span class="step-dot"></span>Working…';
      thread.appendChild(row);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    if (searchInput) searchInput.value = '';
    resizeComposer();
    const model = pickModelForTokenBudget(selectedModel, models.map((m) => m.id), estimateMessageTokens([{ role: 'user', content: q }]));
    chrome.runtime.sendMessage(
      { action: 'agent.send', text: q, model, tabId: activeTabId, orgId: activeOrgId || undefined },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.success) {
          const row = document.createElement('div');
          row.className = 'msg msg-error';
          row.textContent = resp?.error || chrome.runtime.lastError?.message || 'The agent is not running.';
          thread?.appendChild(row);
          if (thread) thread.scrollTop = thread.scrollHeight;
        }
      },
    );
  }

  function stop() {
    chrome.runtime.sendMessage({ action: 'agent.stop' }, () => void chrome.runtime.lastError);
  }

  // The thread arrives on connect and after every change; a stopped worker closes the port, so connect again.
  function follow() {
    const port = chrome.runtime.connect({ name: 'agent' });
    port.onMessage.addListener((m) => {
      if (m?.action === 'agent.update') drawThread(m.state as AgentState);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      setTimeout(follow, 500);
    });
  }
  follow();

  popupNewThreadBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'agent.reset' }, () => void chrome.runtime.lastError);
    if (searchInput) searchInput.value = '';
    resizeComposer();
    showMain();
    searchInput?.focus();
  });

  // Optional browser speech dictation inside composer
  const SpeechCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (SpeechCtor && voiceMicBtn) {
    voiceMicBtn.classList.remove('hidden');
    let rec: any = null;
    let listening = false;
    const stopRec = () => {
      listening = false;
      voiceMicBtn.setAttribute('data-listening', 'false');
      try { rec?.stop(); } catch {}
      rec = null;
    };
    voiceMicBtn.addEventListener('click', () => {
      if (listening) { stopRec(); return; }
      try {
        rec = new SpeechCtor();
        rec.continuous = false;
        rec.interimResults = false;
        rec.lang = navigator.language || 'en-US';
        rec.onresult = (ev: any) => {
          const text = Array.from(ev?.results ?? [])
            .map((r: any) => r?.[0]?.transcript ?? '')
            .join(' ')
            .trim();
          if (text && searchInput) {
            searchInput.value = searchInput.value.trim() ? `${searchInput.value.trimEnd()} ${text}` : text;
            resizeComposer();
          }
        };
        rec.onerror = stopRec;
        rec.onend = stopRec;
        rec.start();
        listening = true;
        voiceMicBtn.setAttribute('data-listening', 'true');
      } catch {
        stopRec();
      }
    });
  }

  function openSearch(query: string) {
    const target = query
      ? chrome.runtime.getURL('newtab.html') + '?q=' + encodeURIComponent(query)
      : chrome.runtime.getURL('newtab.html');
    chrome.tabs.create({ url: target });
    window.close();
  }

  searchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) stop();
    else ask(searchInput?.value ?? '');
  });

  searchInput?.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    // IME-safe Enter submit + Shift+Enter newline + Cmd/Ctrl+Enter force submit
    const imeClaimed = ke.isComposing || ke.key === 'Process' || ke.keyCode === 229;
    if (ke.key === 'Enter' && !imeClaimed && (ke.metaKey || ke.ctrlKey || (!ke.shiftKey && !ke.altKey))) {
      ke.preventDefault();
      if (!busy) ask(searchInput.value);
    }
  });

  // Command / Search Palette (⌘K / Ctrl+K)
  const cmdPalette = document.getElementById('popup-cmd-palette');
  const cmdInput = document.getElementById('cmd-palette-input') as HTMLInputElement | null;
  const cmdList = document.getElementById('cmd-palette-list');
  const commands: Array<{ label: string; hint?: string; run: () => void }> = [
    { label: 'New thread', hint: 'Clear', run: () => popupNewThreadBtn?.click() },
    { label: 'Chat on the page', hint: 'Panel', run: () => openPanel?.click() },
    { label: 'Open the answer engine', hint: 'Tab', run: () => openSearch(searchInput?.value.trim() || '') },
    { label: 'Settings', hint: 'Prefs', run: () => showSettings() },
    ...FEATURES.map((f) => ({ label: f.label, hint: f.tool ? 'Tool' : 'Settings', run: () => runFeature(f.id, null) })),
  ];
  let cmdActive = 0;

  function renderCmdList(filter = '') {
    if (!cmdList) return;
    const q = filter.trim().toLowerCase();
    const matches = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
    cmdActive = Math.min(cmdActive, Math.max(0, matches.length - 1));
    cmdList.innerHTML = '';
    matches.forEach((cmd, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cmd-palette-item${idx === cmdActive ? ' active' : ''}`;
      btn.innerHTML = `<span>${cmd.label}</span>${cmd.hint ? `<span class="cmd-palette-hint">${cmd.hint}</span>` : ''}`;
      btn.addEventListener('click', () => {
        closeCmdPalette();
        cmd.run();
      });
      cmdList.appendChild(btn);
    });
  }

  function openCmdPalette() {
    if (!cmdPalette) return;
    cmdPalette.classList.remove('hidden');
    if (cmdInput) {
      cmdInput.value = '';
      cmdActive = 0;
      renderCmdList('');
      cmdInput.focus();
    }
  }

  function closeCmdPalette() {
    cmdPalette?.classList.add('hidden');
  }

  cmdPalette?.addEventListener('click', (e) => {
    if (e.target === cmdPalette) closeCmdPalette();
  });

  cmdInput?.addEventListener('input', () => {
    cmdActive = 0;
    renderCmdList(cmdInput.value);
  });

  cmdInput?.addEventListener('keydown', (e) => {
    const items = cmdList?.querySelectorAll<HTMLButtonElement>('.cmd-palette-item');
    if (e.key === 'Escape') { e.preventDefault(); closeCmdPalette(); return; }
    if (!items?.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdActive = (cmdActive + 1) % items.length; renderCmdList(cmdInput.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdActive = (cmdActive - 1 + items.length) % items.length; renderCmdList(cmdInput.value); }
    else if (e.key === 'Enter') { e.preventDefault(); items[cmdActive]?.click(); }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (cmdPalette?.classList.contains('hidden')) openCmdPalette();
      else closeCmdPalette();
    }
  });

  // Suggestions in an empty thread
  document.querySelectorAll('.quick-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      const p = pill.getAttribute('data-prompt');
      if (p) ask(p);
    });
  });

  // --- Open chat ---
  // Default surface: in-page edge-pinned overlay (content-script). Honours
  // the user's `overlayEnabled`, `overlaySide`, and `overlayWidth` prefs.
  // When `overlayEnabled` is false (or the active tab is privileged), opens
  // the chat surface in a standalone tab. Firefox users can also reach it
  // via View → Sidebar → Hanzo AI (registered via sidebar_action).
  function openSidebarTab() {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidebar.html') });
    window.close();
  }

  openPanel?.addEventListener('click', () => {
    chrome.storage?.sync?.get?.(['overlayEnabled', 'overlaySide', 'overlayWidth'], (vals) => {
      const enabled = vals?.overlayEnabled !== false;
      const side = vals?.overlaySide === 'left' ? 'left' : 'right';
      const width: OverlayWidth = vals?.overlayWidth === 'compact'
        ? 'compact' : vals?.overlayWidth === 'wide' ? 'wide' : 'default';
      if (!enabled) { openSidebarTab(); return; }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        const target = isInjectableTab(activeTab) ? activeTab : null;
        if (!target?.id) { openSidebarTab(); return; }
        chrome.runtime.sendMessage({
          action: 'page.overlay.show',
          tabId: target.id,
          side,
          width,
        }, () => window.close());
      });
    });
  });

  function setActiveSide(side: 'left' | 'right') {
    chrome.storage?.sync?.set?.({ overlaySide: side });
    pinLeftBtn?.setAttribute('data-active', side === 'left' ? 'true' : 'false');
    pinRightBtn?.setAttribute('data-active', side === 'right' ? 'true' : 'false');
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs[0]?.id;
      if (id) chrome.runtime.sendMessage({ action: 'page.overlay.setSide', tabId: id, side });
    });
  }
  function setActiveWidth(width: OverlayWidth) {
    chrome.storage?.sync?.set?.({ overlayWidth: width });
    widthBtns.forEach((b) => b.setAttribute('data-active', b.getAttribute('data-width') === width ? 'true' : 'false'));
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs[0]?.id;
      if (id) chrome.runtime.sendMessage({ action: 'page.overlay.setWidth', tabId: id, width });
    });
  }
  function setOverlayEnabled(enabled: boolean) {
    chrome.storage?.sync?.set?.({ overlayEnabled: enabled });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs[0]?.id;
      if (id) chrome.runtime.sendMessage({ action: 'page.overlay.setEnabled', tabId: id, enabled });
    });
    chrome.storage?.sync?.get?.(['overlaySide', 'overlayWidth'], (vals) => {
      const side = vals?.overlaySide === 'left' ? 'left' : 'right';
      const width: OverlayWidth = vals?.overlayWidth === 'compact'
        ? 'compact' : vals?.overlayWidth === 'wide' ? 'wide' : 'default';
      syncSettingsUi(enabled, side, width);
    });
  }

  pinLeftBtn?.addEventListener('click', () => setActiveSide('left'));
  pinRightBtn?.addEventListener('click', () => setActiveSide('right'));
  widthBtns.forEach((b) => b.addEventListener('click', () => {
    const w = b.getAttribute('data-width') as OverlayWidth | null;
    if (w === 'compact' || w === 'default' || w === 'wide') setActiveWidth(w);
  }));
  overlayEnabledCheckbox?.addEventListener('change', (e) => {
    setOverlayEnabled((e.target as HTMLInputElement).checked);
  });

  // Initial UI sync from storage.
  chrome.storage?.sync?.get?.(['overlayEnabled', 'overlaySide', 'overlayWidth'], (vals) => {
    const enabled = vals?.overlayEnabled !== false;
    const side = vals?.overlaySide === 'left' ? 'left' : 'right';
    const width: OverlayWidth = vals?.overlayWidth === 'compact'
      ? 'compact' : vals?.overlayWidth === 'wide' ? 'wide' : 'default';
    syncSettingsUi(enabled, side, width);
  });

  // Privacy & data toggles — reflect stored consent, persist on change.
  const insightsCheckbox = document.getElementById('insights-enabled') as HTMLInputElement | null;
  const shareTrainingCheckbox = document.getElementById('share-training') as HTMLInputElement | null;
  getConsent().then((c) => {
    if (insightsCheckbox) insightsCheckbox.checked = c.insights;
    if (shareTrainingCheckbox) shareTrainingCheckbox.checked = c.shareTraining;
  });
  insightsCheckbox?.addEventListener('change', (e) => {
    void setConsent({ insights: (e.target as HTMLInputElement).checked });
  });
  shareTrainingCheckbox?.addEventListener('change', (e) => {
    void setConsent({ shareTraining: (e.target as HTMLInputElement).checked });
  });
  void capture('popup_opened');

  function isInjectableTab(tab: chrome.tabs.Tab | undefined): boolean {
    if (!tab || !tab.id) return false;
    const url = tab.url || '';
    if (!url) return false;
    if (url.startsWith('chrome://')) return false;
    if (url.startsWith('chrome-extension://')) return false;
    if (url.startsWith('devtools://')) return false;
    if (url.startsWith('edge://')) return false;
    if (url.startsWith('about:')) return false;
    if (url.startsWith('view-source:')) return false;
    if (url.startsWith('moz-extension://')) return false;
    return true;
  }

  // --- Status ---
  function setStatus(dot: HTMLElement, detail: HTMLElement, connected: boolean, text: string) {
    dot.classList.toggle('connected', connected);
    dot.classList.toggle('disconnected', !connected);
    detail.textContent = text;
  }

  // Pairing with this computer's ZAP router: the code comes from
  // `hanzo-mcp pair`, and the background keeps it in storage.local.
  document.getElementById('zap-pair-btn')?.addEventListener('click', () => {
    zapPairError.textContent = '';
    chrome.runtime.sendMessage({ action: 'zap.pair', code: zapCode.value }, (response) => {
      if (chrome.runtime.lastError) return;
      if (!response?.success) {
        zapPairError.textContent = response?.error || 'Pairing failed';
        return;
      }
      zapCode.value = '';
      setTimeout(refreshStatus, 800);
    });
  });

  // Support deep-link URL params (?pair=<code> and/or ?reload=1) so CLI/MCP tools
  // can pair or reload the unpacked extension without manual clicks.
  try {
    const params = new URLSearchParams(window.location.search);
    const pairParam = params.get('pair');
    const reloadParam = params.get('reload');
    if (pairParam !== null) {
      chrome.runtime.sendMessage({ action: 'zap.pair', code: pairParam }, () => {
        void chrome.runtime.lastError;
        if (reloadParam === '1') {
          setTimeout(() => chrome.runtime.reload(), 150);
        } else {
          setTimeout(refreshStatus, 800);
        }
      });
    } else if (reloadParam === '1') {
      chrome.storage?.local?.remove?.(['zapPairing'], () => {
        void chrome.runtime.lastError;
        chrome.runtime.reload();
      });
    }
  } catch { /* ignore URL param errors */ }

  function refreshStatus() {
    // ZAP Bridge
    chrome.runtime.sendMessage({ action: 'zap.status' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.success) {
        const zap = response.zap;
        const text = zap.connected ? `${zap.caps?.length || 0} tools`
          : !zap.paired ? 'Not paired'
          : zap.error === 'no-router' ? 'No router — start hanzo-mcp'
          : zap.error === 'mismatch' ? 'Pairing mismatch — pair again'
          : zap.error === 'refused' ? 'Router refused this browser'
          : 'Connecting…';
        setStatus(zapStatus, zapDetail, zap.connected, text);
        if (headerZapDot) {
          headerZapDot.classList.toggle('connected', Boolean(zap.connected));
          headerZapDot.title = zap.connected ? `ZAP connected (${zap.caps?.length || 0} tools)` : `ZAP: ${text}`;
        }
        zapPair.hidden = zap.connected || (zap.paired && zap.error !== 'mismatch');
      }
    });

    // CDP Bridge
    chrome.runtime.sendMessage({ action: 'bridge.status' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.success && response.connected) {
        const browsers = response.browsers || [];
        setStatus(cdpStatus, cdpDetail, true, browsers.length ? `Connected` : 'Connected');
      } else {
        setStatus(cdpStatus, cdpDetail, false, 'Not connected');
      }
    });

    // MCP Bridge — probe the configured port (default 9224 for hanzo-mcp HTTP).
    // Falls back to 9224 only if storage hasn't been written yet, but always
    // SHOWS the actual port that was probed so the user isn't lied to.
    chrome.storage.local.get(['mcpBridgePort'], (s) => {
      const probePort = Number(s.mcpBridgePort) || 9224;
      const url = `http://localhost:${probePort}`;
      const offline = () => setStatus(mcpStatus, mcpPort, false, `:${probePort} offline`);
      try {
        fetch(url, { signal: AbortSignal.timeout(2000) })
          .then(r => r.json())
          .then(data => {
            if (data?.service === 'hanzo.browser') {
              setStatus(mcpStatus, mcpPort, true, `:${probePort} OK`);
            } else {
              setStatus(mcpStatus, mcpPort, false, `:${probePort} N/A`);
            }
          })
          .catch(offline);
      } catch {
        offline();
      }
    });

    // WebGPU
    chrome.runtime.sendMessage({ action: 'runLocalAI', prompt: '' }, (response) => {
      if (chrome.runtime.lastError) return;
      setStatus(gpuStatus, gpuDetail, !!response?.success, response?.success ? 'Available' : 'Not available');
    });
  }

  // --- Settings ---
  openSettings?.addEventListener('click', () => showSettings());
  backBtn?.addEventListener('click', showMain);

  function loadSettings() {
    chrome.storage.local.get(['mcpPort', 'cdpPort'], (result) => {
      const mcpPortInput = document.getElementById('mcp-port-setting') as HTMLInputElement | null;
      const cdpPortInput = document.getElementById('cdp-port-setting') as HTMLInputElement | null;

      if (mcpPortInput) mcpPortInput.value = String(result.mcpPort || 3001);
      if (cdpPortInput) cdpPortInput.value = String(result.cdpPort || 9223);
    });

    // Inspect-modifier display + recorder.
    refreshShortcutDisplay();
  }

  // ── Inspect Shortcut Recorder ─────────────────────────────────────────
  // Shows the current chord; clicking "Record" captures a single keydown
  // and saves the resulting Shortcut to chrome.storage.local. Content
  // scripts watch storage for changes and update without page reload.
  let recordingShortcut = false;
  let recordingHandler: ((e: KeyboardEvent) => void) | null = null;

  async function refreshShortcutDisplay() {
    const display = document.getElementById('inspect-shortcut-current');
    const s = await loadInspectShortcut(chrome.storage.local as any);
    if (display) display.textContent = formatShortcut(s);
  }
  // Initial render before settings panel is opened (header chip).
  refreshShortcutDisplay();

  function startRecording(label: HTMLElement) {
    if (recordingShortcut) return;
    recordingShortcut = true;
    label.textContent = 'Press a key…';
    recordingHandler = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const next = shortcutFromEvent(e);
      if (!next) {
        // Tab/Esc pressed — bail out without saving.
        stopRecording();
        return;
      }
      await saveInspectShortcut(chrome.storage.local as any, next);
      stopRecording();
      refreshShortcutDisplay();
    };
    document.addEventListener('keydown', recordingHandler, { capture: true });
    // Safety: cancel recording after 10s in case the user wanders off.
    setTimeout(() => { if (recordingShortcut) stopRecording(); }, 10000);
  }

  function stopRecording() {
    if (recordingHandler) document.removeEventListener('keydown', recordingHandler, { capture: true });
    recordingHandler = null;
    recordingShortcut = false;
    refreshShortcutDisplay();
  }

  document.getElementById('inspect-shortcut-record')?.addEventListener('click', (e) => {
    e.preventDefault();
    const display = document.getElementById('inspect-shortcut-current');
    if (display) startRecording(display);
  });
  document.getElementById('inspect-shortcut-reset')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await saveInspectShortcut(chrome.storage.local as any, { ...DEFAULT_INSPECT_SHORTCUT });
    refreshShortcutDisplay();
  });

  saveSettings?.addEventListener('click', () => {
    const mcpPortVal = parseInt(document.getElementById('mcp-port-setting')?.value) || 3001;
    const cdpPortVal = parseInt(document.getElementById('cdp-port-setting')?.value) || 9223;

    chrome.storage.local.set({
      mcpPort: mcpPortVal,
      cdpPort: cdpPortVal,
    }, () => {
      saveSettings.textContent = 'Saved!';
      setTimeout(() => { saveSettings.textContent = 'Save Settings'; }, 1500);
    });
  });

  // --- Test Connection ---
  testConnection?.addEventListener('click', () => {
    testConnection.textContent = 'Testing...';
    testConnection.disabled = true;
    refreshStatus();
    testConnection.textContent = 'Test Connection';
    testConnection.disabled = false;
  });

  // Feature toggles
  ['source-maps', 'webgpu-ai', 'browser-control', 'tab-filesystem'].forEach(id => {
    const checkbox = document.getElementById(id);
    if (checkbox) {
      chrome.storage.local.get([id], (result) => {
        checkbox.checked = result[id] !== false; // default on
      });
      checkbox.addEventListener('change', () => {
        chrome.storage.local.set({ [id]: checkbox.checked });
      });
    }
  });

  // --- Browser Backend Picker ---
  const backendSelect = document.getElementById('browser-backend') as HTMLSelectElement | null;
  const bridgeStatus = document.getElementById('bridge-status');
  const bridgeDetail = document.getElementById('bridge-detail');

  function loadBackendPreference() {
    chrome.storage.sync.get(['browserBackend'], (result) => {
      if (backendSelect && result.browserBackend) {
        backendSelect.value = result.browserBackend;
      }
    });
  }

  function refreshBridgeStatus() {
    chrome.runtime.sendMessage({ action: 'bridge.status' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.success && response.connected) {
        bridgeStatus?.classList.add('connected');
        bridgeStatus?.classList.remove('disconnected');
        const browsers = response.browsers || [];
        bridgeDetail.textContent = browsers.length
          ? `Connected: ${browsers.join(', ')}`
          : 'Connected';
      } else {
        bridgeStatus?.classList.remove('connected');
        bridgeStatus?.classList.add('disconnected');
        bridgeDetail.textContent = 'Not connected';
      }
    });
  }

  backendSelect?.addEventListener('change', () => {
    const value = backendSelect.value;

    // Save to chrome.storage.sync (cross-device)
    chrome.storage.sync.set({ browserBackend: value });

    // Forward to background to persist via CDP bridge + sync to IAM
    chrome.runtime.sendMessage({
      action: 'config.save',
      key: 'browserBackend',
      value,
    });
  });

  loadBackendPreference();
  refreshBridgeStatus();

  // --- Tools ---

  function showToolFeedback(btn: HTMLElement, text: string, duration = 1200) {
    const fb = document.createElement('div');
    fb.className = 'tool-feedback';
    fb.textContent = text;
    btn.style.position = 'relative';
    btn.appendChild(fb);
    setTimeout(() => fb.remove(), duration);
  }

  function getActiveTab(): Promise<chrome.tabs.Tab | null> {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs[0] && isInjectableTab(tabs[0]) ? tabs[0] : null);
      });
    });
  }

  // A tool takes the button pressed (settings or pinned chip), so its feedback lands there.
  const RUN: Record<string, (btn: HTMLElement) => Promise<void>> = {
    // Element Picker / Selector tool
    async picker(btn) {
      const tab = await getActiveTab();
      if (!tab?.id) {
        showToolFeedback(btn, 'No page');
        return;
      }
      // Send message to content script to start picker mode
      chrome.tabs.sendMessage(tab.id, { action: 'tool.picker.start' }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          showToolFeedback(btn, 'N/A');
          return;
        }
        showToolFeedback(btn, 'Pick...');
        // Close popup so user can interact with the page
        setTimeout(() => window.close(), 400);
      });
    },

    // Screenshot tool
    async screenshot(btn) {
      btn.setAttribute('disabled', 'true');
      try {
        chrome.tabs.captureVisibleTab(null as any, { format: 'png' }, (dataUrl) => {
          if (chrome.runtime.lastError || !dataUrl) {
            showToolFeedback(btn, 'Failed');
            btn.removeAttribute('disabled');
            return;
          }
          // Copy to clipboard as image
          fetch(dataUrl)
            .then(r => r.blob())
            .then(blob => {
              const item = new ClipboardItem({ 'image/png': blob });
              return navigator.clipboard.write([item]);
            })
            .then(() => {
              showToolFeedback(btn, 'Copied!');
            })
            .catch(() => {
              // Fallback: open in new tab
              chrome.tabs.create({ url: dataUrl });
              showToolFeedback(btn, 'Opened');
            })
            .finally(() => {
              btn.removeAttribute('disabled');
            });
        });
      } catch {
        showToolFeedback(btn, 'Error');
        btn.removeAttribute('disabled');
      }
    },

    // Page Info tool
    async pageinfo(btn) {
      const tab = await getActiveTab();
      if (!tab?.id) {
        showToolFeedback(btn, 'No page');
        return;
      }
      chrome.tabs.sendMessage(tab.id, { action: 'tool.pageinfo' }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          // Fallback: basic info from tab object
          const info = `Title: ${tab.title}\nURL: ${tab.url}`;
          navigator.clipboard.writeText(info).then(() => {
            showToolFeedback(btn, 'Copied!');
          });
          return;
        }
        navigator.clipboard.writeText(response.info).then(() => {
          showToolFeedback(btn, 'Copied!');
        }).catch(() => {
          showToolFeedback(btn, 'Failed');
        });
      });
    },

    // Accessibility Audit tool
    async a11y(btn) {
      const tab = await getActiveTab();
      if (!tab?.id) {
        showToolFeedback(btn, 'No page');
        return;
      }
      btn.setAttribute('disabled', 'true');
      showToolFeedback(btn, 'Running...');
      chrome.runtime.sendMessage({ action: 'audit.accessibility', tabId: tab.id }, (response) => {
        btn.removeAttribute('disabled');
        if (chrome.runtime.lastError || !response?.success) {
          showToolFeedback(btn, 'Failed');
          return;
        }
        const count = response.issues?.length || 0;
        showToolFeedback(btn, count ? `${count} issues` : 'Clean!');
      });
    },

    // Performance Audit tool
    async perf(btn) {
      const tab = await getActiveTab();
      if (!tab?.id) {
        showToolFeedback(btn, 'No page');
        return;
      }
      btn.setAttribute('disabled', 'true');
      showToolFeedback(btn, 'Running...');
      chrome.runtime.sendMessage({ action: 'audit.performance', tabId: tab.id }, (response) => {
        btn.removeAttribute('disabled');
        if (chrome.runtime.lastError || !response?.success) {
          showToolFeedback(btn, 'Failed');
          return;
        }
        showToolFeedback(btn, 'Done');
      });
    },

    // Console tool — evaluate JS
    async console(btn) {
      const tab = await getActiveTab();
      if (!tab?.id) {
        showToolFeedback(btn, 'No page');
        return;
      }
      // Send to content script to start an inline eval prompt
      chrome.tabs.sendMessage(tab.id, { action: 'tool.console.start' }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          showToolFeedback(btn, 'N/A');
          return;
        }
        showToolFeedback(btn, 'Open');
        setTimeout(() => window.close(), 400);
      });
    },

    // The answer engine in a new tab, with what is typed
    async answer() {
      openSearch(searchInput?.value.trim() || '');
    },
  };

  // --- Features: settings holds them all; a pin keeps one on the chat view ---
  const PIN_KEY = 'hanzo_pinned';
  let pinned: string[] = [];

  function runFeature(id: string, btn: HTMLElement | null) {
    const feature = FEATURES.find((f) => f.id === id);
    if (!feature) return;
    if (!feature.tool) {
      showSettings(feature.section);
      return;
    }
    const el = btn ?? document.querySelector<HTMLElement>(`[data-tool="${id}"]`);
    if (el) void RUN[id](el);
  }

  function drawPins() {
    const bar = document.getElementById('pins');
    if (bar) {
      bar.replaceChildren(
        ...pinned.flatMap((id) => {
          const f = FEATURES.find((x) => x.id === id);
          if (!f) return [];
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'pin-chip';
          chip.dataset.feature = f.id;
          chip.textContent = f.label;
          return [chip];
        }),
      );
      bar.classList.toggle('hidden', !bar.children.length);
    }
    document.querySelectorAll<HTMLElement>('.pin-btn').forEach((b) => {
      const on = pinned.includes(b.dataset.pin ?? '');
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Unpin from chat view' : 'Pin to chat view';
    });
  }

  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const pin = t.closest<HTMLElement>('[data-pin]');
    if (pin) {
      // A pin sits inside a section's summary: it must not open or close the section.
      e.preventDefault();
      e.stopPropagation();
      const id = pin.dataset.pin as string;
      pinned = pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id];
      chrome.storage.local.set({ [PIN_KEY]: pinned });
      drawPins();
      return;
    }
    const feature = t.closest<HTMLElement>('[data-feature], [data-tool]');
    if (feature) runFeature((feature.dataset.feature ?? feature.dataset.tool) as string, feature);
  });

  chrome.storage.local.get([PIN_KEY], (res) => {
    const saved = res[PIN_KEY];
    pinned = Array.isArray(saved) ? saved.filter((id) => FEATURES.some((f) => f.id === id)) : [];
    drawPins();
  });

  // A section loads what it shows when it opens, not when the popup does.
  const onOpen: Record<string, () => void> = {
    'sec-accounts': () => { loadUsage(); refreshConnectedAccounts(); },
    'sec-bridges': () => refreshStatus(),
    'sec-linked': () => drawLinked(),
  };
  document.querySelectorAll<HTMLDetailsElement>('details.sec').forEach((d) => {
    d.addEventListener('toggle', () => { if (d.open) onOpen[d.id]?.(); });
  });

  // --- Linked to Hanzo: this browser as a source (HIP-1350). ---
  const linkedStatus = document.getElementById('linked-status') as HTMLElement;
  const linkedLink = document.getElementById('linked-link') as HTMLButtonElement;
  const linkedUnlink = document.getElementById('linked-unlink') as HTMLButtonElement;
  const linkedSources = document.getElementById('linked-sources') as HTMLElement;
  const linkedBeat = document.getElementById('linked-beat') as HTMLElement;
  const linkedOutbox = document.getElementById('linked-outbox') as HTMLElement;

  const toBackground = (message: Record<string, unknown>) =>
    new Promise<any>((resolve) => chrome.runtime.sendMessage(message, (r) => resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : r)));

  let linkedMount: { update(next: Record<string, unknown>): void } | undefined;

  async function drawLinked() {
    const [st, out] = await Promise.all([toBackground({ action: 'source.status' }), toBackground({ action: 'source.outbox' })]);
    const linked = !!st?.linked;
    linkedStatus.textContent = !linked
      ? 'Not linked.'
      : st.error
        ? `Linked, last heartbeat failed: ${st.error}`
        : st.lastAt ? `Linked. Last heartbeat ${new Date(st.lastAt).toLocaleTimeString()}.` : 'Linked.';
    linkedLink.classList.toggle('hidden', linked);
    linkedUnlink.classList.toggle('hidden', !linked);
    linkedBeat.textContent = st?.lastBeat ? JSON.stringify(JSON.parse(st.lastBeat), null, 2) : 'Nothing sent yet.';
    linkedOutbox.textContent = JSON.stringify(out?.batches ?? [], null, 2);
    if (!isAuthenticated) return;
    const { token } = await toBackground({ action: 'auth.getToken' });
    if (!token) return;
    // The shared view of every source and account. The browser source is view-only here.
    const { mountSources } = await import(/* the sources bundle, a file of this extension */ new URL('sources.js', location.href).href);
    const options = { surface: 'extension', token, apiBase: API_BASE_URL, deviceId: st?.id, theme: 'dark' };
    if (linkedMount) linkedMount.update(options);
    else linkedMount = mountSources(linkedSources, options);
  }

  linkedLink.addEventListener('click', async () => {
    linkedLink.disabled = true;
    if (!isAuthenticated) await toBackground({ action: 'auth.login' });
    const r = await toBackground({ action: 'source.link' });
    linkedLink.disabled = false;
    await checkAuth();
    await drawLinked();
    if (!r?.success) linkedStatus.textContent = r?.error ?? 'Link failed.';
  });

  linkedUnlink.addEventListener('click', async () => {
    const r = await toBackground({ action: 'source.unlink' });
    await drawLinked();
    if (!r?.success) linkedStatus.textContent = r?.error ?? 'Unlink failed.';
  });

  // --- AI Usage (Claude + Codex) — data fetched by the background context
  // where host permissions attach the live claude.ai / chatgpt.com cookies. ---
  const usageList = document.getElementById('usage-list');
  const usageRefresh = document.getElementById('usage-refresh');

  interface UsageWindow { usedPercent: number; resetsAt?: string }
  interface UsageSnapshotLite {
    primary?: UsageWindow;
    secondary?: UsageWindow;
    identity?: { plan?: string };
  }
  interface ProviderUsageLite {
    providerId: string;
    displayName: string;
    color?: string;
    snapshot?: UsageSnapshotLite;
    error?: string;
  }

  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }) as Record<string, string>)[c]);

  function resetLabel(iso?: string): string {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'resets now';
    const m = Math.round(ms / 60000);
    if (m < 60) return `resets in ${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `resets in ${h}h`;
    return `resets in ${Math.round(h / 24)}d`;
  }

  function lane(label: string, w: UsageWindow | undefined, color?: string): string {
    if (!w || typeof w.usedPercent !== 'number') return '';
    const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
    return `
      <div class="usage-lane" style="display:flex;align-items:center;gap:8px;font-size:11px;margin-top:4px;">
        <span style="width:52px;color:var(--text-muted,#888);">${label}</span>
        <span style="flex:1;height:6px;border-radius:3px;background:var(--surface-2,#222);overflow:hidden;">
          <span style="display:block;height:100%;width:${pct}%;background:${color || 'var(--accent,#d97757)'};"></span>
        </span>
        <span style="width:34px;text-align:right;">${pct}%</span>
      </div>`;
  }

  function renderUsage(providers: ProviderUsageLite[]) {
    if (!usageList) return;
    usageList.innerHTML = providers
      .map((p) => {
        const body = p.error
          ? `<div style="font-size:11px;color:var(--text-muted,#888);margin-top:4px;">${esc(p.error)}</div>`
          : `${lane('Session', p.snapshot?.primary, p.color)}${lane('Weekly', p.snapshot?.secondary, p.color)}
             <div style="font-size:10px;color:var(--text-muted,#888);margin-top:3px;">${esc(resetLabel(p.snapshot?.primary?.resetsAt))}</div>`;
        const plan = p.snapshot?.identity?.plan;
        return `
          <div class="usage-row" style="padding:8px;border:1px solid var(--border,#2a2a2a);border-radius:8px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="width:8px;height:8px;border-radius:50%;background:${p.color || '#888'};"></span>
              <strong style="font-size:12px;">${esc(p.displayName)}</strong>
              ${plan ? `<span style="font-size:10px;color:var(--text-muted,#888);">${esc(plan)}</span>` : ''}
            </div>
            ${body}
          </div>`;
      })
      .join('');
  }

  function loadUsage() {
    if (!usageList) return;
    usageList.innerHTML = '<div style="font-size:11px;color:var(--text-muted,#888);">Loading…</div>';
    chrome.runtime.sendMessage({ action: 'usage.fetch' }, (resp) => {
      if (chrome.runtime.lastError || !resp?.success) {
        usageList.innerHTML = '<div style="font-size:11px;color:var(--text-muted,#888);">Usage unavailable</div>';
        return;
      }
      renderUsage(resp.providers as ProviderUsageLite[]);
    });
  }

  function refreshConnectedAccounts() {
    // 1. ChatGPT Web session
    chrome.runtime.sendMessage({ action: 'chatgpt.session' }, (resp) => {
      if (chrome.runtime.lastError) return;
      const label = document.getElementById('chatgpt-user-label');
      const badge = document.getElementById('chatgpt-plan-badge');
      if (resp?.success && resp.session?.authenticated) {
        const user = resp.session.user?.name || resp.session.user?.email || 'Logged in';
        const plan = (resp.session.plan_type || 'plus').toUpperCase();
        if (label) label.textContent = `${user} · Active Web Session`;
        if (badge) badge.textContent = plan;
      } else {
        if (label) label.textContent = 'Not logged in (open chatgpt.com)';
        if (badge) badge.textContent = 'OFFLINE';
      }
    });

    // 2. Discover local nodes
    chrome.runtime.sendMessage({ action: 'local.discover' }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp?.success && resp.instances) {
        const spark = resp.instances.find((i: any) => i.id === 'hanzo-spark' || i.url?.includes('10.0.0.19'));
        const evo = resp.instances.find((i: any) => i.id === 'hanzo-evo' || i.url?.includes('10.0.0.21'));
        const desktop = resp.instances.find((i: any) => i.id === 'desktop' || i.url?.includes('11435'));

        const sparkDot = document.querySelector('#node-spark .node-dot');
        const evoDot = document.querySelector('#node-evo .node-dot');
        const deskDot = document.querySelector('#node-desktop .node-dot');

        if (sparkDot) sparkDot.classList.toggle('live', spark?.status === 'online');
        if (evoDot) evoDot.classList.toggle('live', evo?.status === 'online');
        if (deskDot) deskDot.classList.toggle('live', desktop?.status === 'online');
      }
    });
  }

  usageRefresh?.addEventListener('click', () => {
    loadUsage();
    refreshConnectedAccounts();
  });

  // Init
  checkAuth();
});
