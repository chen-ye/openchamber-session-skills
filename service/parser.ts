import type {
  SessionSkillSummary,
  SkillContextDepth,
  SkillScope,
  SkillStatus,
  SkillTrigger,
} from '../shared/types.ts';

export type ParsedSkillContent = {
  readonly name: string | null;
  readonly directory: string | null;
  readonly description: string | null;
  readonly preview: string | null;
};

export type RawSkillEventRecord = {
  readonly id: string;
  readonly name: string;
  readonly scope: SkillScope;
  readonly trigger: SkillTrigger;
  readonly status: SkillStatus;
  readonly at: number;
  readonly turnIndex: number;
  readonly compacted: boolean;
  readonly activationTokens: number | null;
  readonly windowTokens: number | null;
  readonly sessionTurnCount: number;
  readonly actor: string | null;
  readonly sessionId: string;
  readonly directory: string | null;
  readonly description: string | null;
  readonly preview: string | null;
  readonly error: string | null;
};

export type PendingSubagentSkillHandoff = {
  readonly childSessionId: string | null;
  readonly skills: readonly string[];
  readonly actor: string;
  readonly at: number;
  readonly parentTurnIndex: number;
  readonly status: 'loading' | 'completed';
};

export type TurnWindowSpan = {
  readonly turnIndex: number;
  readonly startedAt: number;
};

export type ParsedSessionMessages = {
  readonly sessionId: string;
  readonly isSubagent: boolean;
  readonly hasUserMessage: boolean;
  readonly currentTurnIndex: number;
  readonly turnCount: number;
  readonly lastTurnEndedIdle: boolean;
  readonly latestTurnHasAssistant: boolean;
  readonly turns: readonly TurnWindowSpan[];
  readonly childSpawnTurnBySessionId: ReadonlyMap<string, number>;
  readonly latestWindowTokens: number | null;
  readonly persistedMessageIds: ReadonlySet<string>;
  readonly terminalToolCallIds: ReadonlySet<string>;
  readonly records: readonly RawSkillEventRecord[];
  readonly discoveredChildSessionIds: readonly string[];
  readonly subagentHandoffs: readonly PendingSubagentSkillHandoff[];
};

export type DiskSkillMetadata = {
  readonly description: string | null;
  readonly preview: string | null;
};

const MAX_DESCRIPTION_CHARS = 220;
const MAX_PREVIEW_CHARS = 1_500;
const MAX_ERROR_CHARS = 400;
const MAX_ACTORS = 16;

export const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const trimmed = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

export const clampUnit = (value: number, min = 0.04, max = 1): number => (
  Math.max(min, Math.min(max, value))
);

export const formatDisplayPath = (rawPath: string | null, homeDir: string | null): string | null => {
  if (!rawPath) return null;
  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  if (homeDir) {
    const cleanHome = homeDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (cleanHome && normalized === cleanHome) return '~';
    if (cleanHome && normalized.startsWith(`${cleanHome}/`)) {
      return `~/${normalized.slice(cleanHome.length + 1)}`;
    }
  }
  return normalized;
};

const unquoteYamlScalar = (raw: string): string => {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim();
  }
  return s;
};

const parseFrontmatter = (markdown: string): {
  readonly name: string | null;
  readonly description: string | null;
  readonly body: string;
} => {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { name: null, description: null, body: normalized };
  }
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    return { name: null, description: null, body: normalized };
  }

  const headerLines = normalized.slice(4, endIdx).split('\n');
  const body = normalized.slice(endIdx + 5);

  let name: string | null = null;
  let description: string | null = null;
  let blockKey: 'description' | null = null;
  const blockLines: string[] = [];

  for (const line of headerLines) {
    if (blockKey) {
      if (/^[ \t]+\S/.test(line)) {
        blockLines.push(line.trim());
        continue;
      }
      if (line.trim() === '') {
        continue;
      }
      description = blockLines.join(' ').trim() || description;
      blockKey = null;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rest = (match[2] ?? '').trim();

    if (key === 'name' && rest) {
      name = unquoteYamlScalar(rest) || null;
    } else if (key === 'description') {
      if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-' || rest === '') {
        blockKey = 'description';
        blockLines.length = 0;
      } else {
        description = unquoteYamlScalar(rest) || null;
      }
    }
  }

  if (blockKey && blockLines.length > 0) {
    description = blockLines.join(' ').trim() || description;
  }

  return { name, description, body };
};

