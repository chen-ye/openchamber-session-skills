import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import {
  OPENCHAMBER_SDK_API_VERSION,
  OPENCHAMBER_SDK_CHANNEL,
  type HostTheme,
} from '@openchamber/sdk';
import { GUEST_UI_LOOK_CSS } from '@openchamber/sdk/ui';
import { startServer } from '../service/main.ts';

const EXTENSION_ROOT = path.resolve(import.meta.dir, '..');
const SCREENSHOT_DIR = '/tmp/opencode';

const DARK_THEME: HostTheme = {
  mode: 'dark',
  tokens: {
    background: '#16181d',
    elevated: '#1e2128',
    elevatedForeground: '#ebedf2',
    mutedSurface: '#121418',
    foreground: '#e6e9ef',
    muted: '#8f96a6',
    subtle: '#687082',
    border: 'rgba(255, 255, 255, 0.11)',
    hover: 'rgba(255, 255, 255, 0.06)',
    active: 'rgba(255, 255, 255, 0.1)',
    selection: 'rgba(91, 145, 255, 0.2)',
    selectionForeground: '#f0f4ff',
    focus: '#5b91ff',
    primary: '#5b91ff',
    primaryForeground: '#ffffff',
    primaryText: '#7aa7ff',
    success: '#2fb375',
    successText: '#56d196',
    warning: '#e59934',
    warningText: '#f2b35c',
    error: '#e55353',
    errorText: '#f47c7c',
    info: '#4c9aff',
    infoText: '#7ab6ff',
    font: 'Inter, system-ui, -apple-system, sans-serif',
    mono: 'JetBrains Mono, ui-monospace, SFMono-Regular, monospace',
    radius: '8px',
  },
};

const LIGHT_THEME: HostTheme = {
  mode: 'light',
  tokens: {
    background: '#f5f6f8',
    elevated: '#ffffff',
    elevatedForeground: '#181a1f',
    mutedSurface: '#eceef2',
    foreground: '#1c1f26',
    muted: '#636b78',
    subtle: '#858d9c',
    border: 'rgba(15, 23, 42, 0.12)',
    hover: 'rgba(15, 23, 42, 0.05)',
    active: 'rgba(15, 23, 42, 0.09)',
    selection: 'rgba(37, 99, 235, 0.14)',
    selectionForeground: '#1e3a8a',
    focus: '#2563eb',
    primary: '#2563eb',
    primaryForeground: '#ffffff',
    primaryText: '#1d4ed8',
    success: '#16a34a',
    successText: '#15803d',
    warning: '#d97706',
    warningText: '#b45309',
    error: '#dc2626',
    errorText: '#b91c1c',
    info: '#2563eb',
    infoText: '#1d4ed8',
    font: 'Inter, system-ui, -apple-system, sans-serif',
    mono: 'JetBrains Mono, ui-monospace, SFMono-Regular, monospace',
    radius: '8px',
  },
};

const listenEphemeral = (server: http.Server): Promise<number> => (
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  })
);

