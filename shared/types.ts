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
