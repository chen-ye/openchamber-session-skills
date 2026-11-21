import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServiceHost, type ServiceHost } from '@openchamber/sdk';
import { createHeatmapStore } from './heatmap.ts';
import {
  aggregateScopedSkills,
  extractSkillTagNameFromToolContent,
  isRecord,
  mapTimestampToParentTurn,
  parseSessionMessages,
  parseSkillContent,
  trimmed,
  type DiskSkillMetadata,
  type ParsedSessionMessages,
  type RawSkillEventRecord,
} from './parser.ts';
import {
  HEATMAP_UPDATED_TOPIC,
  SKILLS_UPDATED_TOPIC,
  type SessionSkillsResponse,
  type SkillHeatmapScopeFilter,
  type SkillHeatmapWindow,
} from '../shared/types.ts';

const SESSION_ID_PATTERN = /^ses_[\w-]+$/;
const MAX_TRACKED_SESSIONS = 200;
const MAX_DISK_CACHE = 256;
const MESSAGE_PAGE_LIMIT = 100;
const MAX_MESSAGE_PAGES = 15;
const EMIT_DEBOUNCE_MS = 80;

type TrackedToolCall = {
  callId: string;
  toolName: 'skill' | 'subagent';
  skillId: string | null;
  childSessionId: string | null;
  subagentSkills: string[];
  subagentActor: string | null;
  status: 'loading' | 'active' | 'failed';
  at: number;
  directory: string | null;
  description: string | null;
  preview: string | null;
  error: string | null;
};

export type SessionNode = {
  sessionId: string;
  parentId: string | null;
  agent: string | null;
  hydratedAt: number | null;
  dirty: boolean;
  dirtySeq: number;
  lastTouchedAt: number;
  parsed: ParsedSessionMessages | null;
  inFlightTools: Map<string, TrackedToolCall>;
  enqueuedInboxSkills: Map<string, RawSkillEventRecord[]>;
};

export type SkillServiceStore = {
  sessions: Map<string, SessionNode>;
  childrenByParent: Map<string, Set<string>>;
  diskMetadata: Map<string, DiskSkillMetadata>;
  inflightHydrations: Map<string, Promise<void>>;
  emitTimers: Map<string, ReturnType<typeof setTimeout>>;
  sseConnected: boolean;
  homeDir: string | null;
};

export const createSkillServiceStore = (homeDir: string | null = os.homedir() || null): SkillServiceStore => ({
  sessions: new Map(),
  childrenByParent: new Map(),
  diskMetadata: new Map(),
  inflightHydrations: new Map(),
  emitTimers: new Map(),
  sseConnected: false,
  homeDir,
});

const linkChildSession = (store: SkillServiceStore, parentId: string, childId: string): boolean => {
  if (!parentId || !childId || parentId === childId) return false;
  let set = store.childrenByParent.get(parentId);
  if (!set) {
    set = new Set();
    store.childrenByParent.set(parentId, set);
  }
  const before = set.size;
  set.add(childId);
  return set.size !== before;
};

export const ensureSessionNode = (
  store: SkillServiceStore,
  sessionId: string,
  now = Date.now(),
): SessionNode => {
  const existing = store.sessions.get(sessionId);
  if (existing) {
    existing.lastTouchedAt = now;
    return existing;
  }

  if (store.sessions.size >= MAX_TRACKED_SESSIONS) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, node] of store.sessions.entries()) {
      if (node.inFlightTools.size === 0 && node.lastTouchedAt < oldestTime) {
        oldestTime = node.lastTouchedAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      store.sessions.delete(oldestId);
    }
  }

  const created: SessionNode = {
    sessionId,
    parentId: null,
    agent: null,
    hydratedAt: null,
    dirty: true,
    dirtySeq: 1,
    lastTouchedAt: now,
    parsed: null,
    inFlightTools: new Map(),
    enqueuedInboxSkills: new Map(),
  };
  store.sessions.set(sessionId, created);
  return created;
};

const markSessionDirty = (node: SessionNode): void => {
  node.dirty = true;
  node.dirtySeq += 1;
};

export const resolveRootSessionId = (store: SkillServiceStore, sessionId: string): string => {
  const visited = new Set<string>();
  let current = sessionId;
  while (!visited.has(current)) {
    visited.add(current);
    const node = store.sessions.get(current);
    if (!node?.parentId) break;
    current = node.parentId;
  }
  return current;
};

const collectDescendants = (store: SkillServiceStore, rootSessionId: string): string[] => {
  const result: string[] = [];
  const visited = new Set<string>([rootSessionId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: rootSessionId, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth >= 6) continue;
    const direct = store.childrenByParent.get(item.id);
    const parsedKids = store.sessions.get(item.id)?.parsed?.discoveredChildSessionIds ?? [];
    const combined = new Set<string>([
      ...(direct ?? []),
      ...parsedKids,
    ]);
    for (const childId of combined) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      result.push(childId);
      queue.push({ id: childId, depth: item.depth + 1 });
    }
  }

  return result;
};