const truncateClean = (text: string, maxChars: number): string => {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1).trimEnd()}…`;
};

const extractFirstSummaryParagraph = (body: string): {
  readonly summary: string | null;
  readonly remainder: string;
} => {
  const lines = body.split('\n');
  const paragraph: string[] = [];
  let inFence = false;
  let endLineIdx = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line.startsWith('```')) {
      if (paragraph.length > 0) {
        endLineIdx = i;
        break;
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) {
      if (paragraph.length > 0) {
        endLineIdx = i + 1;
        break;
      }
      continue;
    }
    if (line.startsWith('#') || line.startsWith('|') || line.startsWith('---')) {
      if (paragraph.length > 0) {
        endLineIdx = i;
        break;
      }
      continue;
    }
    paragraph.push(line);
    if (paragraph.join(' ').length >= MAX_DESCRIPTION_CHARS) {
      endLineIdx = i + 1;
      break;
    }
  }

  if (paragraph.length === 0) {
    return { summary: null, remainder: body };
  }
  const joined = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  const rest = endLineIdx === -1 ? '' : lines.slice(endLineIdx).join('\n').trim();
  return {
    summary: joined ? truncateClean(joined, MAX_DESCRIPTION_CHARS) : null,
    remainder: rest,
  };
};

export const parseSkillContent = (rawText: string | null | undefined): ParsedSkillContent => {
  if (!rawText || typeof rawText !== 'string') {
    return { name: null, directory: null, description: null, preview: null };
  }

  let working = rawText.replace(/\r\n/g, '\n');

  let tagName: string | null = null;
  const openTagMatch = /<skill_content(?:\s+name="([^"]+)")?\s*>/i.exec(working);
  if (openTagMatch) {
    tagName = trimmed(openTagMatch[1]) || null;
    const startIdx = openTagMatch.index + openTagMatch[0].length;
    const closeIdx = working.indexOf('</skill_content>', startIdx);
    working = closeIdx !== -1 ? working.slice(startIdx, closeIdx) : working.slice(startIdx);
  }

  working = working.replace(/<skill_files>[\s\S]*?<\/skill_files>/gi, '');

  let directory: string | null = null;
  const baseDirMatch = /^Base directory for this skill:\s*(.+)$/m.exec(working);
  if (baseDirMatch) {
    directory = trimmed(baseDirMatch[1]) || null;
    working = working
      .replace(/^Base directory for this skill:\s*.+$/gm, '')
      .replace(/^Relative paths in this skill.*$/gm, '')
      .replace(/^Note:\s*file list is sampled\.\s*$/gm, '');
  }

  const { name: fmName, description: fmDesc, body: afterFm } = parseFrontmatter(working.trim());

  let cleanBody = afterFm.trim();
  let headingSkillName: string | null = null;
  const skillHeaderMatch = /^#\s+Skill:\s+([^\n]+)\n+/i.exec(cleanBody);
  if (skillHeaderMatch) {
    headingSkillName = trimmed(skillHeaderMatch[1]) || null;
    cleanBody = cleanBody.slice(skillHeaderMatch[0].length).trim();
  }

  let description: string | null = null;
  let previewSource = cleanBody;

  if (fmDesc) {
    description = truncateClean(fmDesc.replace(/\s+/g, ' '), MAX_DESCRIPTION_CHARS);
  } else {
    const extracted = extractFirstSummaryParagraph(cleanBody);
    description = extracted.summary;
    previewSource = extracted.remainder;
  }

  const preview = previewSource ? truncateClean(previewSource, MAX_PREVIEW_CHARS) : null;

  return {
    name: fmName || headingSkillName || tagName,
    directory,
    description,
    preview,
  };
};

