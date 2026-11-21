export type SkillScope = 'session' | 'subagent';

export type SkillTrigger = 'user' | 'agent' | 'subagent';

export type SkillStatus = 'active' | 'loading' | 'failed';

export type SkillContextDepth = {
  compacted: boolean;
  turnsAgo: number;
  tokensAgo: number | null;
  activationTokens: number | null;
  windowTokens: number | null;
  /** 0..1 position inside the owning context window (0 = start/oldest, 1 = live tip), or null when compacted */
  position: number | null;
};

export type SessionSkillSummary = {
  id: string;
  name: string;
  scope: SkillScope;
  status: SkillStatus;
  primaryTrigger: SkillTrigger;
  triggers: SkillTrigger[];
  actors: string[];
  count: number;
  firstActivatedAt: number;
  lastActivatedAt: number;
  depth: SkillContextDepth;
  directory: string | null;
  displayPath: string | null;
  description: string | null;
  preview: string | null;
  error: string | null;
};

export type SessionSkillsResponse = {
  sessionId: string;
  sseConnected: boolean;
  contextTokens: number | null;
  turnCount: number;
  subagentCount: number;
  subagentActors: string[];
  sessionSkills: SessionSkillSummary[];
  subagentSkills: SessionSkillSummary[];
};

export type SkillsUpdatedNotice = {
  sessionId: string;
};

export const SKILLS_UPDATED_TOPIC = 'skills-updated';
export const HEATMAP_UPDATED_TOPIC = 'heatmap-updated';

export type SkillHeatmapScopeFilter = 'all' | 'direct' | 'subagent';
export type SkillHeatmapWindow = '8w' | '16w' | 'all';

export type SkillHeatmapDay = {
  day: string;
  count: number;
  sessions: number;
  topSkills: string[];
};

export type SkillUpstreamInfo = {
  source: string;
  sourceType: string;
  sourceUrl: string | null;
  ref: string | null;
  skillPath: string | null;
};

export type SkillPolicyEffect = 'allow' | 'deny';

export type SkillPolicyState = {
  effect: SkillPolicyEffect;
  explicit: boolean;
  pattern: string | null;
  sourcePath: string | null;
};

export type SkillHeatmapRow = {
  id: string;
  name: string;
  installed: boolean;
  total: number;
  sessions: number;
  user: number;
  agent: number;
  subagent: number;
  failed: number;
  firstDay: string | null;
  lastDay: string | null;
  weekCounts: number[];
  weekSessions: number[];
  byProject: Record<string, number>;
  description: string | null;
  displayPath: string | null;
  upstream: SkillUpstreamInfo | null;
  policy: SkillPolicyState;
};

export type SkillHeatmapResponse = {
  generatedAt: string;
  dbAvailable: boolean;
  dbPath: string | null;
  cacheHit: boolean;
  scanMs: number;
  dateRange: [string, string] | null;
  weeks: string[];
  projects: string[];
  currentProject: string | null;
  stats: {
    cleanEvents: number;
    rootSessions: number;
    distinctSkillsUsed: number;
    installedSkillsCount: number;
    dormantInstalledCount: number;
    deniedCount: number;
    activeDays: number;
    excludedEvalSessions: number;
    forkClonedMessagesSkipped: number;
    dedupedHandoffs: number;
  };
  daily: SkillHeatmapDay[];
  dowHour: number[][];
  skills: SkillHeatmapRow[];
};