const buildHostHtml = (): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Work Status Harness</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      font-family: Inter, system-ui, -apple-system, sans-serif;
      background: var(--host-chat-bg, #0f1115);
      color: var(--host-fg, #e6e9ef);
    }
    .workspace {
      display: flex;
      width: 100%;
      height: 100%;
      position: relative;
    }
    .chat-pane {
      flex: 1 1 auto;
      padding: 28px 32px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .chat-bubble {
      max-width: 420px;
      padding: 12px 14px;
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.45;
      background: var(--host-panel-bg, #16181d);
      border: 1px solid var(--host-border, rgba(255,255,255,0.1));
    }
    .work-status-rail {
      width: 300px;
      flex-shrink: 0;
      background: var(--host-panel-bg, #16181d);
      border-left: 1px solid var(--host-border, rgba(255,255,255,0.1));
      padding: 12px 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ws-section {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ws-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .ws-spark {
      width: 14px;
      height: 14px;
      color: var(--host-accent, #5b91ff);
    }
    .ws-body {
      margin: 0 4px;
      overflow: hidden;
      border-radius: 6px;
      height: 28px;
    }
    iframe.guest-frame {
      width: 100%;
      height: 100%;
      border: 0;
      background: transparent;
      display: block;
    }
    .popover-portal {
      position: fixed;
      z-index: 100;
      border-radius: 8px;
      overflow: hidden;
      background: var(--host-elevated, #1e2128);
      border: 1px solid var(--host-border, rgba(255,255,255,0.12));
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36);
    }
    .popover-portal[hidden] {
      display: none !important;
    }
  </style>
</head>
<body>
  <div class="workspace">
    <div class="chat-pane">
      <div class="chat-bubble">
        <strong>$openchamber-extensions</strong> make me an extension that shows skills activated in the session
      </div>
    </div>
    <aside class="work-status-rail">
      <section class="ws-section">
        <div class="ws-header">
          <svg class="ws-spark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2L14.6 9.4L22 12L14.6 14.6L12 22L9.4 14.6L2 12L9.4 9.4L12 2Z" />
          </svg>
          <span>Session Skills</span>
        </div>
        <div id="status-box" class="ws-body">
          <iframe id="status-frame" class="guest-frame" sandbox="allow-scripts" src="/guest/status/index.html"></iframe>
        </div>
      </section>
    </aside>
    <div id="popover-box" class="popover-portal" hidden></div>
  </div>
  <script>
    const CHANNEL = ${JSON.stringify(OPENCHAMBER_SDK_CHANNEL)};
    const VERSION = ${JSON.stringify(OPENCHAMBER_SDK_API_VERSION)};

    window.__hostRecorded = {
      composed: [],
      clipboard: [],
      toasts: [],
      popoverOpens: 0,
      resizes: [],
    };

    let currentTheme = ${JSON.stringify(DARK_THEME)};
    let currentSession = { id: 'ses_active_1', title: 'Build extension', busy: false, agent: 'orchestrator' };
    let activePopover = null;

    const applyHostChromeTheme = (theme) => {
      document.documentElement.style.colorScheme = theme.mode;
      const s = document.documentElement.style;
      s.setProperty('--host-chat-bg', theme.mode === 'dark' ? '#0f1115' : '#ffffff');
      s.setProperty('--host-panel-bg', theme.tokens.background);
      s.setProperty('--host-elevated', theme.tokens.elevated);
      s.setProperty('--host-fg', theme.tokens.foreground);
      s.setProperty('--host-border', theme.tokens.border);
      s.setProperty('--host-accent', theme.tokens.primary);
    };
    applyHostChromeTheme(currentTheme);

    const statusBox = document.getElementById('status-box');
    const statusFrame = document.getElementById('status-frame');
    const popoverBox = document.getElementById('popover-box');

    const postToWindow = (win, msg) => {
      if (win) win.postMessage({ channel: CHANNEL, v: VERSION, ...msg }, '*');
    };

    const makeReadyPayload = (surface, popover) => ({
      theme: currentTheme,
      locale: 'en',
      directory: '/home/alice/Projects/app',
      session: currentSession,
      surface,
      connection: { connected: false, account: '' },
      settings: {},
      item: null,
      features: { popovers: true, statusControls: true },
      ...(popover ? { popover } : {}),
    });

    const closeActivePopover = (reason = 'closed') => {
      if (!activePopover) return;
      const closingId = activePopover.id;
      activePopover = null;
      popoverBox.hidden = true;
      popoverBox.replaceChildren();
      postToWindow(statusFrame.contentWindow, {
        type: 'popover-closed',
        payload: { id: closingId, reason },
      });
    };

    window.addEventListener('message', async (event) => {
      const data = event.data;
      if (!data || data.channel !== CHANNEL || data.v !== VERSION) return;

      const isStatus = event.source === statusFrame.contentWindow;
      const isPopover = activePopover && event.source === activePopover.frame.contentWindow;
      if (!isStatus && !isPopover) return;

      if (data.type === 'hello') {
        if (isStatus) {
          postToWindow(event.source, { type: 'ready', payload: makeReadyPayload('status') });
        } else if (isPopover) {
          postToWindow(event.source, {
            type: 'ready',
            payload: makeReadyPayload('popover', { id: activePopover.id, data: activePopover.data }),
          });
        }
        return;
      }

      if (data.type === 'resize') {
        const rawH = Number(data.payload?.height) || 28;
        if (isStatus) {
          const clamped = Math.max(24, Math.min(320, Math.ceil(rawH)));
          statusBox.style.height = clamped + 'px';
          window.__hostRecorded.resizes.push({ surface: 'status', height: clamped });
        } else if (isPopover) {
          const clamped = Math.max(48, Math.min(480, Math.ceil(rawH) + 2));
          popoverBox.style.height = clamped + 'px';
          window.__hostRecorded.resizes.push({ surface: 'popover', height: clamped });
        }
        postToWindow(event.source, { type: 'result', id: data.id, ok: true });
        return;
      }

      if (data.type === 'service-request') {
        const req = data.payload;
        const qs = req.query ? '?' + new URLSearchParams(req.query).toString() : '';
        const res = await fetch('/proxy' + req.path + qs, {
          method: req.method,
          body: req.body,
        });
        const body = await res.text();
        postToWindow(event.source, {
          type: 'result',
          id: data.id,
          ok: true,
          payload: { status: res.status, body },
        });
        return;
      }

      if (data.type === 'popover-open' && isStatus) {
        const p = data.payload;
        closeActivePopover('replaced');
        window.__hostRecorded.popoverOpens += 1;

        const statusRect = statusFrame.getBoundingClientRect();
        const left = Math.max(12, statusRect.left + p.anchor.x - p.width - 10);
        const top = Math.max(12, statusRect.top + p.anchor.y - 8);

        popoverBox.style.width = p.width + 'px';
        popoverBox.style.height = p.height + 'px';
        popoverBox.style.left = left + 'px';
        popoverBox.style.top = top + 'px';

        const popFrame = document.createElement('iframe');
        popFrame.id = 'popover-frame';
        popFrame.className = 'guest-frame';
        popFrame.setAttribute('sandbox', 'allow-scripts');
        popFrame.src = '/guest/status/index.html';
        popoverBox.replaceChildren(popFrame);
        popoverBox.hidden = false;

        activePopover = { id: p.id, data: p.data, frame: popFrame };
        postToWindow(event.source, { type: 'result', id: data.id, ok: true });
        return;
      }

      if (data.type === 'popover-close' && isStatus) {
        if (activePopover && activePopover.id === data.payload?.id) {
          closeActivePopover(data.payload?.reason || 'closed');
        }
        postToWindow(event.source, { type: 'result', id: data.id, ok: true });
        return;
      }

      if (data.type === 'popover-anchor') {
        postToWindow(event.source, { type: 'result', id: data.id, ok: true });
        return;
      }

      if (data.type === 'status-controls' || data.type === 'open-surface') {
        postToWindow(event.source, { type: 'result', id: data.id, ok: true });
        return;
      }

      if (data.type === 'compose') {
        window.__hostRecorded.composed.push(data.payload);
        postToWindow(event.source, { type: 'result', id: data.id, ok: true });
        return;
      }

      if (data.type === 'clipboard-write') {
        window.__hostRecorded.clipboard.push(data.payload.text);
        postToWindow(event.source, { type: 'result', id: data.id, ok: true });
        return;
      }

      if (data.type === 'toast') {
        window.__hostRecorded.toasts.push(data.payload);
        postToWindow(event.source, { type: 'result', id: data.id, ok: true });
        return;
      }

      if (data.type === 'close') {
        if (isPopover) closeActivePopover('closed');
        postToWindow(event.source, { type: 'result', id: data.id, ok: true });
        return;
      }
    });

    window.__pushSession = (session) => {
      currentSession = session;
      closeActivePopover('owner');
      postToWindow(statusFrame.contentWindow, {
        type: 'session',
        payload: { session },
      });
    };

    window.__pushTheme = (theme) => {
      currentTheme = theme;
      applyHostChromeTheme(theme);
      postToWindow(statusFrame.contentWindow, {
        type: 'ready',
        payload: makeReadyPayload('status'),
      });
      if (activePopover) {
        postToWindow(activePopover.frame.contentWindow, {
          type: 'ready',
          payload: makeReadyPayload('popover', { id: activePopover.id, data: activePopover.data }),
        });
      }
    };

    window.__pushServiceEvent = (topic, data) => {
      postToWindow(statusFrame.contentWindow, {
        type: 'service-event',
        payload: { topic, data },
      });
    };
  </script>
</body>
</html>`;

describe('Work Status + Collapsible Subagent + Context-Bar Browser Verification (Playwright)', () => {
  test('renders context bars, turn ages, collapsible subagent group, popovers, and live updates with zero errors', async () => {
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

    const statusHtmlRaw = await fs.readFile(path.join(EXTENSION_ROOT, 'status/index.html'), 'utf8');
    const statusHtmlWithLook = statusHtmlRaw.replace(
      '</head>',
      `<style data-openchamber-guest-styles>${GUEST_UI_LOOK_CSS}</style></head>`,
    );
    const statusJsRaw = await fs.readFile(path.join(EXTENSION_ROOT, 'status/main.js'), 'utf8');

    const sseHolder: { res: http.ServerResponse | null } = { res: null };

    // 4-turn realistic history:
    // Turn 0 (compacted): brainstorming (3t)
    // Turn 1: $openchamber-extensions at 36k / 241k (2t, deep amber)
    // Turn 2: subagent explore spawned (1t)
    // Turn 3 (current): principle-prove-it-works at tip 241k (now, fresh green)
    const activeSessionMessages: unknown[] = [
      {
        id: 'msg_t0_u',
        type: 'user',
        time: { created: 500 },
        text: '$brainstorming explore approaches',
        skills: [
          {
            id: 'brainstorming',
            name: 'brainstorming',
            text: '<skill_content name="brainstorming">\n# Skill: brainstorming\n\nExplore options before building.\n</skill_content>',
          },
        ],
      },
      {
        id: 'msg_t0_a',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 600, completed: 650 },
        tokens: { input: 680_000, output: 1_200, reasoning: 0, cache: { read: 0, write: 0 } },
        content: [],
      },
      { id: 'msg_t0_idle', type: 'idle', time: { created: 700 } },
      {
        id: 'msg_compact',
        type: 'compaction',
        status: 'completed',
        reason: 'auto',
        summary: 'Checkpoint summary',
        time: { created: 800 },
      },
      {
        id: 'msg_t1_u',
        type: 'user',
        time: { created: 1_000 },
        text: '$openchamber-extensions make me an extension',
        skills: [
          {
            id: 'openchamber-extensions',
            name: 'openchamber-extensions',
            text: `<skill_content name="openchamber-extensions">
# Skill: openchamber-extensions

An extension is a folder with a \`package.json\` that has an \`openchamber\` block. The app draws most of it from that block, and your code runs in sandboxed frames and an optional Node service.

## Steps

1. Design where it lives in Work Status, mentions, or actions.
2. Bundle with \`openchamber-guest-bundle\` and check with \`openchamber-guest-check\`.

Base directory for this skill: /home/alice/.config/opencode/skills/openchamber-extensions
</skill_content>`,
          },
        ],
      },
      {
        id: 'msg_t1_a',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 1_200, completed: 1_300 },
        tokens: { input: 35_500, output: 500, reasoning: 200, cache: { read: 0, write: 0 } },
        content: [],
      },
      { id: 'msg_t1_idle', type: 'idle', time: { created: 1_400 } },
      {
        id: 'msg_t2_u',
        type: 'user',
        time: { created: 2_000 },
        text: 'inspect opencode schemas',
      },
      {
        id: 'msg_t2_a',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 2_100, completed: 2_500 },
        tokens: { input: 64_000, output: 800, reasoning: 200, cache: { read: 36_000, write: 0 } },
        content: [
          {
            type: 'tool',
            id: 'call_sub_1',
            name: 'subagent',
            state: {
              status: 'completed',
              input: {
                agent: 'explore',
                skills: ['investigate-opencode'],
              },
              metadata: {
                sessionID: 'ses_child_explore',
              },
            },
            time: { created: 2_150, completed: 2_450 },
          },
        ],
      },
      { id: 'msg_t2_idle', type: 'idle', time: { created: 2_600 } },
      {
        id: 'msg_t3_u',
        type: 'user',
        time: { created: 3_000 },
        text: 'prove it works',
      },
      {
        id: 'msg_t3_a1',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 3_100, completed: 3_150 },
        tokens: { input: 118_000, output: 400, reasoning: 200, cache: { read: 100_800, write: 0 } },
        content: [
          {
            type: 'tool',
            id: 'call_1',
            name: 'skill',
            state: {
              status: 'completed',
              input: { id: 'principle-prove-it-works' },
              metadata: {
                name: 'principle-prove-it-works',
                directory: '/home/alice/.config/opencode/skills/principle-prove-it-works',
              },
              content: [
                {
                  type: 'text',
                  text: '<skill_content name="principle-prove-it-works">\n# Skill: principle-prove-it-works\n\nVerify against the real artifact, not a proxy.\n</skill_content>',
                },
              ],
            },
            time: { created: 3_120, completed: 3_130 },
          },
        ],
      },
      {
        id: 'msg_t3_a2',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 3_200, completed: 3_250 },
        tokens: { input: 21_500, output: 600, reasoning: 150, cache: { read: 219_200, write: 0 } },
        content: [],
      },
    ];

    const childExploreMessages: unknown[] = [
      {
        id: 'msg_c1',
        type: 'user',
        time: { created: 2_160 },
        text: `[SKILL: investigate-opencode]
---
name: investigate-opencode
description: Analyze OpenCode internals, tools, and schema contracts.
---
# Investigate OpenCode

Inspect local clones first.

1. TASK
Check message schemas.`,
      },
      {
        id: 'msg_ca1',
        type: 'assistant',
        agent: 'explore',
        time: { created: 2_200, completed: 2_250 },
        tokens: { input: 29_500, output: 300, reasoning: 100, cache: { read: 0, write: 0 } },
        content: [],
      },
      {
        id: 'msg_ca2',
        type: 'assistant',
        agent: 'explore',
        time: { created: 2_300, completed: 2_420 },
        tokens: { input: 53_600, output: 500, reasoning: 100, cache: { read: 29_800, write: 0 } },
        content: [],
      },
    ];

    let pushBridge: ((topic: string, data: unknown) => void) | null = null;

    const mockOpenCode = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname === '/api/event') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': ok\n\n');
        sseHolder.res = res;
        return;
      }
      if (u.pathname === '/api/session/ses_active_1') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ data: { id: 'ses_active_1', parentID: null, agent: 'orchestrator' } }),
        );
        return;
      }
      if (u.pathname === '/api/session/ses_child_explore') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ data: { id: 'ses_child_explore', parentID: 'ses_active_1', agent: 'explore' } }),
        );
        return;
      }
      if (u.pathname === '/api/session/ses_empty_2') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ data: { id: 'ses_empty_2', parentID: null, agent: 'orchestrator' } }),
        );
        return;
      }
      if (u.pathname === '/api/session') {
        const parent = u.searchParams.get('parentID');
        const data = parent === 'ses_active_1'
          ? [{ id: 'ses_child_explore', parentID: 'ses_active_1', agent: 'explore' }]
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ data, cursor: { next: null } }),
        );
        return;
      }
      if (u.pathname === '/api/session/ses_active_1/message') {
        const ordered = u.searchParams.get('order') === 'desc'
          ? [...activeSessionMessages].reverse()
          : activeSessionMessages;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ data: ordered, cursor: { next: null } }),
        );
        return;
      }
      if (u.pathname === '/api/session/ses_child_explore/message') {
        const ordered = u.searchParams.get('order') === 'desc'
          ? [...childExploreMessages].reverse()
          : childExploreMessages;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ data: ordered, cursor: { next: null } }),
        );
        return;
      }
      if (u.pathname === '/api/session/ses_empty_2/message') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ data: [], cursor: { next: null } }),
        );
        return;
      }
      res.writeHead(404).end('{}');
    });

    const mockCallback = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        if (parsed.method === 'panels.emit' && pushBridge) {
          pushBridge(parsed.input.topic, parsed.input.data);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: {} }));
      });
    });

    const [opencodePort, callbackPort] = await Promise.all([
      listenEphemeral(mockOpenCode),
      listenEphemeral(mockCallback),
    ]);

    const probe = http.createServer();
    const servicePort = await listenEphemeral(probe);
    await new Promise<void>((r) => probe.close(() => r()));

    const token = 'playwright-token';
    const service = startServer({
      port: servicePort,
      token,
      opencodeUrl: `http://127.0.0.1:${opencodePort}`,
      homeDir: '/home/alice',
      env: {
        OPENCHAMBER_SERVICE_PORT: String(servicePort),
        OPENCHAMBER_SERVICE_TOKEN: token,
        OPENCHAMBER_OPENCODE_URL: `http://127.0.0.1:${opencodePort}`,
        OPENCHAMBER_HOST_CALLBACK_URL: `http://127.0.0.1:${callbackPort}`,
      },
    })!;

    const harnessServer = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(buildHostHtml());
        return;
      }
      if (u.pathname === '/guest/status/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(statusHtmlWithLook);
        return;
      }
      if (u.pathname === '/guest/status/main.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }).end(statusJsRaw);
        return;
      }
      if (u.pathname.startsWith('/proxy/')) {
        const subPath = u.pathname.slice('/proxy'.length) + u.search;
        const upstream = await fetch(`http://127.0.0.1:${servicePort}${subPath}`, {
          method: req.method,
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(text);
        return;
      }
      res.writeHead(404).end('Not found');
    });

    const harnessPort = await listenEphemeral(harnessServer);
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width: 840, height: 500 } });
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      page.on('pageerror', (err) => {
        errors.push(err.message);
      });

      pushBridge = (topic, data) => {
        void page.evaluate(
          ([t, d]) => {
            (window as unknown as { __pushServiceEvent: (t: string, d: unknown) => void }).__pushServiceEvent(t, d);
          },
          [topic, data] as const,
        );
      };

      await page.goto(`http://127.0.0.1:${harnessPort}/`, { waitUntil: 'networkidle' });

      const statusFrame = page.frameLocator('#status-frame');
      await statusFrame.locator('.ss-row').first().waitFor({ state: 'visible', timeout: 5_000 });

      // Main session skills group
      const sessionNames = await statusFrame.locator('[data-group="session"] .ss-name').allTextContents();
      expect(sessionNames).toEqual([
        'brainstorming',
        'openchamber-extensions',
        'principle-prove-it-works',
      ]);

      const sessionAges = await statusFrame.locator('[data-group="session"] .ss-age').allTextContents();
      expect(sessionAges).toEqual(['3t', '2t', 'now']);

      // Subagent collapsible header + subagent skill row
      const subToggle = statusFrame.locator('.ss-subagent-toggle');
      expect(await subToggle.locator('.ss-subagent-label').textContent()).toBe('Subagent · explore');
      expect(await subToggle.getAttribute('aria-expanded')).toBe('true');

      const subNames = await statusFrame.locator('[data-group="subagent"] .ss-name').allTextContents();
      expect(subNames).toEqual(['investigate-opencode']);
      expect(await statusFrame.locator('[data-group="subagent"] .ss-age').allTextContents()).toEqual(['1t']);

      // Hover `openchamber-extensions` to verify deep-context popover in Dark Mode
      await statusFrame.locator('.ss-row[data-skill-id="openchamber-extensions"]').hover();
      await page.locator('#popover-box:not([hidden])').waitFor({ state: 'visible', timeout: 3_000 });

      const popFrame = page.frameLocator('#popover-frame');
      await popFrame.locator('.ss-pop-title').waitFor({ state: 'visible', timeout: 3_000 });
      expect(await popFrame.locator('.ss-pop-title').textContent()).toBe('openchamber-extensions');
      expect(await popFrame.locator('.ss-pop-depth-primary').textContent()).toContain('2 turns ago');
      expect(await popFrame.locator('.ss-pop-depth-primary').textContent()).toContain('205k tok deep');

      await page.waitForTimeout(120);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'session-skills-dark.png') });

      // Test collapsing & re-expanding the Subagent group!
      const expandedBoxHeight = await page.locator('#status-box').evaluate((el) => el.getBoundingClientRect().height);
      await subToggle.click();
      expect(await subToggle.getAttribute('aria-expanded')).toBe('false');
      expect(await statusFrame.locator('[data-group="subagent"]').count()).toBe(0);
      await page.waitForTimeout(80);
      const collapsedBoxHeight = await page.locator('#status-box').evaluate((el) => el.getBoundingClientRect().height);
      expect(collapsedBoxHeight).toBeLessThan(expandedBoxHeight);

      // Re-expand subagents, switch to light mode, and inspect subagent skill popover
      await subToggle.click();
      expect(await subToggle.getAttribute('aria-expanded')).toBe('true');

      await page.mouse.move(10, 10);
      await page.evaluate((light) => {
        (window as unknown as { __pushTheme: (t: unknown) => void }).__pushTheme(light);
      }, LIGHT_THEME);
      await statusFrame.locator('.ss-row[data-skill-id="investigate-opencode"]').hover();
      await page.locator('#popover-box:not([hidden])').waitFor({ state: 'visible', timeout: 3_000 });
      await popFrame.locator('.ss-pop-title', { hasText: 'investigate-opencode' }).waitFor({ state: 'visible', timeout: 3_000 });
      await page.waitForTimeout(120);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'session-skills-light.png') });

      // Verify Copy path & Insert in chat buttons
      await statusFrame.locator('.ss-row[data-skill-id="openchamber-extensions"]').hover();
      await popFrame.locator('.ss-pop-title', { hasText: 'openchamber-extensions' }).waitFor({ state: 'visible', timeout: 3_000 });
      await popFrame.getByRole('button', { name: 'Copy path' }).click();
      await popFrame.getByRole('button', { name: 'Insert in chat' }).click();
      await page.locator('#popover-box[hidden]').waitFor({ state: 'attached', timeout: 3_000 });

      const recorded = await page.evaluate(() => (
        (window as unknown as {
          __hostRecorded: {
            composed: Array<{ text: string; mode?: string }>;
            clipboard: string[];
          };
        }).__hostRecorded
      ));
      expect(recorded.clipboard).toEqual([
        '/home/alice/.config/opencode/skills/openchamber-extensions/SKILL.md',
      ]);
      expect(recorded.composed).toEqual([
        { text: '$openchamber-extensions ', mode: 'append' },
      ]);

      // Switch to an empty session -> updates cleanly
      await page.evaluate(() => {
        (window as unknown as { __pushSession: (s: unknown) => void }).__pushSession({
          id: 'ses_empty_2',
          title: 'Second session',
          busy: false,
        });
      });
      await statusFrame.locator('.ss-note').waitFor({ state: 'visible', timeout: 3_000 });
      expect(await statusFrame.locator('.ss-note').textContent()).toBe(
        'No skills activated in this session',
      );

      // Live SSE push into ses_empty_2 shows `now`
      sseHolder.res!.write(`data: ${JSON.stringify({
        id: 'evt_live_empty',
        type: 'session.inbox.enqueued',
        created: 9_000,
        data: {
          sessionID: 'ses_empty_2',
          inboxID: 'msg_live_1',
          item: {
            type: 'user',
            payload: {
              text: '$brainstorming plan this',
              skills: [{ id: 'brainstorming', name: 'brainstorming', text: '<skill_content name="brainstorming">\n# Skill: brainstorming\n\nExplore ideas.\n</skill_content>' }],
            },
          },
        },
      })}\n\n`);

      await statusFrame.locator('.ss-row[data-skill-id="brainstorming"]').waitFor({
        state: 'visible',
        timeout: 3_000,
      });
      expect(await statusFrame.locator('.ss-age').allTextContents()).toEqual(['now']);

      expect(errors).toEqual([]);
    } finally {
      sseHolder.res?.end();
      await browser.close();
      await service.close();
      await new Promise<void>((r) => harnessServer.close(() => r()));
      await new Promise<void>((r) => mockOpenCode.close(() => r()));
      await new Promise<void>((r) => mockCallback.close(() => r()));
    }
  }, 25_000);
});