export const extractSkillTagNameFromToolContent = (content: unknown): {
  readonly id: string | null;
  readonly rawText: string | null;
} => {
  if (!Array.isArray(content)) return { id: null, rawText: null };
  for (const part of content) {
    if (!isRecord(part) || trimmed(part.type) !== 'text') continue;
    const text = typeof part.text === 'string' ? part.text : '';
    const m = /<skill_content\s+name="([^"]+)"/i.exec(text);
    if (m?.[1]) {
      return { id: m[1].trim(), rawText: text };
    }
    if (text) {
      return { id: null, rawText: text };
    }
  }
  return { id: null, rawText: null };
};

export const extractInjectedSubagentSkills = (text: string): ReadonlyArray<{
  readonly id: string;
  readonly rawSection: string;
}> => {
  const normalized = text.replace(/\r\n/g, '\n');
  const pattern = /^\[SKILL:\s*([A-Za-z0-9_.:-]+)\][ \t]*\n/gm;
  const matches: Array<{ id: string; contentStart: number; matchStart: number }> = [];

  let m = pattern.exec(normalized);
  while (m !== null) {
    const id = trimmed(m[1]);
    if (id) {
      matches.push({
        id,
        matchStart: m.index,
        contentStart: m.index + m[0].length,
      });
    }
    m = pattern.exec(normalized);
  }

  if (matches.length === 0) return [];

  return matches.map((entry, idx) => {
    const nextMatch = matches[idx + 1];
    let sliceEnd = nextMatch ? nextMatch.matchStart : Math.min(normalized.length, entry.contentStart + 3_000);
    if (!nextMatch) {
      const taskBoundary = normalized.indexOf('\n1. TASK\n', entry.contentStart);
      if (taskBoundary !== -1 && taskBoundary < sliceEnd) {
        sliceEnd = taskBoundary;
      }
    }
    return {
      id: entry.id,
      rawSection: normalized.slice(entry.contentStart, sliceEnd).trim(),
    };
  });
};

const readMessageCreatedTimestamp = (msg: Record<string, unknown>, fallback: number): number => {
  const time = isRecord(msg.time) ? msg.time : null;
  if (time && typeof time.created === 'number' && Number.isFinite(time.created)) {
    return time.created;
  }
  return fallback;
};

const readMessageTimestamp = (msg: Record<string, unknown>, fallback: number): number => {
  const time = isRecord(msg.time) ? msg.time : null;
  if (time) {
    if (typeof time.completed === 'number' && Number.isFinite(time.completed)) return time.completed;
    if (typeof time.created === 'number' && Number.isFinite(time.created)) return time.created;
  }
  return fallback;
};

