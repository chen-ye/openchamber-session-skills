import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startServer } from '../service/main.ts';
import {
  aggregateScopedSkills,
  mapTimestampToParentTurn,
  parseSessionMessages,
  parseSkillContent,
} from '../service/parser.ts';
import {
  deriveVisualTone,
  formatDepthSummary,
  formatTurnAgeLabel,
} from '../status/main.ts';
import { SKILLS_UPDATED_TOPIC, type SessionSkillsResponse } from '../shared/types.ts';

const listenEphemeral = (server: http.Server): Promise<number> => (
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  })
);

describe('parseSkillContent & context-depth aggregation', () => {
  test('extracts base directory, strips wrapper tags, and avoids duplicating summary paragraph in preview', () => {
    const raw = `<skill_content name="openchamber-extensions">
# Skill: openchamber-extensions

# Writing an OpenChamber extension

An extension is a folder with a \`package.json\` that has an \`openchamber\` block.

## Steps

1. Design where it lives.
2. Bundle with openchamber-guest-bundle.

Base directory for this skill: /home/alice/.config/opencode/skills/openchamber-extensions
Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.
<skill_files>
reference/api.md
</skill_files>
</skill_content>`;

    const parsed = parseSkillContent(raw);
    expect(parsed.name).toBe('openchamber-extensions');
    expect(parsed.directory).toBe('/home/alice/.config/opencode/skills/openchamber-extensions');
    expect(parsed.description).toContain('An extension is a folder');
    expect(parsed.preview).toContain('## Steps');
    expect(parsed.preview).not.toContain('An extension is a folder');
    expect(parsed.preview).not.toContain('<skill_files>');
    expect(parsed.preview).not.toContain('Base directory for this skill:');

    const singleLine = `<skill_content name="short-skill">\n# Skill: short-skill\n\nJust one short line.\n</skill_content>`;
    const singleParsed = parseSkillContent(singleLine);
    expect(singleParsed.description).toBe('Just one short line.');
    expect(singleParsed.preview).toBeNull();
  });

  test('computes exact cumulative step watermarks, compaction eviction, turnsAgo, and subagent isolation', () => {
    // Multi-turn session with a compaction after Turn 0:
    // Turn 0 (compacted): brainstorming
    // Turn 1: $openchamber-extensions at 36k -> endWatermark 36,500
    // Turn 2: subagent explore spawned
    // Turn 3 (current): principle-prove-it-works loaded on step 1 -> step 2 reaches 241,000 total context
    const rootMessages = [
      {
        id: 'msg_t0_u',
        type: 'user',
        time: { created: 500 },
        text: '$brainstorming initial idea',
        skills: [
          {
            id: 'brainstorming',
            name: 'brainstorming',
            text: '<skill_content name="brainstorming">\n# Skill: brainstorming\n\nExplore ideas.\n</skill_content>',
          },
        ],
      },
      {
        id: 'msg_t0_a',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 600, completed: 650 },
        tokens: { input: 700_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } },
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
        // Pre-compaction summarizer call tokens — must NOT pollute post-compaction window!
        tokens: { input: 701_000, output: 2_000, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      // Turn 1 (post-compaction): synthetic chip + user prompt (must count as ONE turn = index 1)
      { id: 'msg_t1_syn', type: 'synthetic', text: 'Attached context', time: { created: 990 } },
      {
        id: 'msg_t1_u',
        type: 'user',
        time: { created: 1_000 },
        text: '$openchamber-extensions build extension',
        skills: [
          {
            id: 'openchamber-extensions',
            name: 'openchamber-extensions',
            text: '<skill_content name="openchamber-extensions">\n# Skill: openchamber-extensions\n\nBuild extensions.\n\nBase directory for this skill: /home/alice/skills/openchamber-extensions\n</skill_content>',
          },
        ],
      },
      {
        id: 'msg_t1_a',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 1_100, completed: 1_150 },
        tokens: { input: 36_000, output: 500, reasoning: 200, cache: { read: 0, write: 0 } },
        content: [],
      },
      { id: 'msg_t1_idle', type: 'idle', time: { created: 1_200 } },
      // Turn 2: spawns subagent explore
      { id: 'msg_t2_u', type: 'user', time: { created: 2_000 }, text: 'check opencode schema' },
      {
        id: 'msg_t2_a',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 2_100, completed: 2_400 },
        tokens: { input: 44_000, output: 600, reasoning: 150, cache: { read: 36_500, write: 0 } },
        content: [
          {
            type: 'tool',
            id: 'call_sub',
            name: 'subagent',
            state: {
              status: 'completed',
              input: { agent: 'explore', skills: ['investigate-opencode', 'nonexistent'] },
              metadata: { sessionID: 'ses_child_1' },
            },
            time: { created: 2_150, completed: 2_350 },
          },
        ],
      },
      { id: 'msg_t2_idle', type: 'idle', time: { created: 2_500 } },
      // Turn 3 (current turn = index 3): calls skill tool on step 1, finishes on step 2 at 200k window
      { id: 'msg_t3_u', type: 'user', time: { created: 3_000 }, text: 'verify everything' },
      {
        id: 'msg_t3_a1',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 3_100, completed: 3_150 },
        tokens: { input: 98_900, output: 300, reasoning: 100, cache: { read: 81_100, write: 0 } },
        content: [
          {
            type: 'tool',
            id: 'call_ok',
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
                  text: '<skill_content name="principle-prove-it-works">\n# Skill: principle-prove-it-works\n\nVerify against the real artifact.\n</skill_content>',
                },
              ],
            },
            time: { created: 3_120, completed: 3_125 },
          },
        ],
      },
      {
        id: 'msg_t3_a2',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 3_200, completed: 3_250 },
        // promptTokens = 19_800 + 180_200 = 200_000; endWatermark = 200_500
        tokens: { input: 19_800, output: 500, reasoning: 100, cache: { read: 180_200, write: 0 } },
        content: [],
      },
    ];

    const childMessages = [
      {
        id: 'msg_cu1',
        type: 'user',
        time: { created: 2_160 },
        text: `[SKILL: investigate-opencode]
---
name: investigate-opencode
description: Analyze OpenCode internals.
---
# Investigate OpenCode

Read local source.

1. TASK
Inspect types.`,
      },
      {
        id: 'msg_ca1',
        type: 'assistant',
        agent: 'explore',
        time: { created: 2_200, completed: 2_240 },
        tokens: { input: 30_000, output: 500, reasoning: 100, cache: { read: 0, write: 0 } },
        content: [],
      },
      {
        id: 'msg_ca2',
        type: 'assistant',
        agent: 'explore',
        time: { created: 2_280, completed: 2_330 },
        // Child's own context window grew from 30.5k -> 80k
        tokens: { input: 49_000, output: 500, reasoning: 100, cache: { read: 30_500, write: 0 } },
        content: [],
      },
    ];

    const rootParsed = parseSessionMessages({
      sessionId: 'ses_root_1',
      isSubagent: false,
      defaultAgent: 'orchestrator',
      messages: rootMessages,
    });
    expect(rootParsed.turnCount).toBe(4);
    expect(rootParsed.currentTurnIndex).toBe(3);
    expect(rootParsed.latestWindowTokens).toBe(200_500);

    const sessionSummaries = aggregateScopedSkills({
      scope: 'session',
      records: rootParsed.records,
      effectiveRootTurnIndex: rootParsed.currentTurnIndex,
      effectiveRootTurnCount: rootParsed.turnCount,
      diskMetadataByDirectory: new Map(),
      homeDir: '/home/alice',
    });

    expect(sessionSummaries.map((s) => s.id)).toEqual([
      'brainstorming',
      'openchamber-extensions',
      'principle-prove-it-works',
    ]);

    const compactedSkill = sessionSummaries[0]!;
    expect(compactedSkill.depth.compacted).toBe(true);
    expect(compactedSkill.depth.turnsAgo).toBe(3);
    expect(compactedSkill.depth.position).toBeNull();
    expect(deriveVisualTone(compactedSkill)).toBe('compacted');
    expect(formatTurnAgeLabel(compactedSkill)).toBe('3t');

    const turn1Skill = sessionSummaries[1]!;
    expect(turn1Skill.depth.compacted).toBe(false);
    expect(turn1Skill.depth.turnsAgo).toBe(2);
    expect(turn1Skill.depth.activationTokens).toBe(36_500);
    expect(turn1Skill.depth.windowTokens).toBe(200_500);
    expect(turn1Skill.depth.tokensAgo).toBe(164_000);
    expect(turn1Skill.depth.position).toBeCloseTo(36_500 / 200_500, 3);
    expect(deriveVisualTone(turn1Skill)).toBe('deep');
    expect(formatTurnAgeLabel(turn1Skill)).toBe('2t');
    expect(formatDepthSummary(turn1Skill).left).toContain('2 turns ago');

    const nowSkill = sessionSummaries[2]!;
    expect(nowSkill.depth.turnsAgo).toBe(0);
    expect(nowSkill.depth.tokensAgo).toBe(0);
    expect(nowSkill.depth.position).toBe(1);
    expect(deriveVisualTone(nowSkill)).toBe('fresh');
    expect(formatTurnAgeLabel(nowSkill)).toBe('now');

    // Child subagent skill uses child's own context window for bar position, and root turns for turnsAgo!
    const childParsed = parseSessionMessages({
      sessionId: 'ses_child_1',
      isSubagent: true,
      defaultAgent: 'explore',
      messages: childMessages,
    });
    const remappedSubRecords = childParsed.records.map((rec) => ({
      ...rec,
      turnIndex: mapTimestampToParentTurn({
        at: rec.at,
        rootTurns: rootParsed.turns,
        rootCurrentTurnIndex: rootParsed.currentTurnIndex,
        minTurnIndex: rootParsed.childSpawnTurnBySessionId.get('ses_child_1') ?? 0,
      }),
    }));
    const subSummaries = aggregateScopedSkills({
      scope: 'subagent',
      records: remappedSubRecords,
      effectiveRootTurnIndex: rootParsed.currentTurnIndex,
      effectiveRootTurnCount: rootParsed.turnCount,
      diskMetadataByDirectory: new Map(),
      homeDir: '/home/alice',
    });

    expect(subSummaries).toHaveLength(1);
    const subSkill = subSummaries[0]!;
    expect(subSkill.id).toBe('investigate-opencode');
    expect(subSkill.depth.turnsAgo).toBe(1);
    expect(subSkill.depth.activationTokens).toBe(30_500);
    expect(subSkill.depth.windowTokens).toBe(80_000);
    expect(subSkill.depth.position).toBeCloseTo(30_500 / 80_000, 3);
    expect(formatTurnAgeLabel(subSkill)).toBe('1t');

    // Edge case: session just compacted at end of Turn 0 with no post-compaction turn yet -> must be 1t, never 'now'!
    const justCompactedParsed = parseSessionMessages({
      sessionId: 'ses_just_compacted',
      isSubagent: false,
      defaultAgent: 'orchestrator',
      messages: rootMessages.slice(0, 4),
    });
    const justCompactedSummaries = aggregateScopedSkills({
      scope: 'session',
      records: justCompactedParsed.records,
      effectiveRootTurnIndex: justCompactedParsed.currentTurnIndex,
      effectiveRootTurnCount: Math.max(1, justCompactedParsed.turnCount),
      diskMetadataByDirectory: new Map(),
      homeDir: '/home/alice',
    });
    expect(justCompactedSummaries[0]?.depth.compacted).toBe(true);
    expect(justCompactedSummaries[0]?.depth.turnsAgo).toBe(1);
    expect(formatTurnAgeLabel(justCompactedSummaries[0]!)).toBe('1t');
  });
});