describe('Skill Usage Heatmap Page Browser Verification (Playwright)', () => {
  test('renders active and zero-activation skills across desktop dark and mobile light viewports', async () => {
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-skills-page-ui-'));
    const homeDir = path.join(tmpDir, 'home');
    const skillsRoot = path.join(homeDir, '.config', 'opencode', 'skills');
    const dbPath = path.join(tmpDir, 'opencode.db');
    const dataDir = path.join(tmpDir, 'service-data');

    const writeSkill = async (id: string, desc: string) => {
      const dir = path.join(skillsRoot, id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${id}\ndescription: ${desc}\n---\n# ${id}\n`,
        'utf8',
      );
    };
    await writeSkill('jira-cli', 'Query and triage Jira tickets.');
    await writeSkill('impeccable', 'Refine typography and visual hierarchy.');
    await writeSkill('dormant-check', 'Zero-activation verification skill.');
    await writeSkill('dormant-unused', 'Another dormant skill with 0 uses.');

    const lockDir = path.join(homeDir, '.agents');
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          'jira-cli': {
            source: path.join(homeDir, 'Projects', 'reliaskills'),
            sourceType: 'local',
            sourceUrl: path.join(homeDir, 'Projects', 'reliaskills'),
          },
          impeccable: {
            source: 'pbakaus/impeccable',
            sourceType: 'github',
            sourceUrl: 'https://github.com/pbakaus/impeccable.git',
          },
          'dormant-check': {
            source: 'vercel-labs/skills',
            sourceType: 'github',
            sourceUrl: 'https://github.com/vercel-labs/skills.git',
            ref: 'main',
            skillPath: 'skills/dormant-check/SKILL.md',
          },
        },
      }),
      'utf8',
    );

    const opencodeCfgDir = path.join(homeDir, '.config', 'opencode');
    await fs.mkdir(opencodeCfgDir, { recursive: true });
    await fs.writeFile(
      path.join(opencodeCfgDir, 'opencode.jsonc'),
      JSON.stringify({
        policies: [
          { action: 'skill.use', resource: 'impeccable', effect: 'allow' },
          { action: 'skill.use', resource: 'dormant-unused', effect: 'deny' },
          { action: 'skill.use', resource: 'wrangler', effect: 'deny' },
        ],
      }),
      'utf8',
    );

    const now = Date.now();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        directory TEXT NOT NULL,
        agent TEXT,
        title TEXT,
        time_created INTEGER NOT NULL
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX session_message_time_created_idx ON session_message(time_created);
    `);
    const insSess = db.prepare(
      'INSERT INTO session_v2 (id, parent_id, directory, agent, title, time_created) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insMsg = db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insSess.run('ses_page_1', null, '/home/alice/Projects/app', 'orchestrator', 'Main', now - 86_400_000 * 14);
    insSess.run('ses_page_2', null, '/home/alice/Projects/other', 'orchestrator', 'Other', now - 86_400_000 * 2);

    insMsg.run('m1', 'ses_page_1', 'user', 1, now - 86_400_000 * 14 + 100, JSON.stringify({
      time: { created: now - 86_400_000 * 14 + 100 },
      text: '$impeccable audit UI',
      skills: [{ id: 'impeccable', name: 'impeccable', text: '<skill_content name="impeccable">hi</skill_content>' }],
    }));
    insMsg.run('m2', 'ses_page_2', 'assistant', 1, now - 86_400_000 * 2 + 100, JSON.stringify({
      agent: 'orchestrator',
      content: [{
        type: 'tool',
        id: 'c1',
        name: 'skill',
        state: { status: 'completed', input: { id: 'jira-cli' } },
        time: { created: now - 86_400_000 * 2 + 100, completed: now - 86_400_000 * 2 + 120 },
      }],
    }));
    insMsg.run('m3', 'ses_page_2', 'assistant', 2, now - 86_400_000 * 2 + 200, JSON.stringify({
      agent: 'orchestrator',
      content: [{
        type: 'tool',
        id: 'c2',
        name: 'skill',
        state: { status: 'completed', input: { id: 'jira-cli' } },
        time: { created: now - 86_400_000 * 2 + 200, completed: now - 86_400_000 * 2 + 220 },
      }],
    }));

    const pageHtmlRaw = await fs.readFile(path.join(EXTENSION_ROOT, 'page/index.html'), 'utf8');
    const pageHtmlWithLook = pageHtmlRaw.replace(
      '</head>',
      `<style data-openchamber-guest-styles>${GUEST_UI_LOOK_CSS}</style></head>`,
    );
    const pageJsRaw = await fs.readFile(path.join(EXTENSION_ROOT, 'page/main.js'), 'utf8');

    const probe = http.createServer();
    const servicePort = await listenEphemeral(probe);
    await new Promise<void>((r) => probe.close(() => r()));

    const token = 'pw-page-token';
    const service = startServer({
      port: servicePort,
      token,
      homeDir,
      dbPath,
      dataDir,
      env: { OPENCHAMBER_SERVICE_PORT: String(servicePort), OPENCHAMBER_SERVICE_TOKEN: token },
    })!;

    const hostHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Page Host</title>
<style>html, body { margin:0; padding:0; width:100%; height:100%; background:#0f1115; } iframe { width:100%; height:100%; border:0; display:block; }</style>
</head>
<body>
<iframe id="page-frame" sandbox="allow-scripts" src="/guest/page/index.html"></iframe>
<script>
const CHANNEL = ${JSON.stringify(OPENCHAMBER_SDK_CHANNEL)};
const VERSION = ${JSON.stringify(OPENCHAMBER_SDK_API_VERSION)};
const frame = document.getElementById('page-frame');
let currentTheme = ${JSON.stringify(DARK_THEME)};
window.__hostRecorded = { composed: [], toasts: [], openedUrls: [] };
const post = (msg) => frame.contentWindow.postMessage({ channel: CHANNEL, v: VERSION, ...msg }, '*');
window.addEventListener('message', async (ev) => {
  const d = ev.data;
  if (!d || d.channel !== CHANNEL || d.v !== VERSION || ev.source !== frame.contentWindow) return;
  if (d.type === 'hello') {
    post({
      type: 'ready',
      payload: {
        theme: currentTheme,
        locale: 'en',
        directory: '/home/alice/Projects/app',
        session: { id: 'ses_page_1', title: 'Main', busy: false },
        surface: 'page',
        connection: { connected: false, account: '' },
        settings: {},
        item: null,
        features: { popovers: true, statusControls: true },
      },
    });
    return;
  }
  if (d.type === 'service-request') {
    const qs = d.payload.query ? '?' + new URLSearchParams(d.payload.query).toString() : '';
    const r = await fetch('/proxy' + d.payload.path + qs, { method: d.payload.method });
    post({ type: 'result', id: d.id, ok: true, payload: { status: r.status, body: await r.text() } });
    return;
  }
  if (d.type === 'compose') {
    window.__hostRecorded.composed.push(d.payload);
    post({ type: 'result', id: d.id, ok: true });
    return;
  }
  if (d.type === 'open-url') {
    window.__hostRecorded.openedUrls.push(d.payload.url);
    post({ type: 'result', id: d.id, ok: true });
    return;
  }
  if (d.type === 'toast') {
    window.__hostRecorded.toasts.push(d.payload);
    post({ type: 'result', id: d.id, ok: true });
    return;
  }
  post({ type: 'result', id: d.id, ok: true });
});
window.__pushTheme = (t) => {
  currentTheme = t;
  document.body.style.background = t.mode === 'dark' ? '#0f1115' : '#f5f6f8';
  post({
    type: 'ready',
    payload: {
      theme: t, locale: 'en', directory: '/home/alice/Projects/app',
      session: { id: 'ses_page_1', title: 'Main', busy: false },
      surface: 'page', connection: { connected: false, account: '' }, settings: {}, item: null,
    },
  });
};
</script>
</body>
</html>`;

    const harness = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hostHtml);
        return;
      }
      if (u.pathname === '/guest/page/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pageHtmlWithLook);
        return;
      }
      if (u.pathname === '/guest/page/main.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }).end(pageJsRaw);
        return;
      }
      if (u.pathname.startsWith('/proxy/')) {
        const upstream = await fetch(`http://127.0.0.1:${servicePort}${u.pathname.slice('/proxy'.length)}${u.search}`, {
          method: req.method,
          headers: { Authorization: `Bearer ${token}` },
        });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(await upstream.text());
        return;
      }
      res.writeHead(404).end('Not found');
    });

    const harnessPort = await listenEphemeral(harness);
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      page.on('pageerror', (err) => {
        errors.push(err.message);
      });

      await page.goto(`http://127.0.0.1:${harnessPort}/`, { waitUntil: 'networkidle' });
      const frame = page.frameLocator('#page-frame');
      await frame.locator('.sh-skill-row').first().waitFor({ state: 'visible', timeout: 5_000 });

      // Both active, dormant, and policy-denied skills appear, with upstreams & skill.use policy state
      const allIds = await frame.locator('.sh-skill-row').evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-skill-id')),
      );
      expect(allIds).toEqual(['jira-cli', 'impeccable', 'dormant-check', 'dormant-unused', 'wrangler']);
      expect(await frame.locator('.sh-skill-row[data-dormant="true"]').count()).toBe(3);
      expect(await frame.locator('.sh-skill-row[data-skill-id="jira-cli"] .sh-upstream').textContent()).toBe('~/Projects/reliaskills');
      expect(await frame.locator('.sh-skill-row[data-skill-id="dormant-check"] .sh-upstream').textContent()).toBe('vercel-labs/skills');
      expect(await frame.locator('.sh-skill-row[data-skill-id="dormant-unused"] .sh-upstream').textContent()).toBe('—');
      expect(await frame.locator('.sh-skill-row[data-skill-id="impeccable"] .sh-policy-col .sh-policy-pill').textContent()).toBe('allow*');
      expect(await frame.locator('.sh-skill-row[data-skill-id="dormant-unused"] .sh-policy-col .sh-policy-pill').textContent()).toBe('deny');
      expect(await frame.locator('.sh-skill-row[data-skill-id="wrangler"] .sh-policy-col .sh-policy-pill').textContent()).toBe('deny');

      // Desktop dark screenshot & no page-level overflow
      const desktopOverflow = await frame.locator('#root').evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(desktopOverflow).toBe(false);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'session-skills-heatmap-desktop-dark.png') });

      // Click Denied by skill.use policy KPI -> filters to denied rows only and toggles back off
      await frame.locator('.sh-kpi-btn', { hasText: 'Denied by skill.use policy' }).click();
      const deniedIds = await frame.locator('.sh-skill-row').evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-skill-id')),
      );
      expect(deniedIds).toEqual(['dormant-unused', 'wrangler']);
      await frame.locator('.sh-skill-row[data-skill-id="wrangler"]').click();
      await frame.locator('.sh-inspector').waitFor({ state: 'visible', timeout: 3_000 });
      expect(await frame.locator('.sh-inspector').textContent()).toContain('OpenCode policy: skill.use "wrangler" → deny (~/.config/opencode/opencode.jsonc)');
      await frame.locator('.sh-inspector').getByRole('button', { name: 'Close' }).click();
      await frame.locator('.sh-kpi-btn', { hasText: 'Denied by skill.use policy' }).click();

      // Click Zero activations KPI -> filters down to dormant rows only
      await frame.locator('.sh-kpi-btn', { hasText: 'Zero activations' }).click();
      const dormantIds = await frame.locator('.sh-skill-row').evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-skill-id')),
      );
      expect(dormantIds).toEqual(['dormant-check', 'dormant-unused', 'wrangler']);

      // Search box retains focus across input updates and matches upstream source
      const searchInput = frame.getByPlaceholder('Filter skills by id, description, or upstream…');
      await searchInput.click();
      await searchInput.fill('vercel-labs');
      const isFocused = await searchInput.evaluate((el) => document.activeElement === el);
      expect(isFocused).toBe(true);
      expect(await frame.locator('.sh-skill-row').count()).toBe(1);

      // Click dormant-check -> inspector shows 0 activations, upstream, Insert in chat & Open upstream
      await frame.locator('.sh-skill-row[data-skill-id="dormant-check"]').click();
      await frame.locator('.sh-inspector').waitFor({ state: 'visible', timeout: 3_000 });
      expect(await frame.locator('.sh-inspector').textContent()).toContain('Upstream (github): vercel-labs/skills');
      await frame.getByRole('button', { name: 'Insert in chat' }).click();
      await frame.getByRole('button', { name: 'Open upstream' }).click();
      await page.waitForFunction(() => {
        const rec = (window as unknown as { __hostRecorded: { composed: unknown[]; openedUrls: unknown[] } }).__hostRecorded;
        return rec.composed.length > 0 && rec.openedUrls.length > 0;
      });
      const recorded = await page.evaluate(() => (
        (window as unknown as { __hostRecorded: { composed: Array<{ text: string; mode?: string }>; openedUrls: string[] } }).__hostRecorded
      ));
      expect(recorded.composed).toEqual([{ text: '$dormant-check ', mode: 'append' }]);
      expect(recorded.openedUrls).toEqual(['https://github.com/vercel-labs/skills']);

      // Clear search, switch back to All skills, switch tabs, test Mobile Light viewport
      await searchInput.fill('');
      await frame.locator('.sh-kpi-btn', { hasText: 'Zero activations' }).click();
      await frame.getByRole('tab', { name: 'Projects' }).click();
      await frame.locator('.sh-table').waitFor({ state: 'visible', timeout: 3_000 });
      await frame.getByRole('tab', { name: 'Cadence' }).click();
      await frame.locator('.sh-table').waitFor({ state: 'visible', timeout: 3_000 });
      await frame.getByRole('tab', { name: 'Timeline' }).click();

      await page.setViewportSize({ width: 360, height: 780 });
      await page.evaluate((light) => {
        (window as unknown as { __pushTheme: (t: unknown) => void }).__pushTheme(light);
      }, LIGHT_THEME);
      await page.waitForTimeout(120);
      const mobileOverflow = await frame.locator('#root').evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(mobileOverflow).toBe(false);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'session-skills-heatmap-mobile-light.png') });

      expect(errors).toEqual([]);
    } finally {
      db.close();
      await browser.close();
      await service.close();
      await new Promise<void>((r) => harness.close(() => r()));
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 25_000);

  test('scrolls within matrix while keeping selected skill details in view', async () => {
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-skills-page-scroll-'));
    const homeDir = path.join(tmpDir, 'home');
    const skillsRoot = path.join(homeDir, '.config', 'opencode', 'skills');
    const dbPath = path.join(tmpDir, 'opencode.db');
    const dataDir = path.join(tmpDir, 'service-data');

    for (let i = 1; i <= 32; i += 1) {
      const id = `skill-${String(i).padStart(2, '0')}`;
      const dir = path.join(skillsRoot, id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${id}\ndescription: Description for ${id}.\n---\n# ${id}\n`,
        'utf8',
      );
    }

    const now = Date.now();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        directory TEXT NOT NULL,
        agent TEXT,
        title TEXT,
        time_created INTEGER NOT NULL
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX session_message_time_created_idx ON session_message(time_created);
    `);
    db.prepare(
      'INSERT INTO session_v2 (id, parent_id, directory, agent, title, time_created) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('ses_scroll_1', null, '/home/alice/Projects/app', 'orchestrator', 'Main', now - 86_400_000 * 3);
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m_scroll_1', 'ses_scroll_1', 'assistant', 1, now - 86_400_000 * 2, JSON.stringify({
      agent: 'orchestrator',
      content: [{
        type: 'tool',
        id: 'c_scroll_1',
        name: 'skill',
        state: { status: 'completed', input: { id: 'skill-01' } },
        time: { created: now - 86_400_000 * 2, completed: now - 86_400_000 * 2 + 10 },
      }],
    }));

    const pageHtmlRaw = await fs.readFile(path.join(EXTENSION_ROOT, 'page/index.html'), 'utf8');
    const pageHtmlWithLook = pageHtmlRaw.replace(
      '</head>',
      `<style data-openchamber-guest-styles>${GUEST_UI_LOOK_CSS}</style></head>`,
    );
    const pageJsRaw = await fs.readFile(path.join(EXTENSION_ROOT, 'page/main.js'), 'utf8');

    const probe = http.createServer();
    const servicePort = await listenEphemeral(probe);
    await new Promise<void>((r) => probe.close(() => r()));

    const token = 'pw-scroll-token';
    const service = startServer({
      port: servicePort,
      token,
      homeDir,
      dbPath,
      dataDir,
      env: { OPENCHAMBER_SERVICE_PORT: String(servicePort), OPENCHAMBER_SERVICE_TOKEN: token },
    })!;

    const hostHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Scroll Host</title>
<style>html, body { margin:0; padding:0; width:100%; height:100%; background:#0f1115; } iframe { width:100%; height:100%; border:0; display:block; }</style>
</head>
<body>
<iframe id="page-frame" sandbox="allow-scripts" src="/guest/page/index.html"></iframe>
<script>
const CHANNEL = ${JSON.stringify(OPENCHAMBER_SDK_CHANNEL)};
const VERSION = ${JSON.stringify(OPENCHAMBER_SDK_API_VERSION)};
const frame = document.getElementById('page-frame');
const post = (msg) => frame.contentWindow.postMessage({ channel: CHANNEL, v: VERSION, ...msg }, '*');
window.addEventListener('message', async (ev) => {
  const d = ev.data;
  if (!d || d.channel !== CHANNEL || d.v !== VERSION || ev.source !== frame.contentWindow) return;
  if (d.type === 'hello') {
    post({
      type: 'ready',
      payload: {
        theme: ${JSON.stringify(DARK_THEME)},
        locale: 'en',
        directory: '/home/alice/Projects/app',
        session: { id: 'ses_scroll_1', title: 'Main', busy: false },
        surface: 'page',
        connection: { connected: false, account: '' },
        settings: {},
        item: null,
      },
    });
    return;
  }
  if (d.type === 'service-request') {
    const qs = d.payload.query ? '?' + new URLSearchParams(d.payload.query).toString() : '';
    const r = await fetch('/proxy' + d.payload.path + qs, { method: d.payload.method });
    post({ type: 'result', id: d.id, ok: true, payload: { status: r.status, body: await r.text() } });
    return;
  }
  post({ type: 'result', id: d.id, ok: true });
});
</script>
</body>
</html>`;

    const harness = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hostHtml);
        return;
      }
      if (u.pathname === '/guest/page/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pageHtmlWithLook);
        return;
      }
      if (u.pathname === '/guest/page/main.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }).end(pageJsRaw);
        return;
      }
      if (u.pathname.startsWith('/proxy/')) {
        const upstream = await fetch(`http://127.0.0.1:${servicePort}${u.pathname.slice('/proxy'.length)}${u.search}`, {
          method: req.method,
          headers: { Authorization: `Bearer ${token}` },
        });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(await upstream.text());
        return;
      }
      res.writeHead(404).end('Not found');
    });

    const harnessPort = await listenEphemeral(harness);
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
      await page.goto(`http://127.0.0.1:${harnessPort}/`, { waitUntil: 'networkidle' });
      const frame = page.frameLocator('#page-frame');
      await frame.locator('.sh-skill-row').first().waitFor({ state: 'visible', timeout: 5_000 });

      const scrollMetrics = await frame.locator('.sh-scroll').evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);

      // Scroll inside the matrix and select a skill near the bottom
      const cardTopBefore = await frame.locator('.sh-matrix-card').evaluate((el) => el.getBoundingClientRect().top);
      await frame.locator('.sh-scroll').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await frame.locator('.sh-skill-row[data-skill-id="skill-30"]').click();
      await frame.locator('.sh-detail-row[data-detail-for="skill-30"] .sh-inspector').waitFor({ state: 'visible', timeout: 3_000 });

      // Matrix card position does not shift and scroll position is preserved
      const cardTopAfter = await frame.locator('.sh-matrix-card').evaluate((el) => el.getBoundingClientRect().top);
      expect(cardTopAfter).toBe(cardTopBefore);
      const isDirectlyAfterRow = await frame.locator('.sh-skill-row[data-skill-id="skill-30"]').evaluate((el) => (
        el.nextElementSibling?.getAttribute('data-detail-for') === 'skill-30'
      ));
      expect(isDirectlyAfterRow).toBe(true);
      const scrollAfter = await frame.locator('.sh-scroll').evaluate((el) => el.scrollTop);
      expect(scrollAfter).toBeGreaterThan(100);

      // Inline inspector sits inside the visible .sh-scroll window
      const inlineBounds = await frame.locator('.sh-scroll').evaluate((scrollEl) => {
        const sr = scrollEl.getBoundingClientRect();
        const ir = scrollEl.querySelector('.sh-inspector')!.getBoundingClientRect();
        return { sTop: sr.top, sBot: sr.bottom, iTop: ir.top, iBot: ir.bottom };
      });
      expect(inlineBounds.iTop).toBeGreaterThanOrEqual(inlineBounds.sTop - 1);
      expect(inlineBounds.iBot).toBeLessThanOrEqual(inlineBounds.sBot + 1);

      // On tall viewports (1040px & 1200px), matrix expands to fill remaining available height
      await page.setViewportSize({ width: 1280, height: 1040 });
      await page.waitForTimeout(80);
      const tallMetrics = await frame.locator('.sh-scroll').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { clientHeight: el.clientHeight, bottom: r.bottom, vh: window.innerHeight };
      });
      expect(tallMetrics.clientHeight).toBeGreaterThan(340);
      expect(tallMetrics.bottom).toBeGreaterThan(990);

      await page.setViewportSize({ width: 1280, height: 1200 });
      await page.waitForTimeout(80);
      const extraTallHeight = await frame.locator('.sh-scroll').evaluate((el) => el.clientHeight);
      expect(extraTallHeight).toBeGreaterThan(tallMetrics.clientHeight + 120);

      // On small-height viewport (460px), matrix keeps min-height (>= 220px) and inline inspector stays inside matrix
      await page.setViewportSize({ width: 1280, height: 460 });
      await page.waitForTimeout(80);
      const shortHeight = await frame.locator('.sh-scroll').evaluate((el) => el.clientHeight);
      expect(shortHeight).toBeGreaterThanOrEqual(220);

      await frame.locator('#root').evaluate((el) => {
        el.scrollTop = 260;
      });
      await page.waitForTimeout(80);

      await page.setViewportSize({ width: 1280, height: 760 });
      await frame.locator('#root').evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(80);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'session-skills-heatmap-scroll.png') });
    } finally {
      db.close();
      await browser.close();
      await service.close();
      await new Promise<void>((r) => harness.close(() => r()));
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 25_000);
});