const treeHasAnySkills = (store: SkillServiceStore, rootSessionId: string): boolean => {
  const ids = [rootSessionId, ...collectDescendants(store, rootSessionId)];
  for (const id of ids) {
    const n = store.sessions.get(id);
    if (!n) continue;
    if ((n.parsed?.records.length ?? 0) > 0) return true;
    if ((n.parsed?.subagentHandoffs.length ?? 0) > 0) return true;
    if (n.inFlightTools.size > 0 || n.enqueuedInboxSkills.size > 0) return true;
  }
  return false;
};

const enrichSkillMetadataFromDisk = async (
  store: SkillServiceStore,
  directory: string,
): Promise<void> => {
  if (!directory || store.diskMetadata.has(directory)) return;
  if (!path.isAbsolute(directory)) return;

  if (store.diskMetadata.size >= MAX_DISK_CACHE) {
    const firstKey = store.diskMetadata.keys().next().value;
    if (typeof firstKey === 'string') store.diskMetadata.delete(firstKey);
  }

  try {
    const skillMdPath = path.join(directory, 'SKILL.md');
    const content = await fs.readFile(skillMdPath, 'utf8');
    const parsed = parseSkillContent(content);
    store.diskMetadata.set(directory, {
      description: parsed.description,
      preview: parsed.preview,
    });
  } catch {
    store.diskMetadata.set(directory, { description: null, preview: null });
  }
};

const unwrapData = (body: unknown): unknown => {
  if (!isRecord(body)) return body;
  return 'data' in body ? body.data : body;
};