describe('service HTTP + OpenCode loopback SSE integration', () => {
  test('hydrates session tree, enriches SKILL.md frontmatter, and emits live SSE skill updates', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-skills-test-'));
    const skillDir = path.join(tmpDir, 'demo-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: demo-skill
description: Ground-truth description from SKILL.md frontmatter.
---
# Demo Skill

Body instructions here.
`,
      'utf8',
    );

    const emittedEvents: Array<{ topic: string; data: unknown }> = [];
    const sseState: { res: http.ServerResponse | null } = { res: null };
    let sseConnectedResolve: (() => void) | null = null;
    const sseConnectedPromise = new Promise<void>((resolve) => {
      sseConnectedResolve = resolve;
    });

    const messagesBySession = new Map<string, unknown[]>([
      [
        'ses_main1',
        [
          {
            id: 'msg_1',
            type: 'user',
            time: { created: 100 },
            text: '$demo-skill hello',
            skills: [
              {
                id: 'demo-skill',
                name: 'demo-skill',
                text: `<skill_content name="demo-skill">\n# Skill: demo-skill\n\nBody instructions here.\n\nBase directory for this skill: ${skillDir}\n</skill_content>`,
              },
            ],
          },
          {
            id: 'msg_1_a',
            type: 'assistant',
            agent: 'orchestrator',
            time: { created: 120, completed: 150 },
            tokens: { input: 32_000, output: 400, reasoning: 100, cache: { read: 0, write: 0 } },
            content: [],
          },
        ],
      ],
    ]);

    const mockOpenCode = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname === '/api/event') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseState.res = res;
        sseConnectedResolve?.();
        return;
      }

      if (u.pathname === '/api/session/ses_main1') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            data: { id: 'ses_main1', parentID: null, agent: 'orchestrator' },
          }),
        );
        return;
      }

      if (u.pathname === '/api/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ data: [], cursor: { next: null } }),
        );
        return;
      }

      if (u.pathname === '/api/session/ses_main1/message') {
        const stored = messagesBySession.get('ses_main1') ?? [];
        const ordered = u.searchParams.get('order') === 'desc' ? [...stored].reverse() : stored;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            data: ordered,
            cursor: { next: null },
          }),
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
        if (parsed.method === 'panels.emit') {
          emittedEvents.push(parsed.input);
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

    const token = 'test-secret-token';
    const running = startServer({
      port: servicePort,
      token,
      opencodeUrl: `http://127.0.0.1:${opencodePort}`,
      homeDir: tmpDir,
      env: {
        OPENCHAMBER_SERVICE_PORT: String(servicePort),
        OPENCHAMBER_SERVICE_TOKEN: token,
        OPENCHAMBER_OPENCODE_URL: `http://127.0.0.1:${opencodePort}`,
        OPENCHAMBER_HOST_CALLBACK_URL: `http://127.0.0.1:${callbackPort}`,
      },
    });
    expect(running).not.toBeNull();

    try {
      await sseConnectedPromise;

      const unauth = await fetch(`http://127.0.0.1:${servicePort}/health`);
      expect(unauth.status).toBe(401);

      const health = await fetch(`http://127.0.0.1:${servicePort}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(health.status).toBe(200);

      const initialRes = await fetch(`http://127.0.0.1:${servicePort}/skills?sessionId=ses_main1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(initialRes.status).toBe(200);
      const initialBody = (await initialRes.json()) as SessionSkillsResponse;
      expect(initialBody.sessionSkills).toHaveLength(1);
      expect(initialBody.sessionSkills[0]?.id).toBe('demo-skill');
      expect(initialBody.sessionSkills[0]?.description).toBe('Ground-truth description from SKILL.md frontmatter.');
      expect(initialBody.sessionSkills[0]?.displayPath).toBe('~/demo-skill');
      expect(initialBody.sessionSkills[0]?.depth.position).toBe(1);

      // Stream live skill tool activation over SSE
      sseState.res!.write(`data: ${JSON.stringify({
        id: 'evt_1',
        type: 'session.tool.input.started',
        created: 200,
        data: { sessionID: 'ses_main1', id: 'call_live_1', name: 'skill' },
      })}\n\n`);
      sseState.res!.write(`data: ${JSON.stringify({
        id: 'evt_2',
        type: 'session.tool.called',
        created: 210,
        data: { sessionID: 'ses_main1', id: 'call_live_1', input: { id: 'live-loaded-skill' } },
      })}\n\n`);

      await new Promise((r) => setTimeout(r, 140));

      const loadingRes = await fetch(`http://127.0.0.1:${servicePort}/skills?sessionId=ses_main1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const loadingBody = (await loadingRes.json()) as SessionSkillsResponse;
      expect(loadingBody.sessionSkills.map((s) => ({ id: s.id, status: s.status }))).toEqual([
        { id: 'demo-skill', status: 'active' },
        { id: 'live-loaded-skill', status: 'loading' },
      ]);
      expect(emittedEvents.some((e) => e.topic === SKILLS_UPDATED_TOPIC)).toBe(true);

      messagesBySession.get('ses_main1')!.push({
        id: 'msg_2',
        type: 'assistant',
        agent: 'orchestrator',
        time: { created: 220, completed: 230 },
        tokens: { input: 18_000, output: 600, reasoning: 100, cache: { read: 32_400, write: 0 } },
        content: [
          {
            type: 'tool',
            id: 'call_live_1',
            name: 'skill',
            state: {
              status: 'completed',
              input: { id: 'live-loaded-skill' },
              metadata: { name: 'live-loaded-skill' },
              content: [
                {
                  type: 'text',
                  text: '<skill_content name="live-loaded-skill">\n# Skill: live-loaded-skill\n\nLoaded dynamically.\n</skill_content>',
                },
              ],
            },
            time: { created: 210, completed: 225 },
          },
        ],
      });

      sseState.res!.write(`data: ${JSON.stringify({
        id: 'evt_3',
        type: 'session.tool.success',
        created: 225,
        data: {
          sessionID: 'ses_main1',
          id: 'call_live_1',
          metadata: { name: 'live-loaded-skill' },
          content: [
            {
              type: 'text',
              text: '<skill_content name="live-loaded-skill">\n# Skill: live-loaded-skill\n\nLoaded dynamically.\n</skill_content>',
            },
          ],
        },
      })}\n\n`);

      await new Promise((r) => setTimeout(r, 150));

      const doneRes = await fetch(`http://127.0.0.1:${servicePort}/skills?sessionId=ses_main1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const doneBody = (await doneRes.json()) as SessionSkillsResponse;
      expect(doneBody.sessionSkills.map((s) => ({ id: s.id, status: s.status }))).toEqual([
        { id: 'demo-skill', status: 'active' },
        { id: 'live-loaded-skill', status: 'active' },
      ]);
      expect(doneBody.sessionSkills[0]?.depth.tokensAgo).toBe(18_600);
      expect(doneBody.sessionSkills[1]?.depth.tokensAgo).toBe(0);
    } finally {
      sseState.res?.end();
      await running?.close();
      await new Promise<void>((r) => mockOpenCode.close(() => r()));
      await new Promise<void>((r) => mockCallback.close(() => r()));
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
