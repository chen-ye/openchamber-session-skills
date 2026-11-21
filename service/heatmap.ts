import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatDisplayPath,
  isRecord,
  parseSkillContent,
  trimmed,
} from './parser.ts';
import type {
  SkillHeatmapDay,
  SkillHeatmapResponse,
  SkillHeatmapRow,
  SkillHeatmapScopeFilter,
  SkillHeatmapWindow,
  SkillPolicyEffect,
  SkillPolicyState,
  SkillUpstreamInfo,
} from '../shared/types.ts';

type HeatmapSourceKind =
  | 'user_attach'
  | 'user_slash'
  | 'agent_tool'
  | 'subagent_injected'
  | 'subagent_handoff'
  | 'subagent_tool';

export type StoredSkillActivation = {
  skill: string;
  source: HeatmapSourceKind;
  status: 'active' | 'failed' | 'loading';
  sessionId: string;
  rootSessionId: string;
  actor: string;
  project: string;
  at: number;
};

type HeatmapCachePayload = {
  version: 1;
  dbPath: string;
  dbSize: number;
  watermarkTimeCreated: number;
  excludedEvalSessions: number;
  forkClonedMessagesSkipped: number;
  dedupedHandoffs: number;
  events: StoredSkillActivation[];
};

export type InstalledSkillInfo = {
  id: string;
  name: string;
  fmName: string | null;
  description: string | null;
  directory: string;
  displayPath: string | null;
  upstream: SkillUpstreamInfo | null;
};

type SessionRow = {
  id: string;
  parent_id: string | null;
  directory: string;
  agent: string | null;
  title: string | null;
  time_created: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  data: string;
};

export type HeatmapQueryOptions = {
  window?: SkillHeatmapWindow;
  project?: string | null;
  scope?: SkillHeatmapScopeFilter;
  directory?: string | null;
  refresh?: boolean;
};

export type HeatmapStoreOptions = {
  homeDir?: string | null;
  dbPath?: string | null;
  dataDir?: string | null;
  extraSkillRoots?: readonly string[];
  extraConfigPaths?: readonly string[];
  opencodeUrl?: string;
  serviceToken?: string;
  cacheTtlMs?: number;
};

const CACHE_FILENAME = 'heatmap-cache-v1.json';
const DEFAULT_CACHE_TTL_MS = 5_000;
const INSTALLED_SKILLS_TTL_MS = 30_000;
const BUILTIN_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['opencode', 'opencode'],
  ['OpenCode', 'opencode'],
  ['report', 'report'],
  ['Report', 'report'],
];

const localDateParts = (ms: number): {
  day: string;
  week: string;
  dow: number;
  hour: number;
} => {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dayNum = String(d.getDate()).padStart(2, '0');
  const day = `${y}-${m}-${dayNum}`;
  const dow = (d.getDay() + 6) % 7; // 0=Mon..6=Sun
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  const wy = monday.getFullYear();
  const wm = String(monday.getMonth() + 1).padStart(2, '0');
  const wd = String(monday.getDate()).padStart(2, '0');
  return { day, week: `${wy}-${wm}-${wd}`, dow, hour: d.getHours() };
};

export const deriveProjectLabel = (dir: string, homeDir: string | null): string => {
  if (!dir) return 'unknown';
  const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm) return 'unknown';
  if (norm.includes('/.config/openchamber/chats/')) return 'openchamber-scratch';
  if (norm.includes('/.local/share/opencode/worktree/')) return 'opencode-worktree';
  if (homeDir) {
    const cleanHome = homeDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm === cleanHome) return '~';
  }
  return path.basename(norm) || norm;
};

const extractSkillTag = (text: string): string | null => {
  const m = /<skill_content\s+name="([^"]+)"/i.exec(text);
  return m?.[1]?.trim() || null;
};