const fetchSessionMessages = async (
  opencodeUrl: string,
  headers: Record<string, string>,
  sessionId: string,
): Promise<unknown[] | null> => {
  const newestFirst: unknown[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const query: string = cursor
      ? `limit=${MESSAGE_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
      : `limit=${MESSAGE_PAGE_LIMIT}&order=desc`;
    const res: Response = await fetch(
      `${opencodeUrl}/api/session/${encodeURIComponent(sessionId)}/message?${query}`,
      { headers, signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return page === 0 ? null : newestFirst.reverse();
    const raw: unknown = await res.json().catch(() => null);
    const list = Array.isArray(raw)
      ? raw
      : (isRecord(raw) && Array.isArray(raw.data) ? raw.data : null);
    if (!list) return page === 0 ? null : newestFirst.reverse();

    newestFirst.push(...list);

    const nextCursor: string = isRecord(raw) && isRecord(raw.cursor) && typeof raw.cursor.next === 'string'
      ? raw.cursor.next.trim()
      : '';
    if (!nextCursor || list.length < MESSAGE_PAGE_LIMIT) {
      break;
    }
    cursor = nextCursor;
  }

  return newestFirst.reverse();
};

export const hydrateSingleSession = async (
  store: SkillServiceStore,
  opencodeUrl: string,
  token: string,
  sessionId: string,
): Promise<void> => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return;

  for (let pass = 0; pass < 2; pass += 1) {
    const existingPromise = store.inflightHydrations.get(sessionId);
    if (existingPromise) {
      await existingPromise;
      const afterNode = store.sessions.get(sessionId);
      if (!afterNode || (!afterNode.dirty && afterNode.hydratedAt !== null)) {
        return;
      }
    }

    const node = ensureSessionNode(store, sessionId, Date.now());
    const startSeq = node.dirtySeq;

    const job = (async () => {
      const headers = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      };
      const now = Date.now();

      try {
        const [infoRes, childrenRes, messages] = await Promise.all([
          fetch(`${opencodeUrl}/api/session/${encodeURIComponent(sessionId)}`, {
            headers,
            signal: AbortSignal.timeout(6_000),
          }).catch(() => null),
          fetch(`${opencodeUrl}/api/session?parentID=${encodeURIComponent(sessionId)}&limit=50`, {
            headers,
            signal: AbortSignal.timeout(6_000),
          }).catch(() => null),
          fetchSessionMessages(opencodeUrl, headers, sessionId).catch(() => null),
        ]);

        if (infoRes?.ok) {
          const info = unwrapData(await infoRes.json().catch(() => null));
          if (isRecord(info)) {
            const parentId = trimmed(info.parentID) || null;
            if (parentId) {
              node.parentId = parentId;
              linkChildSession(store, parentId, sessionId);
            }
            const agent = trimmed(info.agent) || null;
            if (agent) node.agent = agent;
          }
        }

        if (childrenRes?.ok) {
          const rawKids = await childrenRes.json().catch(() => null);
          const kidsList = Array.isArray(rawKids)
            ? rawKids
            : (isRecord(rawKids) && Array.isArray(rawKids.data) ? rawKids.data : []);
          for (const kid of kidsList) {
            if (!isRecord(kid)) continue;
            const kidId = trimmed(kid.id);
            if (!SESSION_ID_PATTERN.test(kidId)) continue;
            const kidNode = ensureSessionNode(store, kidId, now);
            kidNode.parentId = sessionId;
            const kidAgent = trimmed(kid.agent) || null;
            if (kidAgent) kidNode.agent = kidAgent;
            linkChildSession(store, sessionId, kidId);
          }
        }

        if (messages !== null) {
          const isSubagent = Boolean(node.parentId);
          const parsed = parseSessionMessages({
            sessionId,
            isSubagent,
            defaultAgent: node.agent,
            messages,
          });
          node.parsed = parsed;
          node.hydratedAt = Date.now();
          if (node.dirtySeq === startSeq) {
            node.dirty = false;
          }

          for (const childId of parsed.discoveredChildSessionIds) {
            const kidNode = ensureSessionNode(store, childId, now);
            if (!kidNode.parentId) kidNode.parentId = sessionId;
            linkChildSession(store, sessionId, childId);
          }

          for (const inboxId of node.enqueuedInboxSkills.keys()) {
            if (parsed.persistedMessageIds.has(inboxId)) {
              node.enqueuedInboxSkills.delete(inboxId);
            }
          }

          for (const [callId, tool] of node.inFlightTools.entries()) {
            if (parsed.terminalToolCallIds.has(callId) || (node.dirtySeq === startSeq && tool.status !== 'loading')) {
              node.inFlightTools.delete(callId);
            }
          }

          const dirsToEnrich = new Set<string>();
          for (const rec of parsed.records) {
            if (rec.directory && !store.diskMetadata.has(rec.directory)) {
              dirsToEnrich.add(rec.directory);
            }
          }
          if (dirsToEnrich.size > 0) {
            await Promise.all(
              Array.from(dirsToEnrich).map((dir) => enrichSkillMetadataFromDisk(store, dir)),
            );
          }
        }
      } finally {
        store.inflightHydrations.delete(sessionId);
      }
    })();

    store.inflightHydrations.set(sessionId, job);
    await job;
    if (!node.dirty) return;
  }
};

export const hydrateSessionTree = async (
  store: SkillServiceStore,
  opencodeUrl: string,
  token: string,
  rootSessionId: string,
): Promise<void> => {
  const rootNode = ensureSessionNode(store, rootSessionId);
  if (rootNode.hydratedAt === null || rootNode.dirty) {
    await hydrateSingleSession(store, opencodeUrl, token, rootSessionId);
  }

  for (let wave = 0; wave < 2; wave += 1) {
    const descendants = collectDescendants(store, rootSessionId);
    const pendingKids = descendants.filter((id) => {
      const n = ensureSessionNode(store, id);
      return n.hydratedAt === null || n.dirty;
    });
    if (pendingKids.length === 0) break;
    await Promise.all(
      pendingKids.slice(0, 24).map((id) => hydrateSingleSession(store, opencodeUrl, token, id)),
    );
  }
};

export const buildSessionSkillsResponse = (
  store: SkillServiceStore,
  sessionId: string,
): SessionSkillsResponse => {
  const rootNode = store.sessions.get(sessionId);
  const descendants = collectDescendants(store, sessionId);
  const rootParsed = rootNode?.parsed ?? null;

  const baseTurnCount = rootParsed?.turnCount ?? 0;
  const baseTurnIndex = rootParsed?.currentTurnIndex ?? 0;
  const hasLiveNewTurn = Boolean(
    rootNode
    && rootNode.enqueuedInboxSkills.size > 0
    && (baseTurnCount === 0 || rootParsed?.lastTurnEndedIdle || rootParsed?.latestTurnHasAssistant),
  );
  const effectiveRootTurnCount = hasLiveNewTurn
    ? baseTurnCount + 1
    : baseTurnCount;
  const effectiveRootTurnIndex = effectiveRootTurnCount > 0
    ? effectiveRootTurnCount - 1
    : 0;
  const rootWindowTokens = rootParsed?.latestWindowTokens ?? null;
  const rootTurns = rootParsed?.turns ?? [];

  // Propagate child spawn turn indices from root down to nested subagents
  const spawnTurnBySessionId = new Map<string, number>();
  if (rootParsed) {
    for (const [childId, spawnTurn] of rootParsed.childSpawnTurnBySessionId.entries()) {
      spawnTurnBySessionId.set(childId, spawnTurn);
    }
  }
  for (const descId of descendants) {
    const descNode = store.sessions.get(descId);
    const parentTurn = (descNode?.parentId ? spawnTurnBySessionId.get(descNode.parentId) : undefined) ?? 0;
    if (!spawnTurnBySessionId.has(descId) && descNode?.parentId && descNode.parentId !== sessionId) {
      spawnTurnBySessionId.set(descId, parentTurn);
    }
    if (descNode?.parsed) {
      for (const [grandChildId] of descNode.parsed.childSpawnTurnBySessionId.entries()) {
        if (!spawnTurnBySessionId.has(grandChildId)) {
          spawnTurnBySessionId.set(grandChildId, spawnTurnBySessionId.get(descId) ?? parentTurn);
        }
      }
    }
  }

  const sessionRecords: RawSkillEventRecord[] = [];
  const subagentRecords: RawSkillEventRecord[] = [];

  if (rootNode) {
    if (rootParsed) {
      sessionRecords.push(...rootParsed.records);

      for (const handoff of rootParsed.subagentHandoffs) {
        const childNode = handoff.childSessionId ? store.sessions.get(handoff.childSessionId) : undefined;
        if (childNode?.parsed?.hasUserMessage) {
          continue;
        }
        for (const skillId of handoff.skills) {
          subagentRecords.push({
            id: skillId,
            name: skillId,
            scope: 'subagent',
            trigger: 'subagent',
            status: handoff.status === 'loading' ? 'loading' : 'active',
            at: handoff.at,
            turnIndex: handoff.parentTurnIndex,
            compacted: false,
            activationTokens: null,
            windowTokens: null,
            sessionTurnCount: Math.max(1, effectiveRootTurnCount),
            actor: handoff.actor,
            sessionId: handoff.childSessionId || sessionId,
            directory: null,
            description: null,
            preview: null,
            error: null,
          });
        }
      }
    }

    for (const inboxRecords of rootNode.enqueuedInboxSkills.values()) {
      for (const rec of inboxRecords) {
        sessionRecords.push({
          ...rec,
          scope: 'session',
          turnIndex: effectiveRootTurnIndex,
          compacted: false,
          activationTokens: rootWindowTokens,
          windowTokens: rootWindowTokens,
          sessionTurnCount: Math.max(1, effectiveRootTurnCount),
        });
      }
    }

    for (const liveTool of rootNode.inFlightTools.values()) {
      if (liveTool.toolName === 'skill' && liveTool.skillId) {
        sessionRecords.push({
          id: liveTool.skillId,
          name: liveTool.skillId,
          scope: 'session',
          trigger: 'agent',
          status: liveTool.status,
          at: liveTool.at,
          turnIndex: effectiveRootTurnIndex,
          compacted: false,
          activationTokens: rootWindowTokens,
          windowTokens: rootWindowTokens,
          sessionTurnCount: Math.max(1, effectiveRootTurnCount),
          actor: rootNode.agent,
          sessionId,
          directory: liveTool.directory,
          description: liveTool.description,
          preview: liveTool.preview,
          error: liveTool.error,
        });
      } else if (liveTool.toolName === 'subagent' && liveTool.subagentSkills.length > 0) {
        const childNode = liveTool.childSessionId ? store.sessions.get(liveTool.childSessionId) : undefined;
        if (!childNode?.parsed?.hasUserMessage) {
          for (const skillId of liveTool.subagentSkills) {
            subagentRecords.push({
              id: skillId,
              name: skillId,
              scope: 'subagent',
              trigger: 'subagent',
              status: liveTool.status === 'loading' ? 'loading' : 'active',
              at: liveTool.at,
              turnIndex: effectiveRootTurnIndex,
              compacted: false,
              activationTokens: null,
              windowTokens: null,
              sessionTurnCount: Math.max(1, effectiveRootTurnCount),
              actor: liveTool.subagentActor || 'subagent',
              sessionId: liveTool.childSessionId || sessionId,
              directory: null,
              description: null,
              preview: null,
              error: null,
            });
          }
        }
      }
    }
  }

  for (const childId of descendants) {
    const childNode = store.sessions.get(childId);
    if (!childNode) continue;
    const minTurn = spawnTurnBySessionId.get(childId) ?? 0;
    const childWindowTokens = childNode.parsed?.latestWindowTokens ?? null;

    if (childNode.parsed) {
      for (const rec of childNode.parsed.records) {
        const mappedTurn = mapTimestampToParentTurn({
          at: rec.at,
          rootTurns,
          rootCurrentTurnIndex: effectiveRootTurnIndex,
          minTurnIndex: minTurn,
        });
        subagentRecords.push({
          ...rec,
          scope: 'subagent',
          trigger: 'subagent',
          turnIndex: mappedTurn,
        });
      }

      for (const handoff of childNode.parsed.subagentHandoffs) {
        const grandChild = handoff.childSessionId ? store.sessions.get(handoff.childSessionId) : undefined;
        if (grandChild?.parsed?.hasUserMessage) continue;
        const mappedTurn = mapTimestampToParentTurn({
          at: handoff.at,
          rootTurns,
          rootCurrentTurnIndex: effectiveRootTurnIndex,
          minTurnIndex: minTurn,
        });
        for (const skillId of handoff.skills) {
          subagentRecords.push({
            id: skillId,
            name: skillId,
            scope: 'subagent',
            trigger: 'subagent',
            status: handoff.status === 'loading' ? 'loading' : 'active',
            at: handoff.at,
            turnIndex: mappedTurn,
            compacted: false,
            activationTokens: null,
            windowTokens: null,
            sessionTurnCount: Math.max(1, effectiveRootTurnCount),
            actor: handoff.actor,
            sessionId: handoff.childSessionId || childId,
            directory: null,
            description: null,
            preview: null,
            error: null,
          });
        }
      }
    }

    for (const inboxRecords of childNode.enqueuedInboxSkills.values()) {
      for (const rec of inboxRecords) {
        subagentRecords.push({
          ...rec,
          scope: 'subagent',
          trigger: 'subagent',
          turnIndex: effectiveRootTurnIndex,
          activationTokens: childWindowTokens,
          windowTokens: childWindowTokens,
        });
      }
    }

    for (const liveTool of childNode.inFlightTools.values()) {
      if (liveTool.toolName === 'skill' && liveTool.skillId) {
        subagentRecords.push({
          id: liveTool.skillId,
          name: liveTool.skillId,
          scope: 'subagent',
          trigger: 'subagent',
          status: liveTool.status,
          at: liveTool.at,
          turnIndex: effectiveRootTurnIndex,
          compacted: false,
          activationTokens: childWindowTokens,
          windowTokens: childWindowTokens,
          sessionTurnCount: Math.max(1, childNode.parsed?.turnCount ?? 1),
          actor: childNode.agent || 'subagent',
          sessionId: childId,
          directory: liveTool.directory,
          description: liveTool.description,
          preview: liveTool.preview,
          error: liveTool.error,
        });
      }
    }
  }

  const sessionSkills = aggregateScopedSkills({
    scope: 'session',
    records: sessionRecords,
    effectiveRootTurnIndex,
    effectiveRootTurnCount: Math.max(1, effectiveRootTurnCount),
    diskMetadataByDirectory: store.diskMetadata,
    homeDir: store.homeDir,
  });

  const subagentSkills = aggregateScopedSkills({
    scope: 'subagent',
    records: subagentRecords,
    effectiveRootTurnIndex,
    effectiveRootTurnCount: Math.max(1, effectiveRootTurnCount),
    diskMetadataByDirectory: store.diskMetadata,
    homeDir: store.homeDir,
  });

  const subagentActorSet = new Set<string>();
  for (const s of subagentSkills) {
    for (const actor of s.actors) {
      if (actor) subagentActorSet.add(actor);
    }
  }

  return {
    sessionId,
    sseConnected: store.sseConnected,
    contextTokens: rootWindowTokens,
    turnCount: effectiveRootTurnCount,
    subagentCount: descendants.length,
    subagentActors: Array.from(subagentActorSet).slice(0, 8),
    sessionSkills,
    subagentSkills,
  };
};

export type EventSideEffects = {
  onEmitRootSession: (rootSessionId: string) => void;
  onHydrateSession: (sessionId: string, rootSessionId: string) => void;
  onEnrichDirectory?: (directory: string, rootSessionId: string) => void;
  onHeatmapDirty?: () => void;
};

export const applyOpenCodeWireEvent = (
  store: SkillServiceStore,
  payload: unknown,
  effects: EventSideEffects,
  now = Date.now(),
): void => {
  if (!isRecord(payload)) return;
  const type = trimmed(payload.type);
  if (!type) return;

  const data = isRecord(payload.data)
    ? payload.data
    : (isRecord(payload.properties) ? payload.properties : {});
  const info = isRecord(data.info) ? data.info : null;

  const sessionId = trimmed(data.sessionID)
    || (info ? trimmed(info.sessionID) || trimmed(info.id) : '');
  if (!SESSION_ID_PATTERN.test(sessionId)) return;

  const eventAt = typeof payload.created === 'number' && Number.isFinite(payload.created)
    ? payload.created
    : now;

  const node = ensureSessionNode(store, sessionId, now);

  switch (type) {
    case 'session.created':
    case 'session.updated': {
      const target = info ?? data;
      const parentId = trimmed(target.parentID) || null;
      const agent = trimmed(target.agent) || null;
      if (agent) node.agent = agent;
      if (parentId) {
        node.parentId = parentId;
        const newlyLinked = linkChildSession(store, parentId, sessionId);
        if (newlyLinked) {
          const rootId = resolveRootSessionId(store, parentId);
          effects.onHydrateSession(sessionId, rootId);
        }
      }
      break;
    }

    case 'session.step.started': {
      const agent = trimmed(data.agent);
      if (agent) node.agent = agent;
      break;
    }

    case 'session.step.ended':
    case 'session.compaction.ended': {
      const rootId = resolveRootSessionId(store, sessionId);
      if (treeHasAnySkills(store, rootId)) {
        markSessionDirty(node);
        effects.onHydrateSession(sessionId, rootId);
      }
      break;
    }

    case 'session.inbox.enqueued': {
      const inboxId = trimmed(data.inboxID);
      const item = isRecord(data.item) ? data.item : null;
      const itemPayload = item && isRecord(item.payload) ? item.payload : null;
      const skills = itemPayload && Array.isArray(itemPayload.skills) ? itemPayload.skills : [];
      const rootId = resolveRootSessionId(store, sessionId);

      if (inboxId && skills.length > 0) {
        const isSubagent = Boolean(node.parentId);
        const extracted: RawSkillEventRecord[] = [];
        for (const s of skills) {
          if (!isRecord(s)) continue;
          const id = trimmed(s.id) || trimmed(s.name);
          if (!id) continue;
          const rawText = typeof s.text === 'string' ? s.text : null;
          const parsed = parseSkillContent(rawText);
          if (parsed.directory) {
            effects.onEnrichDirectory?.(parsed.directory, rootId);
          }
          extracted.push({
            id,
            name: trimmed(s.name) || parsed.name || id,
            scope: isSubagent ? 'subagent' : 'session',
            trigger: isSubagent ? 'subagent' : 'user',
            status: 'active',
            at: eventAt,
            turnIndex: 0,
            compacted: false,
            activationTokens: null,
            windowTokens: null,
            sessionTurnCount: 1,
            actor: isSubagent ? (node.agent || 'subagent') : 'You',
            sessionId,
            directory: parsed.directory,
            description: parsed.description,
            preview: parsed.preview,
            error: null,
          });
        }
        if (extracted.length > 0) {
          node.enqueuedInboxSkills.set(inboxId, extracted);
          markSessionDirty(node);
          effects.onEmitRootSession(rootId);
        }
      } else if (node.parentId || treeHasAnySkills(store, rootId)) {
        markSessionDirty(node);
        if (node.parentId) {
          effects.onHydrateSession(sessionId, rootId);
        }
      }
      break;
    }

    case 'session.inbox.delivered': {
      const inboxId = trimmed(data.inboxID);
      const hadEnqueued = inboxId ? node.enqueuedInboxSkills.has(inboxId) : false;
      const rootId = resolveRootSessionId(store, sessionId);
      if (hadEnqueued) {
        effects.onHeatmapDirty?.();
      }
      if (hadEnqueued || node.parentId || treeHasAnySkills(store, rootId)) {
        markSessionDirty(node);
        effects.onHydrateSession(sessionId, rootId);
      }
      break;
    }

    case 'session.inbox.cancelled': {
      const inboxId = trimmed(data.inboxID);
      if (inboxId && node.enqueuedInboxSkills.delete(inboxId)) {
        effects.onEmitRootSession(resolveRootSessionId(store, sessionId));
      }
      break;
    }

    case 'session.skill.activated': {
      markSessionDirty(node);
      effects.onHeatmapDirty?.();
      effects.onHydrateSession(sessionId, resolveRootSessionId(store, sessionId));
      break;
    }

    case 'session.tool.input.started': {
      const callId = trimmed(data.id);
      const name = trimmed(data.name);
      if (!callId) break;
      if (name === 'skill') {
        node.inFlightTools.set(callId, {
          callId,
          toolName: 'skill',
          skillId: null,
          childSessionId: null,
          subagentSkills: [],
          subagentActor: null,
          status: 'loading',
          at: eventAt,
          directory: null,
          description: null,
          preview: null,
          error: null,
        });
      } else if (name === 'subagent' || name === 'task') {
        node.inFlightTools.set(callId, {
          callId,
          toolName: 'subagent',
          skillId: null,
          childSessionId: null,
          subagentSkills: [],
          subagentActor: null,
          status: 'loading',
          at: eventAt,
          directory: null,
          description: null,
          preview: null,
          error: null,
        });
      }
      break;
    }

    case 'session.tool.input.ended': {
      const callId = trimmed(data.id);
      const tracked = callId ? node.inFlightTools.get(callId) : undefined;
      if (!tracked || typeof data.text !== 'string') break;
      try {
        const parsedInput = JSON.parse(data.text);
        if (!isRecord(parsedInput)) break;
        if (tracked.toolName === 'skill') {
          const skillId = trimmed(parsedInput.id) || trimmed(parsedInput.name);
          if (skillId && skillId !== tracked.skillId) {
            tracked.skillId = skillId;
            effects.onEmitRootSession(resolveRootSessionId(store, sessionId));
          }
        } else if (tracked.toolName === 'subagent') {
          const rawSkills = Array.isArray(parsedInput.skills)
            ? parsedInput.skills
            : (Array.isArray(parsedInput.load_skills) ? parsedInput.load_skills : []);
          const names = rawSkills.map((s) => trimmed(s)).filter(Boolean);
          if (names.length > 0) {
            tracked.subagentSkills = names;
            tracked.subagentActor = trimmed(parsedInput.agent) || trimmed(parsedInput.category) || 'subagent';
            effects.onEmitRootSession(resolveRootSessionId(store, sessionId));
          }
        }
      } catch {
        // Ignore partial or malformed JSON
      }
      break;
    }

    case 'session.tool.called': {
      const callId = trimmed(data.id);
      const input = isRecord(data.input) ? data.input : {};
      const tracked = callId ? node.inFlightTools.get(callId) : undefined;
      if (tracked) {
        if (tracked.toolName === 'skill') {
          const skillId = trimmed(input.id) || trimmed(input.name);
          if (skillId) {
            tracked.skillId = skillId;
            effects.onEmitRootSession(resolveRootSessionId(store, sessionId));
          }
        } else if (tracked.toolName === 'subagent') {
          const rawSkills = Array.isArray(input.skills)
            ? input.skills
            : (Array.isArray(input.load_skills) ? input.load_skills : []);
          const names = rawSkills.map((s) => trimmed(s)).filter(Boolean);
          if (names.length > 0) {
            tracked.subagentSkills = names;
            tracked.subagentActor = trimmed(input.agent) || trimmed(input.category) || 'subagent';
            effects.onEmitRootSession(resolveRootSessionId(store, sessionId));
          }
        }
      }
      break;
    }

    case 'session.tool.progress': {
      const callId = trimmed(data.id);
      const metadata = isRecord(data.metadata) ? data.metadata : {};
      const childSessionId = trimmed(metadata.sessionID) || trimmed(metadata.sessionId);
      if (SESSION_ID_PATTERN.test(childSessionId)) {
        const tracked = callId ? node.inFlightTools.get(callId) : undefined;
        if (tracked) {
          tracked.childSessionId = childSessionId;
        }
        const kid = ensureSessionNode(store, childSessionId, now);
        if (!kid.parentId) kid.parentId = sessionId;
        if (linkChildSession(store, sessionId, childSessionId)) {
          const rootId = resolveRootSessionId(store, sessionId);
          effects.onHydrateSession(childSessionId, rootId);
        }
      }
      break;
    }

    case 'session.tool.success': {
      const callId = trimmed(data.id);
      const metadata = isRecord(data.metadata) ? data.metadata : {};
      const tracked = callId ? node.inFlightTools.get(callId) : undefined;
      const fromContent = extractSkillTagNameFromToolContent(data.content);
      const rootId = resolveRootSessionId(store, sessionId);

      if (tracked?.toolName === 'skill' || fromContent.id) {
        const parsed = parseSkillContent(fromContent.rawText);
        const skillId = trimmed(metadata.name) || tracked?.skillId || fromContent.id;
        const directory = trimmed(metadata.directory) || parsed.directory || null;
        if (skillId && callId) {
          node.inFlightTools.set(callId, {
            callId,
            toolName: 'skill',
            skillId,
            childSessionId: null,
            subagentSkills: [],
            subagentActor: null,
            status: 'active',
            at: eventAt,
            directory,
            description: parsed.description,
            preview: parsed.preview,
            error: null,
          });
        }
        if (directory) {
          effects.onEnrichDirectory?.(directory, rootId);
        }
        markSessionDirty(node);
        effects.onHeatmapDirty?.();
        effects.onEmitRootSession(rootId);
        effects.onHydrateSession(sessionId, rootId);
        break;
      }

      const childSessionId = trimmed(metadata.sessionID) || trimmed(metadata.sessionId);
      if (tracked?.toolName === 'subagent' || SESSION_ID_PATTERN.test(childSessionId)) {
        if (callId) node.inFlightTools.delete(callId);
        markSessionDirty(node);
        if (SESSION_ID_PATTERN.test(childSessionId)) {
          const kid = ensureSessionNode(store, childSessionId, now);
          if (!kid.parentId) kid.parentId = sessionId;
          linkChildSession(store, sessionId, childSessionId);
          effects.onHydrateSession(childSessionId, rootId);
        }
        effects.onHydrateSession(sessionId, rootId);
      }
      break;
    }

    case 'session.tool.failed': {
      const callId = trimmed(data.id);
      const tracked = callId ? node.inFlightTools.get(callId) : undefined;
      if (!tracked) break;
      const rootId = resolveRootSessionId(store, sessionId);
      if (tracked.toolName === 'skill' && tracked.skillId) {
        const errObj = isRecord(data.error) ? data.error : null;
        const rawErr = (errObj ? trimmed(errObj.message) : trimmed(data.error)) || `Failed to load ${tracked.skillId}`;
        tracked.status = 'failed';
        tracked.error = rawErr.slice(0, 400);
        markSessionDirty(node);
        effects.onHeatmapDirty?.();
        effects.onEmitRootSession(rootId);
        effects.onHydrateSession(sessionId, rootId);
      } else {
        node.inFlightTools.delete(callId);
        effects.onEmitRootSession(rootId);
      }
      break;
    }

    case 'session.idle':
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted': {
      const rootId = resolveRootSessionId(store, sessionId);
      if (node.inFlightTools.size > 0 || node.dirty || treeHasAnySkills(store, rootId)) {
        markSessionDirty(node);
        effects.onHydrateSession(sessionId, rootId);
      }
      break;
    }

    default:
      break;
  }
};

const connectEventStream = (
  store: SkillServiceStore,
  opencodeUrl: string,
  token: string,
  effects: EventSideEffects,
): { stop: () => void } => {
  let stopped = false;
  let activeController: AbortController | null = null;
  let backoffMs = 1_000;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      activeController = new AbortController();
      try {
        const res = await fetch(`${opencodeUrl}/api/event`, {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          signal: activeController.signal,
        });

        if (!res.ok || !res.body) {
          store.sseConnected = false;
          await new Promise((r) => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 15_000);
          continue;
        }

        store.sseConnected = true;
        backoffMs = 1_000;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let dataLines: string[] = [];

        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIdx = buffer.indexOf('\n');
          while (newlineIdx !== -1) {
            const rawLine = buffer.slice(0, newlineIdx).replace(/\r$/, '');
            buffer = buffer.slice(newlineIdx + 1);

            if (rawLine === '') {
              if (dataLines.length > 0) {
                const payloadText = dataLines.join('\n');
                dataLines = [];
                try {
                  const parsed = JSON.parse(payloadText);
                  applyOpenCodeWireEvent(store, parsed, effects, Date.now());
                } catch {
                  // Ignore malformed SSE frame
                }
              }
            } else if (rawLine.startsWith('data:')) {
              dataLines.push(rawLine.slice(5).trimStart());
            }

            newlineIdx = buffer.indexOf('\n');
          }
        }
      } catch {
        store.sseConnected = false;
      }

      store.sseConnected = false;
      if (stopped) break;
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 15_000);
    }
  };

  void loop();

  return {
    stop: () => {
      stopped = true;
      activeController?.abort();
    },
  };
};

export type StartServerOptions = {
  port: number;
  token: string;
  opencodeUrl?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
  dbPath?: string | null;
  dataDir?: string | null;
  extraSkillRoots?: readonly string[];
  extraConfigPaths?: readonly string[];
};

const parseHeatmapWindow = (raw: string | null): SkillHeatmapWindow => {
  if (raw === '8w' || raw === '16w' || raw === 'all') return raw;
  return '16w';
};

const parseHeatmapScope = (raw: string | null): SkillHeatmapScopeFilter => {
  if (raw === 'all' || raw === 'direct' || raw === 'subagent') return raw;
  return 'all';
};

export const startServer = (options?: StartServerOptions): {
  server: http.Server;
  store: SkillServiceStore;
  close: () => Promise<void>;
} | null => {
  const env = options?.env ?? process.env;
  const port = options?.port ?? Number(env.OPENCHAMBER_SERVICE_PORT);
  const token = options?.token ?? env.OPENCHAMBER_SERVICE_TOKEN;
  if (!port || !token) return null;

  const opencodeUrl = (options?.opencodeUrl ?? env.OPENCHAMBER_OPENCODE_URL ?? '').replace(/\/+$/, '');
  const host: ServiceHost = createServiceHost({ env });
  const homeDir = options?.homeDir === undefined ? (os.homedir() || null) : options.homeDir;
  const store = createSkillServiceStore(homeDir);
  const heatmapStore = createHeatmapStore({
    homeDir,
    dbPath: options?.dbPath,
    dataDir: options?.dataDir !== undefined
      ? options.dataDir
      : (env.OPENCHAMBER_SERVICE_DATA_DIR?.trim() || null),
    extraSkillRoots: options?.extraSkillRoots,
    extraConfigPaths: options?.extraConfigPaths,
    opencodeUrl: opencodeUrl || undefined,
    serviceToken: token,
  });
  let heatmapEmitTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleEmit = (rootSessionId: string): void => {
    if (!rootSessionId || store.emitTimers.has(rootSessionId)) return;
    const timer = setTimeout(() => {
      store.emitTimers.delete(rootSessionId);
      void host.emit(SKILLS_UPDATED_TOPIC, { sessionId: rootSessionId }).catch(() => {});
    }, EMIT_DEBOUNCE_MS);
    store.emitTimers.set(rootSessionId, timer);
  };

  const scheduleHeatmapEmit = (): void => {
    heatmapStore.invalidate();
    if (heatmapEmitTimer) return;
    heatmapEmitTimer = setTimeout(() => {
      heatmapEmitTimer = null;
      void host.emit(HEATMAP_UPDATED_TOPIC, { at: Date.now() }).catch(() => {});
    }, EMIT_DEBOUNCE_MS * 4);
  };

  const effects: EventSideEffects = {
    onEmitRootSession: scheduleEmit,
    onHydrateSession: (targetSessionId, rootSessionId) => {
      if (!opencodeUrl) return;
      void hydrateSingleSession(store, opencodeUrl, token, targetSessionId)
        .then(() => {
          scheduleEmit(resolveRootSessionId(store, targetSessionId) || rootSessionId);
        })
        .catch(() => {});
    },
    onEnrichDirectory: (directory, rootSessionId) => {
      void enrichSkillMetadataFromDisk(store, directory)
        .then(() => scheduleEmit(rootSessionId))
        .catch(() => {});
    },
    onHeatmapDirty: scheduleHeatmapEmit,
  };

  const streamHandle = opencodeUrl ? connectEventStream(store, opencodeUrl, token, effects) : null;

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && reqUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/heatmap') {
      const windowParam = parseHeatmapWindow(reqUrl.searchParams.get('window'));
      const scopeParam = parseHeatmapScope(reqUrl.searchParams.get('scope'));
      const projectParam = reqUrl.searchParams.get('project')?.trim() || null;
      const directoryParam = reqUrl.searchParams.get('directory')?.trim() || null;
      const refreshParam = reqUrl.searchParams.get('refresh') === '1' || reqUrl.searchParams.get('refresh') === 'true';

      heatmapStore.query({
        window: windowParam,
        scope: scopeParam,
        project: projectParam,
        directory: directoryParam,
        refresh: refreshParam,
      }).then((payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
      }).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ error: 'Failed to build skill usage heatmap.' }),
        );
      });
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/skills') {
      const sessionId = reqUrl.searchParams.get('sessionId')?.trim() ?? '';
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ error: 'Provide a valid sessionId query parameter.' }),
        );
        return;
      }

      if (!opencodeUrl) {
        res.writeHead(503, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ error: 'OpenCode connection is unavailable.' }),
        );
        return;
      }

      const answerSkills = async (): Promise<void> => {
        await hydrateSessionTree(store, opencodeUrl, token, sessionId);
        const rootNode = store.sessions.get(sessionId);
        const payload = buildSessionSkillsResponse(store, sessionId);
        if (
          !rootNode
          || (rootNode.hydratedAt === null
            && payload.sessionSkills.length === 0
            && payload.subagentSkills.length === 0)
        ) {
          res.writeHead(502, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ error: 'Failed to read session messages from OpenCode.' }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
      };

      answerSkills().catch(() => {
        res.writeHead(502, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ error: 'Failed to read session messages from OpenCode.' }),
        );
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '127.0.0.1');

  return {
    server,
    store,
    close: () => new Promise<void>((resolve) => {
      streamHandle?.stop();
      if (heatmapEmitTimer) {
        clearTimeout(heatmapEmitTimer);
        heatmapEmitTimer = null;
      }
      for (const timer of store.emitTimers.values()) {
        clearTimeout(timer);
      }
      store.emitTimers.clear();
      server.close(() => resolve());
    }),
  };
};

if (process.env.OPENCHAMBER_SERVICE_PORT && process.env.OPENCHAMBER_SERVICE_TOKEN) {
  startServer();
}