const parseToolInputObject = (rawInput: unknown): Record<string, unknown> => {
  if (isRecord(rawInput)) return rawInput;
  if (typeof rawInput === 'string' && rawInput.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(rawInput);
      if (isRecord(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
};

type StepTokenWatermark = {
  readonly msgIdx: number;
  readonly promptTokens: number;
  readonly endWatermark: number;
};

const extractAssistantStepTokens = (msg: Record<string, unknown>): {
  readonly promptTokens: number;
  readonly endWatermark: number;
} | null => {
  const tokens = isRecord(msg.tokens) ? msg.tokens : null;
  if (!tokens) return null;
  const input = typeof tokens.input === 'number' && Number.isFinite(tokens.input) ? Math.max(0, tokens.input) : 0;
  const output = typeof tokens.output === 'number' && Number.isFinite(tokens.output) ? Math.max(0, tokens.output) : 0;
  const cache = isRecord(tokens.cache) ? tokens.cache : null;
  const cacheRead = cache && typeof cache.read === 'number' && Number.isFinite(cache.read) ? Math.max(0, cache.read) : 0;
  const cacheWrite = cache && typeof cache.write === 'number' && Number.isFinite(cache.write) ? Math.max(0, cache.write) : 0;
  const promptTokens = input + cacheRead + cacheWrite;
  if (promptTokens <= 0) return null;
  return {
    promptTokens,
    endWatermark: promptTokens + output,
  };
};

export const parseSessionMessages = (params: {
  readonly sessionId: string;
  readonly isSubagent: boolean;
  readonly defaultAgent: string | null;
  readonly messages: readonly unknown[];
}): ParsedSessionMessages => {
  const { sessionId, isSubagent, defaultAgent, messages } = params;
  const scope: SkillScope = isSubagent ? 'subagent' : 'session';
  const records: RawSkillEventRecord[] = [];
  const childIds = new Set<string>();
  const childSpawnTurnBySessionId = new Map<string, number>();
  const persistedMessageIds = new Set<string>();
  const terminalToolCallIds = new Set<string>();
  const subagentHandoffs: PendingSubagentSkillHandoff[] = [];
  let hasUserMessage = false;

  // Pass 1: Determine completed compaction boundary, turn indices, and post-compaction token watermarks
  let lastCompactionIdx = -1;
  let lastTurnOpenMsgIdx = -1;
  const messageTurnIndices = new Array<number>(messages.length).fill(0);
  const turns: TurnWindowSpan[] = [];
  let turnIndex = -1;
  let waitingNewTurn = true;
  let turnHasAssistant = false;

  for (let idx = 0; idx < messages.length; idx += 1) {
    const raw = messages[idx];
    if (!isRecord(raw)) continue;
    const msgType = trimmed(raw.type);
    const createdAt = readMessageCreatedTimestamp(raw, idx + 1);

    if (msgType === 'compaction' && trimmed(raw.status) === 'completed') {
      lastCompactionIdx = idx;
      waitingNewTurn = true;
      turnHasAssistant = false;
      messageTurnIndices[idx] = Math.max(0, turnIndex);
      continue;
    }

    if (msgType === 'idle') {
      waitingNewTurn = true;
      turnHasAssistant = false;
      messageTurnIndices[idx] = Math.max(0, turnIndex);
      continue;
    }

    if (msgType === 'user') {
      if (waitingNewTurn || turnHasAssistant) {
        turnIndex += 1;
        lastTurnOpenMsgIdx = idx;
        turns.push({ turnIndex, startedAt: createdAt });
        waitingNewTurn = false;
        turnHasAssistant = false;
      }
    } else if (msgType === 'synthetic' || msgType === 'skill') {
      if (waitingNewTurn) {
        turnIndex += 1;
        lastTurnOpenMsgIdx = idx;
        turns.push({ turnIndex, startedAt: createdAt });
        waitingNewTurn = false;
        turnHasAssistant = false;
      }
    } else if (msgType === 'assistant') {
      if (waitingNewTurn) {
        turnIndex += 1;
        lastTurnOpenMsgIdx = idx;
        turns.push({ turnIndex, startedAt: createdAt });
        waitingNewTurn = false;
      }
      turnHasAssistant = true;
    }

    messageTurnIndices[idx] = Math.max(0, turnIndex);
  }

  // If a completed compaction occurred after the latest turn, advance into the post-compaction turn slot
  const postCompactionAwaitingTurn = lastCompactionIdx > lastTurnOpenMsgIdx && turnIndex >= 0;
  const currentTurnIndex = postCompactionAwaitingTurn
    ? turnIndex + 1
    : Math.max(0, turnIndex);
  const turnCount = turnIndex >= 0
    ? (postCompactionAwaitingTurn ? turnIndex + 2 : turnIndex + 1)
    : 0;

  const postCompactionSteps: StepTokenWatermark[] = [];
  for (let idx = lastCompactionIdx + 1; idx < messages.length; idx += 1) {
    const raw = messages[idx];
    if (!isRecord(raw) || trimmed(raw.type) !== 'assistant') continue;
    const stepTok = extractAssistantStepTokens(raw);
    if (stepTok) {
      postCompactionSteps.push({
        msgIdx: idx,
        promptTokens: stepTok.promptTokens,
        endWatermark: stepTok.endWatermark,
      });
    }
  }

  const latestWindowTokens = postCompactionSteps.at(-1)?.endWatermark ?? null;

  const resolveActivationWatermark = (msgIdx: number): {
    readonly compacted: boolean;
    readonly activationTokens: number | null;
    readonly windowTokens: number | null;
  } => {
    if (msgIdx < lastCompactionIdx) {
      return { compacted: true, activationTokens: null, windowTokens: null };
    }
    if (latestWindowTokens === null) {
      return { compacted: false, activationTokens: null, windowTokens: null };
    }
    const firstStepAfter = postCompactionSteps.find((s) => s.msgIdx > msgIdx);
    const activationTokens = firstStepAfter
      ? Math.min(latestWindowTokens, firstStepAfter.endWatermark)
      : latestWindowTokens;
    return {
      compacted: false,
      activationTokens,
      windowTokens: latestWindowTokens,
    };
  };

  // Pass 2: Extract skill activations & subagent links
  for (let idx = 0; idx < messages.length; idx += 1) {
    const raw = messages[idx];
    if (!isRecord(raw)) continue;
    const msgId = trimmed(raw.id);
    if (msgId) persistedMessageIds.add(msgId);
    const msgType = trimmed(raw.type);
    const msgAt = readMessageTimestamp(raw, idx + 1);
    const msgTurn = messageTurnIndices[idx] ?? 0;
    const wm = resolveActivationWatermark(idx);

    if (msgType === 'user') {
      hasUserMessage = true;

      if (Array.isArray(raw.skills)) {
        for (const attachment of raw.skills) {
          if (!isRecord(attachment)) continue;
          const id = trimmed(attachment.id) || trimmed(attachment.name);
          if (!id) continue;
          const rawText = typeof attachment.text === 'string' ? attachment.text : null;
          const parsed = parseSkillContent(rawText);
          records.push({
            id,
            name: trimmed(attachment.name) || parsed.name || id,
            scope,
            trigger: isSubagent ? 'subagent' : 'user',
            status: 'active',
            at: msgAt,
            turnIndex: msgTurn,
            compacted: wm.compacted,
            activationTokens: wm.activationTokens,
            windowTokens: wm.windowTokens,
            sessionTurnCount: Math.max(1, turnCount),
            actor: isSubagent ? (defaultAgent || 'subagent') : 'You',
            sessionId,
            directory: parsed.directory,
            description: parsed.description,
            preview: parsed.preview,
            error: null,
          });
        }
      }

      if (isSubagent && typeof raw.text === 'string' && raw.text.includes('[SKILL:')) {
        const injected = extractInjectedSubagentSkills(raw.text);
        for (const item of injected) {
          const parsed = parseSkillContent(item.rawSection);
          records.push({
            id: item.id,
            name: parsed.name || item.id,
            scope: 'subagent',
            trigger: 'subagent',
            status: 'active',
            at: msgAt,
            turnIndex: msgTurn,
            compacted: wm.compacted,
            activationTokens: wm.activationTokens,
            windowTokens: wm.windowTokens,
            sessionTurnCount: Math.max(1, turnCount),
            actor: defaultAgent || 'subagent',
            sessionId,
            directory: parsed.directory,
            description: parsed.description,
            preview: parsed.preview,
            error: null,
          });
        }
      }
      continue;
    }

    if (msgType === 'skill') {
      const id = trimmed(raw.skill) || trimmed(raw.name);
      if (!id) continue;
      const rawText = typeof raw.text === 'string' ? raw.text : null;
      const parsed = parseSkillContent(rawText);
      records.push({
        id,
        name: trimmed(raw.name) || parsed.name || id,
        scope,
        trigger: isSubagent ? 'subagent' : 'user',
        status: 'active',
        at: msgAt,
        turnIndex: msgTurn,
        compacted: wm.compacted,
        activationTokens: wm.activationTokens,
        windowTokens: wm.windowTokens,
        sessionTurnCount: Math.max(1, turnCount),
        actor: isSubagent ? (defaultAgent || 'subagent') : 'You',
        sessionId,
        directory: parsed.directory,
        description: parsed.description,
        preview: parsed.preview,
        error: null,
      });
      continue;
    }

    if (msgType === 'assistant') {
      const msgAgent = trimmed(raw.agent) || defaultAgent || null;
      const content = Array.isArray(raw.content) ? raw.content : [];

      for (const part of content) {
        if (!isRecord(part) || trimmed(part.type) !== 'tool') continue;
        const callId = trimmed(part.id);
        const toolName = trimmed(part.name);
        const state = isRecord(part.state) ? part.state : {};
        const statusRaw = trimmed(state.status);
        if (callId && (statusRaw === 'completed' || statusRaw === 'error')) {
          terminalToolCallIds.add(callId);
        }
        const input = parseToolInputObject(state.input);
        const metadata = isRecord(state.metadata) ? state.metadata : {};
        const partAt = readMessageTimestamp(part, msgAt);

        if (toolName === 'skill') {
          const fromContent = extractSkillTagNameFromToolContent(state.content);
          const id = trimmed(metadata.name)
            || trimmed(input.id)
            || trimmed(input.name)
            || fromContent.id
            || '';
          if (!id) continue;

          const parsed = parseSkillContent(fromContent.rawText);
          const directory = trimmed(metadata.directory) || parsed.directory || null;
          const trigger: SkillTrigger = isSubagent ? 'subagent' : 'agent';

          if (statusRaw === 'completed') {
            records.push({
              id,
              name: parsed.name || trimmed(metadata.name) || id,
              scope,
              trigger,
              status: 'active',
              at: partAt,
              turnIndex: msgTurn,
              compacted: wm.compacted,
              activationTokens: wm.activationTokens,
              windowTokens: wm.windowTokens,
              sessionTurnCount: Math.max(1, turnCount),
              actor: msgAgent,
              sessionId,
              directory,
              description: parsed.description,
              preview: parsed.preview,
              error: null,
            });
          } else if (statusRaw === 'error') {
            const errObj = isRecord(state.error) ? state.error : null;
            const rawErr = (errObj ? trimmed(errObj.message) : trimmed(state.error)) || `Failed to load ${id}`;
            records.push({
              id,
              name: id,
              scope,
              trigger,
              status: 'failed',
              at: partAt,
              turnIndex: msgTurn,
              compacted: wm.compacted,
              activationTokens: null,
              windowTokens: wm.windowTokens,
              sessionTurnCount: Math.max(1, turnCount),
              actor: msgAgent,
              sessionId,
              directory,
              description: null,
              preview: null,
              error: truncateClean(rawErr, MAX_ERROR_CHARS),
            });
          } else if (statusRaw === 'pending' || statusRaw === 'running' || statusRaw === 'streaming') {
            records.push({
              id,
              name: id,
              scope,
              trigger,
              status: 'loading',
              at: partAt,
              turnIndex: msgTurn,
              compacted: false,
              activationTokens: latestWindowTokens,
              windowTokens: latestWindowTokens,
              sessionTurnCount: Math.max(1, turnCount),
              actor: msgAgent,
              sessionId,
              directory,
              description: null,
              preview: null,
              error: null,
            });
          }
          continue;
        }

        if (toolName === 'subagent' || toolName === 'task') {
          const childSessionId = trimmed(metadata.sessionID) || trimmed(metadata.sessionId) || null;
          if (childSessionId && /^ses_[\w-]+$/.test(childSessionId)) {
            childIds.add(childSessionId);
            if (!childSpawnTurnBySessionId.has(childSessionId)) {
              childSpawnTurnBySessionId.set(childSessionId, msgTurn);
            }
          }

          if (statusRaw === 'error') continue;
          const rawSkills = Array.isArray(input.skills)
            ? input.skills
            : (Array.isArray(input.load_skills) ? input.load_skills : []);
          const skillNames = rawSkills.map((s) => trimmed(s)).filter(Boolean);
          if (skillNames.length > 0) {
            const subagentActor = trimmed(input.agent) || trimmed(input.category) || 'subagent';
            subagentHandoffs.push({
              childSessionId,
              skills: skillNames,
              actor: subagentActor,
              at: partAt,
              parentTurnIndex: msgTurn,
              status: statusRaw === 'completed' ? 'completed' : 'loading',
            });
          }
        }
      }
    }
  }

  return {
    sessionId,
    isSubagent,
    hasUserMessage,
    currentTurnIndex,
    turnCount,
    lastTurnEndedIdle: waitingNewTurn,
    latestTurnHasAssistant: turnHasAssistant,
    turns,
    childSpawnTurnBySessionId,
    latestWindowTokens,
    persistedMessageIds,
    terminalToolCallIds,
    records,
    discoveredChildSessionIds: Array.from(childIds),
    subagentHandoffs,
  };
};

export const mapTimestampToParentTurn = (params: {
  readonly at: number;
  readonly rootTurns: readonly TurnWindowSpan[];
  readonly rootCurrentTurnIndex: number;
  readonly minTurnIndex?: number;
}): number => {
  const { at, rootTurns, rootCurrentTurnIndex, minTurnIndex = 0 } = params;
  if (rootTurns.length === 0) return Math.max(0, minTurnIndex);
  let matched = rootTurns[0]?.turnIndex ?? 0;
  for (const span of rootTurns) {
    if (span.startedAt <= at) {
      matched = span.turnIndex;
    } else {
      break;
    }
  }
  return Math.max(minTurnIndex, Math.min(rootCurrentTurnIndex, matched));
};

const computeRecordDepth = (params: {
  readonly rec: RawSkillEventRecord;
  readonly effectiveRootTurnIndex: number;
  readonly effectiveRootTurnCount: number;
}): SkillContextDepth => {
  const { rec, effectiveRootTurnIndex, effectiveRootTurnCount } = params;
  const turnsAgo = Math.max(0, effectiveRootTurnIndex - rec.turnIndex);

  if (rec.compacted) {
    return {
      compacted: true,
      turnsAgo: Math.max(1, turnsAgo),
      tokensAgo: null,
      activationTokens: null,
      windowTokens: rec.windowTokens,
      position: null,
    };
  }

  if (rec.status === 'failed') {
    return {
      compacted: false,
      turnsAgo,
      tokensAgo: null,
      activationTokens: null,
      windowTokens: rec.windowTokens,
      position: null,
    };
  }

  if (
    rec.windowTokens !== null
    && rec.windowTokens > 0
    && rec.activationTokens !== null
    && rec.activationTokens >= 0
  ) {
    const clampedAct = Math.min(rec.windowTokens, rec.activationTokens);
    const tokensAgo = Math.max(0, rec.windowTokens - clampedAct);
    const position = tokensAgo === 0
      ? 1
      : clampUnit(clampedAct / rec.windowTokens, 0.05, 0.98);
    return {
      compacted: false,
      turnsAgo,
      tokensAgo,
      activationTokens: clampedAct,
      windowTokens: rec.windowTokens,
      position,
    };
  }

  // Fallback position from turn ratio when provider has not yet emitted step token usage
  const denom = Math.max(1, rec.scope === 'session' ? effectiveRootTurnCount : rec.sessionTurnCount);
  const fallbackPos = turnsAgo === 0
    ? 1
    : clampUnit((rec.turnIndex + 1) / Math.max(denom, rec.turnIndex + 1), 0.08, 0.96);

  return {
    compacted: false,
    turnsAgo,
    tokensAgo: null,
    activationTokens: null,
    windowTokens: null,
    position: fallbackPos,
  };
};

const choosePrimaryTrigger = (triggers: readonly SkillTrigger[]): SkillTrigger => {
  if (triggers.includes('user')) return 'user';
  if (triggers.includes('agent')) return 'agent';
  return 'subagent';
};

export const aggregateScopedSkills = (params: {
  readonly scope: SkillScope;
  readonly records: readonly RawSkillEventRecord[];
  readonly effectiveRootTurnIndex: number;
  readonly effectiveRootTurnCount: number;
  readonly diskMetadataByDirectory: ReadonlyMap<string, DiskSkillMetadata>;
  readonly homeDir: string | null;
}): SessionSkillSummary[] => {
  const {
    scope,
    records,
    effectiveRootTurnIndex,
    effectiveRootTurnCount,
    diskMetadataByDirectory,
    homeDir,
  } = params;
  const sorted = [...records].sort((a, b) => a.at - b.at);

  type Accumulator = {
    id: string;
    name: string;
    hasActive: boolean;
    hasLoading: boolean;
    triggers: SkillTrigger[];
    actors: string[];
    activeCount: number;
    totalCount: number;
    firstActivatedAt: number;
    lastActivatedAt: number;
    latestDepthRecord: RawSkillEventRecord;
    directory: string | null;
    description: string | null;
    preview: string | null;
    error: string | null;
  };

  const map = new Map<string, Accumulator>();

  for (const rec of sorted) {
    let acc = map.get(rec.id);
    if (!acc) {
      acc = {
        id: rec.id,
        name: rec.name || rec.id,
        hasActive: false,
        hasLoading: false,
        triggers: [],
        actors: [],
        activeCount: 0,
        totalCount: 0,
        firstActivatedAt: rec.at,
        lastActivatedAt: rec.at,
        latestDepthRecord: rec,
        directory: rec.directory,
        description: rec.description,
        preview: rec.preview,
        error: rec.error,
      };
      map.set(rec.id, acc);
    }

    acc.totalCount += 1;
    if (rec.name && rec.name !== rec.id) acc.name = rec.name;
    if (rec.at < acc.firstActivatedAt) acc.firstActivatedAt = rec.at;
    if (rec.at >= acc.lastActivatedAt) {
      acc.lastActivatedAt = rec.at;
    }
    if (rec.directory && !acc.directory) acc.directory = rec.directory;
    if (rec.description && !acc.description) acc.description = rec.description;
    if (rec.preview && !acc.preview) acc.preview = rec.preview;

    if (rec.status === 'active') {
      acc.hasActive = true;
      acc.activeCount += 1;
      acc.error = null;
      acc.latestDepthRecord = rec;
    } else if (rec.status === 'loading') {
      acc.hasLoading = true;
      if (!acc.hasActive) {
        acc.latestDepthRecord = rec;
      }
    } else if (rec.status === 'failed' && !acc.hasActive) {
      acc.error = rec.error;
      acc.latestDepthRecord = rec;
    }

    if (!acc.triggers.includes(rec.trigger)) {
      acc.triggers.push(rec.trigger);
    }
    if (rec.actor && !acc.actors.includes(rec.actor) && acc.actors.length < MAX_ACTORS) {
      acc.actors.push(rec.actor);
    }
  }

  const summaries: SessionSkillSummary[] = [];
  for (const acc of map.values()) {
    const diskMeta = acc.directory ? diskMetadataByDirectory.get(acc.directory) : undefined;
    const description = diskMeta?.description || acc.description || null;
    const preview = (diskMeta?.description ? diskMeta.preview : null)
      || acc.preview
      || diskMeta?.preview
      || null;
    const status: SkillStatus = acc.hasActive
      ? 'active'
      : (acc.hasLoading ? 'loading' : 'failed');

    const depth = computeRecordDepth({
      rec: acc.latestDepthRecord,
      effectiveRootTurnIndex,
      effectiveRootTurnCount,
    });

    summaries.push({
      id: acc.id,
      name: acc.name,
      scope,
      status,
      primaryTrigger: choosePrimaryTrigger(acc.triggers),
      triggers: acc.triggers,
      actors: acc.actors,
      count: acc.activeCount > 0 ? acc.activeCount : acc.totalCount,
      firstActivatedAt: acc.firstActivatedAt,
      lastActivatedAt: acc.lastActivatedAt,
      depth,
      directory: acc.directory,
      displayPath: formatDisplayPath(acc.directory, homeDir),
      description,
      preview,
      error: status === 'failed' && acc.error ? truncateClean(acc.error, MAX_ERROR_CHARS) : null,
    });
  }

  return summaries.sort((a, b) => a.firstActivatedAt - b.firstActivatedAt);
};