const formatUpstreamLabel = (
  rawSource: string,
  sourceType: string,
  sourceUrl: string | null,
  homeDir: string | null,
): string => {
  if (sourceType === 'local') {
    const rawPath = rawSource || sourceUrl || '';
    return formatDisplayPath(rawPath, homeDir) ?? rawPath;
  }
  if (/^https?:\/\//i.test(rawSource)) {
    return rawSource.replace(/^https?:\/\//i, '').replace(/\.git$/i, '');
  }
  if (sourceType === 'git' && rawSource && sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
    try {
      const host = new URL(sourceUrl).hostname;
      if (host && host !== 'github.com' && !rawSource.startsWith(`${host}/`)) {
        return `${host}/${rawSource}`;
      }
    } catch {
      // Ignore malformed URL
    }
  }
  if (rawSource) return rawSource;
  if (sourceUrl) return sourceUrl.replace(/^https?:\/\//i, '').replace(/\.git$/i, '');
  return sourceType;
};

export const discoverSkillLockfile = async (
  homeDir: string | null,
  extraLockfiles: readonly string[] = [],
): Promise<Map<string, SkillUpstreamInfo>> => {
  const candidates: string[] = [];
  if (homeDir) {
    candidates.push(
      path.join(homeDir, '.agents', '.skill-lock.json'),
      path.join(homeDir, '.config', 'opencode', '.skill-lock.json'),
      path.join(homeDir, '.gemini', '.skill-lock.json'),
    );
  }
  for (const p of extraLockfiles) {
    if (p && !candidates.includes(p)) candidates.push(p);
  }

  const upstreamById = new Map<string, SkillUpstreamInfo>();
  for (const lockPath of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(lockPath, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.skills)) continue;

    for (const [skillId, entry] of Object.entries(parsed.skills)) {
      const id = skillId.trim();
      if (!id || upstreamById.has(id) || !isRecord(entry)) continue;
      const sourceType = trimmed(entry.sourceType) || 'unknown';
      const rawSource = trimmed(entry.source);
      const sourceUrl = trimmed(entry.sourceUrl) || null;
      const ref = trimmed(entry.ref) || null;
      const skillPath = trimmed(entry.skillPath) || null;
      const source = formatUpstreamLabel(rawSource, sourceType, sourceUrl, homeDir);
      if (!source && !sourceUrl) continue;
      upstreamById.set(id, {
        source,
        sourceType,
        sourceUrl,
        ref,
        skillPath,
      });
    }
  }

  return upstreamById;
};

export const discoverInstalledSkills = async (
  homeDir: string | null,
  extraRoots: readonly string[] = [],
  extraLockfiles: readonly string[] = [],
): Promise<{
  installed: Map<string, InstalledSkillInfo>;
  aliasToId: Map<string, string>;
  upstreamById: Map<string, SkillUpstreamInfo>;
}> => {
  const upstreamById = await discoverSkillLockfile(homeDir, extraLockfiles);
  const roots: string[] = [];
  if (homeDir) {
    roots.push(
      path.join(homeDir, '.config', 'opencode', 'skills'),
      path.join(homeDir, '.agents', 'skills'),
    );
  }
  for (const r of extraRoots) {
    if (r && !roots.includes(r)) roots.push(r);
  }

  const seenRealDirs = new Set<string>();
  const installed = new Map<string, InstalledSkillInfo>();
  const aliasToId = new Map<string, string>();
  for (const [alias, id] of BUILTIN_ALIASES) {
    aliasToId.set(alias, id);
    aliasToId.set(alias.toLowerCase(), id);
  }

  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(root, entry.name);
      let realDir = skillDir;
      try {
        realDir = realpathSync(skillDir);
      } catch {
        // Keep unresolved symlink path if realpath fails
      }
      if (seenRealDirs.has(realDir)) continue;
      const mdPath = path.join(skillDir, 'SKILL.md');
      let raw: string;
      try {
        raw = await fs.readFile(mdPath, 'utf8');
      } catch {
        continue;
      }
      seenRealDirs.add(realDir);

      const id = entry.name.trim();
      if (!id) continue;
      const parsed = parseSkillContent(raw);
      if (!installed.has(id)) {
        installed.set(id, {
          id,
          name: parsed.name || id,
          fmName: parsed.name,
          description: parsed.description,
          directory: skillDir,
          displayPath: formatDisplayPath(mdPath, homeDir),
          upstream: upstreamById.get(id) ?? null,
        });
      }
      aliasToId.set(id, id);
      aliasToId.set(id.toLowerCase(), id);
      if (parsed.name) {
        aliasToId.set(parsed.name, id);
        aliasToId.set(parsed.name.toLowerCase(), id);
      }
    }
  }

  return { installed, aliasToId, upstreamById };
};

const normalizeSkillId = (raw: string, aliasToId: Map<string, string>): string => {
  const s = raw.trim();
  if (!s) return '';
  return aliasToId.get(s) ?? aliasToId.get(s.toLowerCase()) ?? s;
};

export type SkillUseRule = {
  pattern: string;
  effect: SkillPolicyEffect;
  sourcePath: string | null;
};

const stripJsonc = (raw: string): string => {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? '';
    const next = raw[i + 1] ?? '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      } else if (ch === '\n') {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }

  // Strip trailing commas outside string literals
  let finalOut = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i] ?? '';
    if (inString) {
      finalOut += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      finalOut += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j] ?? '')) j += 1;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    finalOut += ch;
  }
  return finalOut;
};

export const matchSkillWildcard = (input: string, pattern: string): boolean => {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(input.replaceAll('\\', '/'));
};

const extractSkillUseStatements = (
  info: unknown,
  sourcePath: string | null,
): SkillUseRule[] => {
  if (!isRecord(info)) return [];
  const exp = isRecord(info.experimental) ? info.experimental : null;
  const rawList: unknown[] = [
    ...(Array.isArray(exp?.policies) ? exp.policies : []),
    ...(Array.isArray(info.policies) ? info.policies : []),
  ];
  const rules: SkillUseRule[] = [];
  for (const item of rawList) {
    if (!isRecord(item)) continue;
    const action = trimmed(item.action);
    const resource = trimmed(item.resource);
    const effect = trimmed(item.effect);
    if (effect !== 'allow' && effect !== 'deny') continue;
    if (action === 'skill.use' && resource) {
      rules.push({ pattern: resource, effect, sourcePath });
    } else if (action === 'integration.use' && resource.startsWith('skill:') && resource.length > 6) {
      rules.push({ pattern: resource.slice(6), effect, sourcePath });
    }
  }
  return rules;
};

export const loadSkillUseRules = async (opts: {
  homeDir: string | null;
  directory?: string | null;
  extraConfigPaths?: readonly string[];
  opencodeUrl?: string;
  serviceToken?: string;
}): Promise<SkillUseRule[]> => {
  const { homeDir, directory, extraConfigPaths = [], opencodeUrl, serviceToken } = opts;

  // 1. Prefer live OpenCode /api/config when connected (includes managed/console/project layers)
  if (opencodeUrl && serviceToken) {
    try {
      const qs = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      try {
        const res = await fetch(`${opencodeUrl}/api/config${qs}`, {
          headers: { Authorization: `Bearer ${serviceToken}` },
          signal: controller.signal,
        });
        if (res.ok) {
          const parsed: unknown = await res.json();
          const entries = Array.isArray(parsed)
            ? parsed
            : (isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : null);
          if (entries) {
            const docs = entries.filter((e) => isRecord(e) && trimmed(e.type) === 'document');
            if (docs.length > 0) {
              // Reverse lowest->highest documents so last-matching statement wins (matches OpenCode ManagedPolicy.statements)
              return docs.reverse().flatMap((doc) => {
                const rawPath = typeof doc.path === 'string' ? doc.path : null;
                return extractSkillUseStatements(doc.info, formatDisplayPath(rawPath, homeDir));
              });
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Fall back to reading local OpenCode config files directly
    }
  }

  // 2. Local config files (lowest -> highest priority; reversed so last match wins)
  const paths: string[] = [];
  if (homeDir) {
    paths.push(
      path.join(homeDir, '.config', 'opencode', 'opencode.json'),
      path.join(homeDir, '.config', 'opencode', 'opencode.jsonc'),
    );
  }
  const envCfg = process.env.OPENCODE_CONFIG?.trim();
  if (envCfg && !paths.includes(envCfg)) paths.push(envCfg);
  if (directory) {
    paths.push(
      path.join(directory, 'opencode.json'),
      path.join(directory, 'opencode.jsonc'),
      path.join(directory, '.opencode', 'opencode.json'),
      path.join(directory, '.opencode', 'opencode.jsonc'),
    );
  }
  for (const p of extraConfigPaths) {
    if (p && !paths.includes(p)) paths.push(p);
  }

  const docs: Array<{ info: unknown; sourcePath: string | null }> = [];
  for (const cfgPath of paths) {
    let raw: string;
    try {
      raw = await fs.readFile(cfgPath, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(stripJsonc(raw));
      docs.push({ info: parsed, sourcePath: formatDisplayPath(cfgPath, homeDir) });
    } catch {
      // Ignore malformed config file
    }
  }

  return docs.reverse().flatMap((doc) => extractSkillUseStatements(doc.info, doc.sourcePath));
};

export const evaluateSkillPolicy = (
  rules: readonly SkillUseRule[],
  skillId: string,
): SkillPolicyState => {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i];
    if (rule && matchSkillWildcard(skillId, rule.pattern)) {
      return {
        effect: rule.effect,
        explicit: true,
        pattern: rule.pattern,
        sourcePath: rule.sourcePath,
      };
    }
  }
  return {
    effect: 'allow',
    explicit: false,
    pattern: null,
    sourcePath: null,
  };
};

export const resolveDefaultOpencodeDbPath = (
  homeDir: string | null,
  env: Record<string, string | undefined> = process.env,
): string | null => {
  const override = env.OPENCODE_DB_PATH?.trim();
  if (override) return override;
  const xdgData = env.XDG_DATA_HOME?.trim();
  if (xdgData) return path.join(xdgData, 'opencode', 'opencode.db');
  if (homeDir) return path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
  return null;
};

type SqliteModule = typeof import('node:sqlite');

let cachedSqlitePromise: Promise<SqliteModule | null> | null = null;
const loadSqliteModule = async (): Promise<SqliteModule | null> => {
  if (!cachedSqlitePromise) {
    cachedSqlitePromise = import('node:sqlite').catch(() => null);
  }
  return cachedSqlitePromise;
};

const isForkClonedMessage = (msgId: string, msgCreated: number, sessionCreated: number): boolean => (
  /^msg_[a-zA-Z0-9]{16,}_\d+$/.test(msgId)
  || (sessionCreated > 0 && msgCreated < sessionCreated)
);

const isSubagentSource = (source: HeatmapSourceKind): boolean => (
  source === 'subagent_injected' || source === 'subagent_handoff' || source === 'subagent_tool'
);

export type HeatmapStore = {
  query: (options?: HeatmapQueryOptions) => Promise<SkillHeatmapResponse>;
  invalidate: () => void;
};

export const createHeatmapStore = (options: HeatmapStoreOptions = {}): HeatmapStore => {
  const homeDir = options.homeDir === undefined ? (os.homedir() || null) : options.homeDir;
  const dbPath = options.dbPath !== undefined
    ? options.dbPath
    : resolveDefaultOpencodeDbPath(homeDir);
  const dataDir = options.dataDir !== undefined
    ? options.dataDir
    : (process.env.OPENCHAMBER_SERVICE_DATA_DIR?.trim() || null);
  const extraRoots = options.extraSkillRoots ?? [];
  const extraConfigPaths = options.extraConfigPaths ?? [];
  const opencodeUrl = options.opencodeUrl;
  const serviceToken = options.serviceToken;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  let memoryCache: HeatmapCachePayload | null = null;
  let lastSyncedAt = 0;
  let diskCacheLoaded = false;
  let inflightSync: Promise<void> | null = null;

  let installedCache: {
    at: number;
    installed: Map<string, InstalledSkillInfo>;
    aliasToId: Map<string, string>;
    upstreamById: Map<string, SkillUpstreamInfo>;
  } | null = null;

  const getInstalled = async (force = false) => {
    const now = Date.now();
    if (!force && installedCache && now - installedCache.at < INSTALLED_SKILLS_TTL_MS) {
      return installedCache;
    }
    const discovered = await discoverInstalledSkills(homeDir, extraRoots);
    installedCache = { at: now, ...discovered };
    return installedCache;
  };

  const loadDiskCache = async (): Promise<void> => {
    if (diskCacheLoaded) return;
    diskCacheLoaded = true;
    if (!dataDir) return;
    const cacheFile = path.join(dataDir, CACHE_FILENAME);
    try {
      const raw = await fs.readFile(cacheFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (
        isRecord(parsed)
        && parsed.version === 1
        && typeof parsed.dbPath === 'string'
        && typeof parsed.dbSize === 'number'
        && typeof parsed.watermarkTimeCreated === 'number'
        && Array.isArray(parsed.events)
      ) {
        memoryCache = {
          version: 1,
          dbPath: parsed.dbPath,
          dbSize: parsed.dbSize,
          watermarkTimeCreated: parsed.watermarkTimeCreated,
          excludedEvalSessions: typeof parsed.excludedEvalSessions === 'number' ? parsed.excludedEvalSessions : 0,
          forkClonedMessagesSkipped: typeof parsed.forkClonedMessagesSkipped === 'number' ? parsed.forkClonedMessagesSkipped : 0,
          dedupedHandoffs: typeof parsed.dedupedHandoffs === 'number' ? parsed.dedupedHandoffs : 0,
          events: parsed.events as StoredSkillActivation[],
        };
      }
    } catch {
      // Cache absent or unreadable; cold scan will populate it
    }
  };

  const saveDiskCache = async (payload: HeatmapCachePayload): Promise<void> => {
    if (!dataDir) return;
    const cacheFile = path.join(dataDir, CACHE_FILENAME);
    const tmpFile = `${cacheFile}.tmp-${process.pid}`;
    try {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(tmpFile, JSON.stringify(payload), 'utf8');
      await fs.rename(tmpFile, cacheFile);
    } catch {
      // Ignore cache write errors; memory cache remains valid
    }
  };

  const syncFromDb = async (forceRefresh: boolean): Promise<{
    dbAvailable: boolean;
    cacheHit: boolean;
    scanMs: number;
  }> => {
    const startMs = Date.now();
    await loadDiskCache();

    if (!dbPath || !existsSync(dbPath)) {
      return { dbAvailable: false, cacheHit: false, scanMs: Date.now() - startMs };
    }

    const now = Date.now();
    if (!forceRefresh && memoryCache && memoryCache.dbPath === dbPath && now - lastSyncedAt < cacheTtlMs) {
      return { dbAvailable: true, cacheHit: true, scanMs: Date.now() - startMs };
    }

    if (inflightSync) {
      await inflightSync;
      return { dbAvailable: true, cacheHit: true, scanMs: Date.now() - startMs };
    }

    let dbAvailable = true;
    let cacheHit = false;

    const runSync = async (): Promise<void> => {
      const sqlite = await loadSqliteModule();
      if (!sqlite) {
        dbAvailable = false;
        return;
      }

      let dbSize = 0;
      try {
        const st = await fs.stat(dbPath);
        dbSize = st.size;
      } catch {
        dbAvailable = false;
        return;
      }

      const { aliasToId } = await getInstalled(forceRefresh);
      const slashAliases = [...aliasToId.keys()]
        .filter((k) => k.length >= 2)
        .sort((a, b) => b.length - a.length);

      let db: InstanceType<SqliteModule['DatabaseSync']> | null = null;
      try {
        db = new sqlite.DatabaseSync(dbPath, { readOnly: true });

        const hasValidCache = Boolean(
          !forceRefresh
          && memoryCache
          && memoryCache.dbPath === dbPath
          && dbSize >= memoryCache.dbSize
          && memoryCache.watermarkTimeCreated > 0,
        );

        const watermark = hasValidCache && memoryCache ? memoryCache.watermarkTimeCreated : 0;

        // Fast check when incremental: skip session scan if no new messages arrived
        if (hasValidCache && memoryCache) {
          const latestRow = db.prepare(
            'SELECT max(time_created) as max_t FROM session_message',
          ).get() as { max_t?: number | null } | undefined;
          const maxT = typeof latestRow?.max_t === 'number' ? latestRow.max_t : 0;
          if (maxT <= watermark) {
            cacheHit = true;
            lastSyncedAt = Date.now();
            return;
          }
        }

        const sessionRows = db.prepare(
          'SELECT id, parent_id, directory, agent, title, time_created FROM session_v2',
        ).all() as SessionRow[];

        const sessionMap = new Map<string, SessionRow>();
        for (const s of sessionRows) {
          sessionMap.set(s.id, s);
        }

        const resolveRootSession = (sid: string): string => {
          let cur = sid;
          const seen = new Set<string>();
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            const row = sessionMap.get(cur);
            if (!row?.parent_id) return cur;
            cur = row.parent_id;
          }
          return sid;
        };

        const isExcludedSession = (s: SessionRow): boolean => {
          if (s.agent === 'auto-gate-eval' || s.agent === 'hindsight-survey') return true;
          if (s.directory?.startsWith('/tmp/')) return true;
          if ((s.title ?? '').includes('auto-gate')) return true;
          if (s.parent_id) {
            const root = sessionMap.get(resolveRootSession(s.id));
            if (root && (root.agent === 'auto-gate-eval' || root.directory?.startsWith('/tmp/'))) {
              return true;
            }
          }
          return false;
        };

        let excludedEvalSessions = 0;
        for (const s of sessionRows) {
          if (isExcludedSession(s)) excludedEvalSessions += 1;
        }

        const msgRows = (
          watermark > 0
            ? db.prepare(`
              SELECT id, session_id, type, seq, time_created, data
              FROM session_message
              WHERE time_created > ?
                AND type IN ('assistant', 'user', 'synthetic')
                AND (
                  data LIKE '%"name":"skill"%'
                  OR data LIKE '%"skills":%'
                  OR data LIKE '%<skill_content%'
                  OR data LIKE '%[SKILL:%'
                  OR data LIKE '%"name":"subagent"%'
                  OR data LIKE '%"name":"task"%'
                  OR (type = 'user' AND data LIKE '%"text":"/%')
                )
              ORDER BY time_created ASC, seq ASC
            `).all(watermark)
            : db.prepare(`
              SELECT id, session_id, type, seq, time_created, data
              FROM session_message
              WHERE type IN ('assistant', 'user', 'synthetic')
                AND (
                  data LIKE '%"name":"skill"%'
                  OR data LIKE '%"skills":%'
                  OR data LIKE '%<skill_content%'
                  OR data LIKE '%[SKILL:%'
                  OR data LIKE '%"name":"subagent"%'
                  OR data LIKE '%"name":"task"%'
                  OR (type = 'user' AND data LIKE '%"text":"/%')
                )
              ORDER BY time_created ASC, seq ASC
            `).all()
        ) as MessageRow[];

        const baseEvents: StoredSkillActivation[] = hasValidCache && memoryCache
          ? [...memoryCache.events]
          : [];
        let forkClonedMessagesSkipped = hasValidCache && memoryCache
          ? memoryCache.forkClonedMessagesSkipped
          : 0;
        let dedupedHandoffs = hasValidCache && memoryCache
          ? memoryCache.dedupedHandoffs
          : 0;

        const childRecordedSkills = new Set<string>();
        const sessionMinuteSkillSeen = new Set<string>();
        for (const existing of baseEvents) {
          if (existing.source === 'subagent_injected' || existing.source === 'subagent_tool') {
            childRecordedSkills.add(`${existing.sessionId}\0${existing.skill}`);
          }
          sessionMinuteSkillSeen.add(`${existing.sessionId}\0${Math.floor(existing.at / 60_000)}\0${existing.skill}`);
        }

        const pendingHandoffs: Array<{
          childSessionId: string | null;
          event: StoredSkillActivation;
        }> = [];
        let maxTimeCreated = watermark;

        for (const row of msgRows) {
          if (row.time_created > maxTimeCreated) maxTimeCreated = row.time_created;
          const sess = sessionMap.get(row.session_id);
          if (!sess || isExcludedSession(sess)) continue;

          if (isForkClonedMessage(row.id, row.time_created, sess.time_created)) {
            forkClonedMessagesSkipped += 1;
            continue;
          }

          let parsedData: unknown;
          try {
            parsedData = JSON.parse(row.data);
          } catch {
            continue;
          }
          if (!isRecord(parsedData)) continue;

          const isSubagent = Boolean(sess.parent_id);
          const rootSessionId = resolveRootSession(sess.id);
          const rootSess = sessionMap.get(rootSessionId) ?? sess;
          const project = deriveProjectLabel(rootSess.directory || sess.directory, homeDir);

          if (row.type === 'assistant' && Array.isArray(parsedData.content)) {
            const actor = trimmed(parsedData.agent) || trimmed(sess.agent) || 'assistant';
            for (const part of parsedData.content) {
              if (!isRecord(part) || trimmed(part.type) !== 'tool') continue;
              const toolName = trimmed(part.name);

              if (toolName === 'skill') {
                const st = isRecord(part.state) ? part.state : {};
                const input = isRecord(st.input) ? st.input : {};
                const meta = isRecord(st.metadata) ? st.metadata : {};
                let rawSkill = trimmed(input.id) || trimmed(input.name);
                if (!rawSkill && typeof meta.directory === 'string' && meta.directory.trim()) {
                  rawSkill = path.basename(meta.directory.trim().replace(/^skill:\/\//, ''));
                }
                if (!rawSkill && Array.isArray(st.content)) {
                  for (const c of st.content) {
                    if (isRecord(c) && typeof c.text === 'string') {
                      const tag = extractSkillTag(c.text);
                      if (tag) {
                        rawSkill = tag;
                        break;
                      }
                    }
                  }
                }
                if (!rawSkill) rawSkill = trimmed(meta.name);
                const skill = normalizeSkillId(rawSkill, aliasToId);
                if (!skill) continue;

                const partTime = isRecord(part.time) ? part.time : null;
                const at = (
                  (typeof partTime?.completed === 'number' ? partTime.completed : null)
                  ?? (typeof partTime?.created === 'number' ? partTime.created : null)
                  ?? row.time_created
                );
                const statusRaw = trimmed(st.status);
                const status: StoredSkillActivation['status'] =
                  statusRaw === 'error' ? 'failed' : statusRaw === 'completed' ? 'active' : 'loading';

                baseEvents.push({
                  skill,
                  source: isSubagent ? 'subagent_tool' : 'agent_tool',
                  status,
                  sessionId: sess.id,
                  rootSessionId,
                  actor,
                  project,
                  at,
                });
                if (isSubagent) childRecordedSkills.add(`${sess.id}\0${skill}`);
                sessionMinuteSkillSeen.add(`${sess.id}\0${Math.floor(at / 60_000)}\0${skill}`);
              } else if (toolName === 'subagent' || toolName === 'task') {
                const st = isRecord(part.state) ? part.state : {};
                if (trimmed(st.status) === 'error') continue;
                const input = isRecord(st.input) ? st.input : {};
                const meta = isRecord(st.metadata) ? st.metadata : {};
                const rawSkills = Array.isArray(input.skills)
                  ? input.skills
                  : (Array.isArray(input.load_skills) ? input.load_skills : []);
                if (rawSkills.length === 0) continue;

                const childSessionId = trimmed(meta.sessionID) || trimmed(meta.sessionId) || null;
                const subActor = trimmed(input.agent) || trimmed(input.category) || 'subagent';
                const partTime = isRecord(part.time) ? part.time : null;
                const at = typeof partTime?.created === 'number' ? partTime.created : row.time_created;
                const status: StoredSkillActivation['status'] =
                  trimmed(st.status) === 'completed' ? 'active' : 'loading';

                for (const rawSk of rawSkills) {
                  if (typeof rawSk !== 'string') continue;
                  const skill = normalizeSkillId(rawSk, aliasToId);
                  if (!skill) continue;
                  pendingHandoffs.push({
                    childSessionId,
                    event: {
                      skill,
                      source: 'subagent_handoff',
                      status,
                      sessionId: childSessionId || sess.id,
                      rootSessionId,
                      actor: subActor,
                      project,
                      at,
                    },
                  });
                }
              }
            }
            continue;
          }

          if (row.type === 'user' || row.type === 'synthetic') {
            const msgTime = isRecord(parsedData.time) ? parsedData.time : null;
            const at = typeof msgTime?.created === 'number' ? msgTime.created : row.time_created;

            if (Array.isArray(parsedData.skills)) {
              for (const sk of parsedData.skills) {
                if (!isRecord(sk)) continue;
                const rawId = trimmed(sk.id) || trimmed(sk.name);
                if (!rawId) continue;
                const skill = normalizeSkillId(rawId, aliasToId);
                if (!skill) continue;
                baseEvents.push({
                  skill,
                  source: 'user_attach',
                  status: 'active',
                  sessionId: sess.id,
                  rootSessionId,
                  actor: isSubagent ? (trimmed(sess.agent) || 'subagent') : 'user',
                  project,
                  at,
                });
                if (isSubagent) childRecordedSkills.add(`${sess.id}\0${skill}`);
                sessionMinuteSkillSeen.add(`${sess.id}\0${Math.floor(at / 60_000)}\0${skill}`);
              }
            }

            const text = typeof parsedData.text === 'string' ? parsedData.text : '';
            if (isSubagent && text.includes('[SKILL:')) {
              for (const m of text.matchAll(/^\[SKILL:\s*([A-Za-z0-9_.:-]+)\]/gm)) {
                const rawId = m[1] ?? '';
                const skill = normalizeSkillId(rawId, aliasToId);
                if (!skill) continue;
                baseEvents.push({
                  skill,
                  source: 'subagent_injected',
                  status: 'active',
                  sessionId: sess.id,
                  rootSessionId,
                  actor: trimmed(sess.agent) || 'subagent',
                  project,
                  at,
                });
                childRecordedSkills.add(`${sess.id}\0${skill}`);
              }
            }

            if (row.type === 'user' && text.startsWith('/') && !text.startsWith('//') && !Array.isArray(parsedData.skills)) {
              const afterSlash = text.slice(1);
              for (const alias of slashAliases) {
                if (
                  afterSlash.toLowerCase().startsWith(alias.toLowerCase())
                  && (afterSlash.length === alias.length || /[\s\n.,:;!?]/.test(afterSlash[alias.length] ?? ''))
                ) {
                  const skill = normalizeSkillId(alias, aliasToId);
                  if (!skill) break;
                  const minuteKey = `${sess.id}\0${Math.floor(at / 60_000)}\0${skill}`;
                  if (!sessionMinuteSkillSeen.has(minuteKey)) {
                    baseEvents.push({
                      skill,
                      source: 'user_slash',
                      status: 'active',
                      sessionId: sess.id,
                      rootSessionId,
                      actor: 'user',
                      project,
                      at,
                    });
                    sessionMinuteSkillSeen.add(minuteKey);
                  }
                  break;
                }
              }
            }
          }
        }

        // Remove any prior cached subagent_handoff if a newly arrived child event recorded the same (childSessionId, skill)
        const filteredBase = baseEvents.filter((ev) => {
          if (ev.source === 'subagent_handoff' && childRecordedSkills.has(`${ev.sessionId}\0${ev.skill}`)) {
            dedupedHandoffs += 1;
            return false;
          }
          return true;
        });

        for (const h of pendingHandoffs) {
          if (h.childSessionId && childRecordedSkills.has(`${h.childSessionId}\0${h.event.skill}`)) {
            dedupedHandoffs += 1;
            continue;
          }
          filteredBase.push(h.event);
        }

        filteredBase.sort((a, b) => a.at - b.at);

        const nextPayload: HeatmapCachePayload = {
          version: 1,
          dbPath,
          dbSize,
          watermarkTimeCreated: maxTimeCreated,
          excludedEvalSessions,
          forkClonedMessagesSkipped,
          dedupedHandoffs,
          events: filteredBase,
        };
        memoryCache = nextPayload;
        lastSyncedAt = Date.now();
        await saveDiskCache(nextPayload);
      } catch {
        dbAvailable = false;
      } finally {
        try {
          db?.close();
        } catch {
          // Ignore close error
        }
      }
    };

    inflightSync = runSync();
    try {
      await inflightSync;
    } finally {
      inflightSync = null;
    }

    return { dbAvailable, cacheHit, scanMs: Date.now() - startMs };
  };

  const query = async (queryOpts: HeatmapQueryOptions = {}): Promise<SkillHeatmapResponse> => {
    const windowOpt: SkillHeatmapWindow = queryOpts.window ?? '16w';
    const scopeOpt: SkillHeatmapScopeFilter = queryOpts.scope ?? 'all';
    const projectOpt = queryOpts.project?.trim() || null;
    const currentProject = queryOpts.directory ? deriveProjectLabel(queryOpts.directory, homeDir) : null;

    const [{ dbAvailable, cacheHit, scanMs }, { installed, upstreamById }, policyRules] = await Promise.all([
      syncFromDb(Boolean(queryOpts.refresh)),
      getInstalled(Boolean(queryOpts.refresh)),
      loadSkillUseRules({
        homeDir,
        directory: queryOpts.directory,
        extraConfigPaths,
        opencodeUrl,
        serviceToken,
      }),
    ]);

    const allEvents = memoryCache?.events ?? [];

    // Discover project list across all events before project filtering
    const projectCounts = new Map<string, number>();
    for (const ev of allEvents) {
      projectCounts.set(ev.project, (projectCounts.get(ev.project) ?? 0) + 1);
    }
    const projects = [...projectCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([p]) => p);

    // Filter by scope and project
    const filteredEvents = allEvents.filter((ev) => {
      if (scopeOpt === 'direct' && isSubagentSource(ev.source)) return false;
      if (scopeOpt === 'subagent' && !isSubagentSource(ev.source)) return false;
      if (projectOpt && projectOpt !== 'all' && ev.project !== projectOpt) return false;
      return true;
    });

    // Build continuous week grid across filtered events (or all events if filteredEvents is empty)
    const weekSourceEvents = filteredEvents.length > 0 ? filteredEvents : allEvents;
    const allWeekSet = new Set<string>();
    for (const ev of weekSourceEvents) {
      allWeekSet.add(localDateParts(ev.at).week);
    }
    const sortedWeeks = [...allWeekSet].sort();
    const continuousWeeks: string[] = [];
    if (sortedWeeks.length > 0) {
      const first = new Date(`${sortedWeeks[0]}T12:00:00`);
      const last = new Date(`${sortedWeeks[sortedWeeks.length - 1]}T12:00:00`);
      for (
        let cur = new Date(first);
        cur <= last;
        cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7)
      ) {
        continuousWeeks.push(localDateParts(cur.getTime()).day);
      }
    }

    const weeks = windowOpt === '8w'
      ? continuousWeeks.slice(-8)
      : windowOpt === '16w'
        ? continuousWeeks.slice(-16)
        : continuousWeeks;

    const minWeek = weeks[0] ?? null;
    const weekIndexByKey = new Map<string, number>(weeks.map((w, idx) => [w, idx]));

    // Apply window cutoff to events when 8w/16w is selected
    const windowedEvents = minWeek
      ? filteredEvents.filter((ev) => localDateParts(ev.at).week >= minWeek)
      : filteredEvents;

    type SkillAccumulator = {
      id: string;
      total: number;
      sessions: Set<string>;
      user: number;
      agent: number;
      subagent: number;
      failed: number;
      firstAt: number;
      lastAt: number;
      weekCounts: number[];
      weekSessionSets: Array<Set<string>>;
      byProject: Record<string, number>;
    };

    const bySkill = new Map<string, SkillAccumulator>();
    const byDay = new Map<string, { count: number; sessions: Set<string>; skills: Map<string, number> }>();
    const dowHour: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const rootSessionsSet = new Set<string>();

    for (const ev of windowedEvents) {
      const lp = localDateParts(ev.at);
      rootSessionsSet.add(ev.rootSessionId);
      const dowRow = dowHour[lp.dow];
      if (dowRow) {
        dowRow[lp.hour] = (dowRow[lp.hour] ?? 0) + 1;
      }

      let dayEntry = byDay.get(lp.day);
      if (!dayEntry) {
        dayEntry = { count: 0, sessions: new Set(), skills: new Map() };
        byDay.set(lp.day, dayEntry);
      }
      dayEntry.count += 1;
      dayEntry.sessions.add(ev.rootSessionId);
      dayEntry.skills.set(ev.skill, (dayEntry.skills.get(ev.skill) ?? 0) + 1);

      let acc = bySkill.get(ev.skill);
      if (!acc) {
        acc = {
          id: ev.skill,
          total: 0,
          sessions: new Set(),
          user: 0,
          agent: 0,
          subagent: 0,
          failed: 0,
          firstAt: ev.at,
          lastAt: ev.at,
          weekCounts: Array<number>(weeks.length).fill(0),
          weekSessionSets: Array.from({ length: weeks.length }, () => new Set<string>()),
          byProject: {},
        };
        bySkill.set(ev.skill, acc);
      }

      acc.total += 1;
      acc.sessions.add(ev.rootSessionId);
      if (ev.status === 'failed') acc.failed += 1;
      if (ev.source === 'user_attach' || ev.source === 'user_slash') acc.user += 1;
      else if (ev.source === 'agent_tool') acc.agent += 1;
      else acc.subagent += 1;
      if (ev.at < acc.firstAt) acc.firstAt = ev.at;
      if (ev.at > acc.lastAt) acc.lastAt = ev.at;

      const wIdx = weekIndexByKey.get(lp.week);
      if (wIdx !== undefined) {
        acc.weekCounts[wIdx] = (acc.weekCounts[wIdx] ?? 0) + 1;
        acc.weekSessionSets[wIdx]?.add(ev.rootSessionId);
      }
      acc.byProject[ev.project] = (acc.byProject[ev.project] ?? 0) + 1;
    }

    const seenIds = new Set<string>();
    const rows: SkillHeatmapRow[] = [];
    for (const [id, acc] of bySkill.entries()) {
      seenIds.add(id);
      const inst = installed.get(id);
      rows.push({
        id,
        name: inst?.name || id,
        installed: Boolean(inst),
        total: acc.total,
        sessions: acc.sessions.size,
        user: acc.user,
        agent: acc.agent,
        subagent: acc.subagent,
        failed: acc.failed,
        firstDay: localDateParts(acc.firstAt).day,
        lastDay: localDateParts(acc.lastAt).day,
        weekCounts: acc.weekCounts,
        weekSessions: acc.weekSessionSets.map((s) => s.size),
        byProject: acc.byProject,
        description: inst?.description ?? null,
        displayPath: inst?.displayPath ?? null,
        upstream: inst?.upstream ?? upstreamById.get(id) ?? null,
        policy: evaluateSkillPolicy(policyRules, id),
      });
    }

    // Include ALL installed skills with zero activations in the active result set
    let dormantInstalledCount = 0;
    for (const [id, inst] of installed.entries()) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      dormantInstalledCount += 1;
      rows.push({
        id,
        name: inst.name || id,
        installed: true,
        total: 0,
        sessions: 0,
        user: 0,
        agent: 0,
        subagent: 0,
        failed: 0,
        firstDay: null,
        lastDay: null,
        weekCounts: Array<number>(weeks.length).fill(0),
        weekSessions: Array<number>(weeks.length).fill(0),
        byProject: {},
        description: inst.description,
        displayPath: inst.displayPath,
        upstream: inst.upstream,
        policy: evaluateSkillPolicy(policyRules, id),
      });
    }

    // Also include skills referenced by exact `skill.use` policy statements even if uninstalled & 0 uses (e.g. `wrangler`)
    for (const rule of policyRules) {
      const pattern = rule.pattern;
      if (!pattern || /[*?]/.test(pattern) || seenIds.has(pattern)) continue;
      seenIds.add(pattern);
      rows.push({
        id: pattern,
        name: pattern,
        installed: false,
        total: 0,
        sessions: 0,
        user: 0,
        agent: 0,
        subagent: 0,
        failed: 0,
        firstDay: null,
        lastDay: null,
        weekCounts: Array<number>(weeks.length).fill(0),
        weekSessions: Array<number>(weeks.length).fill(0),
        byProject: {},
        description: null,
        displayPath: null,
        upstream: upstreamById.get(pattern) ?? null,
        policy: evaluateSkillPolicy(policyRules, pattern),
      });
    }

    const deniedCount = rows.filter((r) => r.policy.effect === 'deny').length;

    rows.sort((a, b) => b.total - a.total || b.sessions - a.sessions || a.id.localeCompare(b.id));

    const daily: SkillHeatmapDay[] = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, info]) => ({
        day,
        count: info.count,
        sessions: info.sessions.size,
        topSkills: [...info.skills.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([k, n]) => `${k} (${n})`),
      }));

    const firstEvent = windowedEvents[0];
    const lastEvent = windowedEvents[windowedEvents.length - 1];
    const dateRange: [string, string] | null = firstEvent && lastEvent
      ? [localDateParts(firstEvent.at).day, localDateParts(lastEvent.at).day]
      : null;

    return {
      generatedAt: new Date().toISOString(),
      dbAvailable,
      dbPath,
      cacheHit,
      scanMs,
      dateRange,
      weeks,
      projects,
      currentProject,
      stats: {
        cleanEvents: windowedEvents.length,
        rootSessions: rootSessionsSet.size,
        distinctSkillsUsed: bySkill.size,
        installedSkillsCount: installed.size,
        dormantInstalledCount,
        deniedCount,
        activeDays: byDay.size,
        excludedEvalSessions: memoryCache?.excludedEvalSessions ?? 0,
        forkClonedMessagesSkipped: memoryCache?.forkClonedMessagesSkipped ?? 0,
        dedupedHandoffs: memoryCache?.dedupedHandoffs ?? 0,
      },
      daily,
      dowHour,
      skills: rows,
    };
  };

  const invalidate = (): void => {
    lastSyncedAt = 0;
  };

  return { query, invalidate };
};
