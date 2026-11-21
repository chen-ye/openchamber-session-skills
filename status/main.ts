import {
  connectHost,
  HostRequestError,
  type HostReadyContext,
} from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountPopoverAnchor,
  type Handle,
  type PopoverAnchorHandle,
  type Tone,
} from '@openchamber/sdk/ui';
import {
  SKILLS_UPDATED_TOPIC,
  type SessionSkillSummary,
  type SessionSkillsResponse,
  type SkillContextDepth,
  type SkillHeatmapResponse,
  type SkillScope,
  type SkillStatus,
  type SkillTrigger,
} from '../shared/types.ts';

const STATUS_MIN_HEIGHT = 24;
const STATUS_MAX_HEIGHT = 320;
const POPOVER_MIN_HEIGHT = 64;
const POPOVER_MAX_HEIGHT = 480;
const POPOVER_WIDTH = 368;
const POPOVER_INITIAL_HEIGHT = 260;
const HEATMAP_POPOVER_ID = 'skill-heatmap';
const HEATMAP_POPOVER_WIDTH = 560;
const HEATMAP_POPOVER_HEIGHT = 420;
const DEEP_CONTEXT_TOKENS_THRESHOLD = 100_000;

export type VisualFreshnessTone = 'fresh' | 'deep' | 'compacted' | 'loading' | 'failed';

const isRecord = (val: unknown): val is Record<string, unknown> => (
  Boolean(val) && typeof val === 'object' && !Array.isArray(val)
);

const isSkillScope = (val: unknown): val is SkillScope => (
  val === 'session' || val === 'subagent'
);

const isSkillTrigger = (val: unknown): val is SkillTrigger => (
  val === 'user' || val === 'agent' || val === 'subagent'
);

const isSkillStatus = (val: unknown): val is SkillStatus => (
  val === 'active' || val === 'loading' || val === 'failed'
);

const parseDepth = (raw: unknown): SkillContextDepth => {
  if (!isRecord(raw)) {
    return {
      compacted: false,
      turnsAgo: 0,
      tokensAgo: null,
      activationTokens: null,
      windowTokens: null,
      position: 1,
    };
  }
  return {
    compacted: Boolean(raw.compacted),
    turnsAgo: typeof raw.turnsAgo === 'number' && Number.isFinite(raw.turnsAgo)
      ? Math.max(0, Math.floor(raw.turnsAgo))
      : 0,
    tokensAgo: typeof raw.tokensAgo === 'number' && Number.isFinite(raw.tokensAgo) ? raw.tokensAgo : null,
    activationTokens: typeof raw.activationTokens === 'number' && Number.isFinite(raw.activationTokens)
      ? raw.activationTokens
      : null,
    windowTokens: typeof raw.windowTokens === 'number' && Number.isFinite(raw.windowTokens)
      ? raw.windowTokens
      : null,
    position: typeof raw.position === 'number' && Number.isFinite(raw.position)
      ? Math.max(0, Math.min(1, raw.position))
      : null,
  };
};

const parseSkillSummary = (raw: unknown): SessionSkillSummary | null => {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || !isSkillStatus(raw.status) || !isSkillTrigger(raw.primaryTrigger)) return null;

  const scope: SkillScope = isSkillScope(raw.scope) ? raw.scope : 'session';
  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers.filter(isSkillTrigger)
    : [raw.primaryTrigger];
  const actors = Array.isArray(raw.actors)
    ? raw.actors.filter((a): a is string => typeof a === 'string' && a.length > 0)
    : [];

  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
    scope,
    status: raw.status,
    primaryTrigger: raw.primaryTrigger,
    triggers,
    actors,
    count: typeof raw.count === 'number' && raw.count > 0 ? raw.count : 1,
    firstActivatedAt: typeof raw.firstActivatedAt === 'number' ? raw.firstActivatedAt : 0,
    lastActivatedAt: typeof raw.lastActivatedAt === 'number' ? raw.lastActivatedAt : 0,
    depth: parseDepth(raw.depth),
    directory: typeof raw.directory === 'string' ? raw.directory : null,
    displayPath: typeof raw.displayPath === 'string' ? raw.displayPath : null,
    description: typeof raw.description === 'string' ? raw.description : null,
    preview: typeof raw.preview === 'string' ? raw.preview : null,
    error: typeof raw.error === 'string' ? raw.error : null,
  };
};

const parseSkillsResponse = (bodyText: string): SessionSkillsResponse | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (
    !isRecord(raw)
    || typeof raw.sessionId !== 'string'
    || !Array.isArray(raw.sessionSkills)
    || !Array.isArray(raw.subagentSkills)
  ) {
    return null;
  }
  return {
    sessionId: raw.sessionId,
    sseConnected: Boolean(raw.sseConnected),
    contextTokens: typeof raw.contextTokens === 'number' ? raw.contextTokens : null,
    turnCount: typeof raw.turnCount === 'number' ? raw.turnCount : 0,
    subagentCount: typeof raw.subagentCount === 'number' ? raw.subagentCount : 0,
    subagentActors: Array.isArray(raw.subagentActors)
      ? raw.subagentActors.filter((a): a is string => typeof a === 'string' && a.length > 0)
      : [],
    sessionSkills: raw.sessionSkills
      .map(parseSkillSummary)
      .filter((s): s is SessionSkillSummary => s !== null),
    subagentSkills: raw.subagentSkills
      .map(parseSkillSummary)
      .filter((s): s is SessionSkillSummary => s !== null),
  };
};

export const formatCompactTokens = (tokens: number): string => {
  if (tokens < 1_000) return `${Math.round(tokens)}`;
  if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
};

export const formatTurnAgeLabel = (skill: SessionSkillSummary): string => {
  if (skill.status === 'failed') return 'failed';
  if (skill.status === 'loading') return 'now';
  if (skill.depth.compacted) return `${Math.max(1, skill.depth.turnsAgo)}t`;
  return skill.depth.turnsAgo === 0 ? 'now' : `${skill.depth.turnsAgo}t`;
};

export const deriveVisualTone = (skill: SessionSkillSummary): VisualFreshnessTone => {
  if (skill.status === 'failed') return 'failed';
  if (skill.status === 'loading') return 'loading';
  if (skill.depth.compacted) return 'compacted';
  if (skill.depth.tokensAgo !== null && skill.depth.tokensAgo >= DEEP_CONTEXT_TOKENS_THRESHOLD) {
    return 'deep';
  }
  return 'fresh';
};

export const formatSubagentGroupTitle = (subagentActors: readonly string[]): string => {
  if (subagentActors.length === 1 && subagentActors[0]) {
    return `Subagent · ${subagentActors[0]}`;
  }
  return 'Subagents';
};

const formatTurnsPhrase = (turnsAgo: number): string => {
  if (turnsAgo === 0) return 'This turn';
  if (turnsAgo === 1) return '1 turn ago';
  return `${turnsAgo} turns ago`;
};

export const formatDepthSummary = (skill: SessionSkillSummary): {
  readonly left: string;
  readonly right: string;
} => {
  const { depth } = skill;
  const turnsPhrase = formatTurnsPhrase(depth.turnsAgo);

  if (depth.compacted) {
    return {
      left: 'Compacted out of active window',
      right: turnsPhrase,
    };
  }

  if (depth.tokensAgo !== null && depth.windowTokens !== null && depth.activationTokens !== null) {
    const winLabel = formatCompactTokens(depth.windowTokens);
    const actLabel = formatCompactTokens(depth.activationTokens);
    const scopeNoun = skill.scope === 'subagent' ? 'subagent ctx' : 'ctx';
    if (depth.tokensAgo === 0) {
      return {
        left: `${turnsPhrase} · at context tip`,
        right: `${winLabel} ${scopeNoun}`,
      };
    }
    return {
      left: `${turnsPhrase} · ${formatCompactTokens(depth.tokensAgo)} tok deep`,
      right: `at ${actLabel} / ${winLabel}`,
    };
  }

  return {
    left: turnsPhrase,
    right: skill.scope === 'subagent' ? 'subagent window' : 'active window',
  };
};

const formatDetailedProvenance = (skill: SessionSkillSummary): string => {
  const parts: string[] = [];
  if (skill.scope === 'subagent') {
    const names = skill.actors.length > 0 ? skill.actors.join(', ') : 'subagent';
    parts.push(`Subagent (${names})`);
  } else {
    if (skill.triggers.includes('user')) {
      parts.push('Attached in prompt ($skill)');
    }
    if (skill.triggers.includes('agent')) {
      const agents = skill.actors.filter((a) => a !== 'You');
      parts.push(agents.length > 0 ? `Loaded by ${agents.join(', ')}` : 'Loaded by session agent');
    }
  }
  if (skill.count > 1 && skill.status === 'active') {
    parts.push(`${skill.count} activations`);
  }
  return parts.join(' · ') || 'Activated in this session';
};

const statusBadgeProps = (skill: SessionSkillSummary): { label: string; tone: Tone } => {
  if (skill.status === 'loading') return { label: 'Loading', tone: 'info' };
  if (skill.status === 'failed') return { label: 'Failed', tone: 'error' };
  if (skill.depth.compacted) return { label: 'Compacted', tone: 'neutral' };
  return { label: 'Active', tone: 'success' };
};

export const toBoundedPopoverPayload = (skill: SessionSkillSummary): SessionSkillSummary => ({
  id: skill.id.slice(0, 128),
  name: skill.name.slice(0, 128),
  scope: skill.scope,
  status: skill.status,
  primaryTrigger: skill.primaryTrigger,
  triggers: skill.triggers.slice(0, 3),
  actors: skill.actors.slice(0, 12).map((a) => a.slice(0, 64)),
  count: skill.count,
  firstActivatedAt: skill.firstActivatedAt,
  lastActivatedAt: skill.lastActivatedAt,
  depth: skill.depth,
  directory: skill.directory ? skill.directory.slice(0, 512) : null,
  displayPath: skill.displayPath ? skill.displayPath.slice(0, 512) : null,
  description: skill.description ? skill.description.slice(0, 240) : null,
  preview: skill.preview ? skill.preview.slice(0, 1_500) : null,
  error: skill.error ? skill.error.slice(0, 400) : null,
});

const buildContextBarElement = (skill: SessionSkillSummary, extraClass?: string): HTMLElement => {
  const barEl = document.createElement('span');
  barEl.className = extraClass ? `ss-bar ${extraClass}` : 'ss-bar';
  barEl.setAttribute('aria-hidden', 'true');

  if (skill.depth.compacted) {
    barEl.dataset.compacted = 'true';
    return barEl;
  }

  const pos = skill.depth.position ?? 1;
  const posPct = Math.round(Math.max(0, Math.min(100, pos * 100)) * 10) / 10;
  barEl.style.setProperty('--pip-pct', `${posPct}%`);

  if (posPct < 98) {
    const tailEl = document.createElement('span');
    tailEl.className = 'ss-bar-tail';
    barEl.appendChild(tailEl);
  }

  const pipEl = document.createElement('span');
  pipEl.className = 'ss-bar-pip';
  pipEl.dataset.tone = deriveVisualTone(skill);
  barEl.appendChild(pipEl);

  return barEl;
};

const createChevronSvg = (): SVGSVGElement => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ss-chevron');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M6 3.75L10.25 8L6 12.25');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
};

export const bootStatusApp = (): void => {
  const host = connectHost();
  const root = document.querySelector<HTMLElement>('#root');
  if (!root) return;

  let latestContext: HostReadyContext | null = null;
  let mountedSurface: 'status' | 'popover' | null = null;
  let initializedSession = false;
  let currentSessionId: string | null = null;
  let lastReportedHeight: number | null = null;
  let fetchSeq = 0;
  let sessionSkills: SessionSkillSummary[] = [];
  let subagentSkills: SessionSkillSummary[] = [];
  let subagentActors: string[] = [];
  let subagentsExpanded = true;
  let statusMessage: { text: string; tone: 'muted' | 'warning' } | null = {
    text: 'No skills activated yet',
    tone: 'muted',
  };
  let expandedInlineKey: string | null = null;
  const lifecyclePhases = new Map<string, string>();

  const activeDisposers: Array<() => void> = [];

  const clearActiveHandles = (): void => {
    while (activeDisposers.length > 0) {
      const dispose = activeDisposers.pop();
      try {
        dispose?.();
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  const syncFrameHeight = (minPx: number, maxPx: number): void => {
    const measured = Math.ceil(root.getBoundingClientRect().height);
    const clamped = Math.max(minPx, Math.min(maxPx, measured || minPx));
    if (clamped === lastReportedHeight) return;
    lastReportedHeight = clamped;
    void host.setHeight(clamped).catch(() => {});
  };

  const mountSkillDetailCard = (
    container: HTMLElement,
    skill: SessionSkillSummary,
    options: { isPopover: boolean },
  ): Array<Handle<unknown>> => {
    const handles: Array<Handle<unknown>> = [];

    if (options.isPopover) {
      const header = document.createElement('div');
      header.className = 'ss-pop-header';

      const title = document.createElement('h2');
      title.className = 'ss-pop-title';
      title.textContent = skill.id;
      header.appendChild(title);

      const badgeWrap = document.createElement('div');
      handles.push(mountBadge(badgeWrap, statusBadgeProps(skill)) as Handle<unknown>);
      header.appendChild(badgeWrap);

      container.appendChild(header);
    }

    if (skill.status === 'failed' && skill.error) {
      const bannerWrap = document.createElement('div');
      handles.push(
        mountBanner(bannerWrap, {
          tone: 'error',
          title: 'Skill failed to load',
          body: skill.error,
        }) as Handle<unknown>,
      );
      container.appendChild(bannerWrap);
    } else {
      const depthCard = document.createElement('div');
      depthCard.className = 'ss-pop-depth';

      const metaRow = document.createElement('div');
      metaRow.className = 'ss-pop-depth-meta';
      const summary = formatDepthSummary(skill);

      const leftSpan = document.createElement('span');
      leftSpan.className = 'ss-pop-depth-primary';
      leftSpan.textContent = summary.left;
      metaRow.appendChild(leftSpan);

      const rightSpan = document.createElement('span');
      rightSpan.textContent = summary.right;
      metaRow.appendChild(rightSpan);

      depthCard.appendChild(metaRow);
      depthCard.appendChild(buildContextBarElement(skill, 'ss-pop-bar'));
      container.appendChild(depthCard);
    }

    if (skill.description) {
      const desc = document.createElement('p');
      desc.className = 'ss-pop-desc';
      desc.textContent = skill.description;
      container.appendChild(desc);
    }

    const prov = document.createElement('div');
    prov.className = 'ss-pop-prov';
    const summaryLine = document.createElement('div');
    summaryLine.textContent = formatDetailedProvenance(skill);
    prov.appendChild(summaryLine);

    if (skill.displayPath) {
      const pathLine = document.createElement('div');
      pathLine.className = 'ss-pop-path';
      const displayFile = `${skill.displayPath}/SKILL.md`;
      pathLine.textContent = displayFile;
      pathLine.title = displayFile;
      prov.appendChild(pathLine);
    }
    container.appendChild(prov);

    if (skill.preview) {
      const pre = document.createElement('pre');
      pre.className = 'ss-pop-preview';
      pre.textContent = skill.preview;
      container.appendChild(pre);
    }

    const actions = document.createElement('div');
    actions.className = 'ss-pop-actions';

    const insertWrap = document.createElement('span');
    handles.push(
      mountButton(insertWrap, {
        label: 'Insert in chat',
        size: 'xs',
        variant: 'secondary',
        onClick: () => {
          void (async () => {
            try {
              await host.compose({ text: `$${skill.id} `, mode: 'append' });
              await host.toast({ kind: 'info', message: `Added $${skill.id} to message` });
              if (options.isPopover) {
                await host.close();
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Could not update composer';
              await host.toast({ kind: 'error', message: msg }).catch(() => {});
            }
          })();
        },
      }) as Handle<unknown>,
    );
    actions.appendChild(insertWrap);

    const copyTriggerWrap = document.createElement('span');
    handles.push(
      mountButton(copyTriggerWrap, {
        label: 'Copy $skill',
        size: 'xs',
        variant: 'outline',
        onClick: () => {
          void (async () => {
            try {
              await host.writeClipboard(`$${skill.id}`);
              await host.toast({ kind: 'success', message: `Copied $${skill.id}` });
            } catch {
              await host.toast({ kind: 'error', message: 'Clipboard copy failed' }).catch(() => {});
            }
          })();
        },
      }) as Handle<unknown>,
    );
    actions.appendChild(copyTriggerWrap);

    if (skill.directory) {
      const fullPath = `${skill.directory.replace(/\/+$/, '')}/SKILL.md`;
      const copyPathWrap = document.createElement('span');
      handles.push(
        mountButton(copyPathWrap, {
          label: 'Copy path',
          size: 'xs',
          variant: 'outline',
          onClick: () => {
            void (async () => {
              try {
                await host.writeClipboard(fullPath);
                await host.toast({ kind: 'success', message: 'Copied SKILL.md path' });
              } catch {
                await host.toast({ kind: 'error', message: 'Clipboard copy failed' }).catch(() => {});
              }
            })();
          },
        }) as Handle<unknown>,
      );
      actions.appendChild(copyPathWrap);
    }

    container.appendChild(actions);
    return handles;
  };

  const buildSkillRowGroup = (skill: SessionSkillSummary, supportsPopovers: boolean): HTMLElement => {
    const inlineKey = `${skill.scope}:${skill.id}`;
    const tone = deriveVisualTone(skill);
    const depthSummary = formatDepthSummary(skill);

    const groupEl = document.createElement('div');
    groupEl.className = 'ss-row-group';
    groupEl.setAttribute('role', 'listitem');

    const rowBtn = document.createElement('button');
    rowBtn.type = 'button';
    rowBtn.className = 'ss-row';
    rowBtn.dataset.status = skill.status;
    rowBtn.dataset.scope = skill.scope;
    rowBtn.dataset.skillId = skill.id;
    if (skill.depth.compacted) {
      rowBtn.dataset.compacted = 'true';
    }
    rowBtn.title = `${skill.id} — ${depthSummary.left} (${depthSummary.right})`;

    const leftEl = document.createElement('span');
    leftEl.className = 'ss-row-left';

    const dotEl = document.createElement('span');
    dotEl.className = 'ss-dot';
    dotEl.dataset.tone = tone;
    leftEl.appendChild(dotEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'ss-name';
    nameEl.textContent = skill.id;
    leftEl.appendChild(nameEl);

    const rightEl = document.createElement('span');
    rightEl.className = 'ss-row-right';

    if (skill.status === 'failed') {
      const failedSpan = document.createElement('span');
      failedSpan.className = 'ss-failed-label';
      failedSpan.textContent = 'failed';
      rightEl.appendChild(failedSpan);
    } else {
      rightEl.appendChild(buildContextBarElement(skill));

      const ageEl = document.createElement('span');
      ageEl.className = 'ss-age';
      ageEl.dataset.status = skill.status;
      if (
        skill.status === 'active'
        && !skill.depth.compacted
        && skill.depth.turnsAgo === 0
        && (skill.depth.tokensAgo === null || skill.depth.tokensAgo < 25_000)
      ) {
        ageEl.dataset.fresh = 'true';
      }
      ageEl.textContent = formatTurnAgeLabel(skill);
      rightEl.appendChild(ageEl);
    }

    rowBtn.appendChild(leftEl);
    rowBtn.appendChild(rightEl);
    groupEl.appendChild(rowBtn);

    if (supportsPopovers) {
      const popoverPayload = toBoundedPopoverPayload(skill);
      const anchorHandle: PopoverAnchorHandle = mountPopoverAnchor(rowBtn, {
        host,
        width: POPOVER_WIDTH,
        height: POPOVER_INITIAL_HEIGHT,
        side: 'left',
        label: skill.id,
        getData: () => popoverPayload,
      });
      activeDisposers.push(() => anchorHandle.dispose());

      rowBtn.addEventListener('click', () => {
        if (rowBtn.getAttribute('data-oc-popover-open') === 'true') return;
        rowBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      });
    } else {
      const isExpanded = expandedInlineKey === inlineKey;
      rowBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      rowBtn.addEventListener('click', () => {
        expandedInlineKey = expandedInlineKey === inlineKey ? null : inlineKey;
        renderStatusSurface();
      });

      if (isExpanded) {
        const inlineBox = document.createElement('div');
        inlineBox.className = 'ss-inline-detail';
        const subHandles = mountSkillDetailCard(inlineBox, skill, { isPopover: false });
        for (const h of subHandles) {
          activeDisposers.push(() => h.dispose());
        }
        groupEl.appendChild(inlineBox);
      }
    }

    return groupEl;
  };

  const renderStatusSurface = (): void => {
    clearActiveHandles();
    root.replaceChildren();

    const totalSkills = sessionSkills.length + subagentSkills.length;
    if (statusMessage || totalSkills === 0) {
      const note = document.createElement('p');
      note.className = 'ss-note';
      const display = statusMessage ?? { text: 'No skills activated in this session', tone: 'muted' as const };
      note.dataset.tone = display.tone;
      note.textContent = display.text;
      root.appendChild(note);
      syncFrameHeight(STATUS_MIN_HEIGHT, STATUS_MAX_HEIGHT);
      return;
    }

    const supportsPopovers = Boolean(latestContext?.features?.popovers);
    const wrapper = document.createElement('div');
    wrapper.className = 'ss-status-root';

    if (sessionSkills.length > 0) {
      const mainList = document.createElement('div');
      mainList.className = 'ss-status-list';
      mainList.dataset.group = 'session';
      mainList.setAttribute('role', 'list');
      for (const skill of sessionSkills) {
        mainList.appendChild(buildSkillRowGroup(skill, supportsPopovers));
      }
      wrapper.appendChild(mainList);
    }

    if (subagentSkills.length > 0) {
      const subSection = document.createElement('div');
      subSection.className = 'ss-subagent-section';
      if (sessionSkills.length > 0) {
        subSection.dataset.separated = 'true';
      }

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'ss-subagent-toggle';
      toggleBtn.setAttribute('aria-expanded', subagentsExpanded ? 'true' : 'false');
      if (subagentActors.length > 1) {
        toggleBtn.title = `Subagents: ${subagentActors.join(', ')}`;
      }

      const headLeft = document.createElement('span');
      headLeft.className = 'ss-subagent-head-left';
      headLeft.appendChild(createChevronSvg());

      const headLabel = document.createElement('span');
      headLabel.className = 'ss-subagent-label';
      headLabel.textContent = formatSubagentGroupTitle(subagentActors);
      headLeft.appendChild(headLabel);

      const headCount = document.createElement('span');
      headCount.className = 'ss-subagent-count';
      headCount.textContent = String(subagentSkills.length);

      toggleBtn.appendChild(headLeft);
      toggleBtn.appendChild(headCount);
      toggleBtn.addEventListener('click', () => {
        subagentsExpanded = !subagentsExpanded;
        renderStatusSurface();
      });

      subSection.appendChild(toggleBtn);

      if (subagentsExpanded) {
        const subList = document.createElement('div');
        subList.className = 'ss-status-list';
        subList.dataset.group = 'subagent';
        subList.setAttribute('role', 'list');
        for (const skill of subagentSkills) {
          subList.appendChild(buildSkillRowGroup(skill, supportsPopovers));
        }
        subSection.appendChild(subList);
      }

      wrapper.appendChild(subSection);
    }

    root.appendChild(wrapper);
    syncFrameHeight(STATUS_MIN_HEIGHT, STATUS_MAX_HEIGHT);
  };

  const loadSessionSkills = async (sessionId: string | null): Promise<void> => {
    const seq = ++fetchSeq;

    if (!sessionId) {
      sessionSkills = [];
      subagentSkills = [];
      subagentActors = [];
      statusMessage = { text: 'No skills activated yet', tone: 'muted' };
      renderStatusSurface();
      return;
    }

    try {
      const res = await host.serviceRequest({
        method: 'GET',
        path: '/skills',
        query: { sessionId },
      });
      if (seq !== fetchSeq) return;

      if (res.status !== 200) {
        sessionSkills = [];
        subagentSkills = [];
        subagentActors = [];
        statusMessage = { text: 'Could not read session skills', tone: 'warning' };
        renderStatusSurface();
        return;
      }

      const parsed = parseSkillsResponse(res.body);
      if (!parsed) {
        sessionSkills = [];
        subagentSkills = [];
        subagentActors = [];
        statusMessage = { text: 'Received unreadable skill data', tone: 'warning' };
        renderStatusSurface();
        return;
      }

      sessionSkills = parsed.sessionSkills;
      subagentSkills = parsed.subagentSkills;
      subagentActors = parsed.subagentActors;
      const total = parsed.sessionSkills.length + parsed.subagentSkills.length;
      statusMessage = total === 0
        ? { text: 'No skills activated in this session', tone: 'muted' }
        : null;
      renderStatusSurface();
    } catch (err) {
      if (seq !== fetchSeq) return;
      sessionSkills = [];
      subagentSkills = [];
      subagentActors = [];
      if (err instanceof HostRequestError) {
        if (err.code === 'NO_SERVICE' || err.code === 'NOT_GRANTED') {
          statusMessage = {
            text: 'Approve Session Skills in Settings → Extensions',
            tone: 'warning',
          };
        } else if (err.code === 'DISABLED') {
          statusMessage = {
            text: 'Extension is paused in Settings → Extensions',
            tone: 'muted',
          };
        } else {
          statusMessage = {
            text: 'Waiting for Session Skills service…',
            tone: 'muted',
          };
        }
      } else {
        statusMessage = {
          text: 'Waiting for Session Skills service…',
          tone: 'muted',
        };
      }
      renderStatusSurface();
    }
  };

  const mountHeatmapPopover = async (): Promise<void> => {
    clearActiveHandles();
    root.replaceChildren();

    const wrap = document.createElement('div');
    wrap.className = 'ss-hm-popover';

    const header = document.createElement('div');
    header.className = 'ss-pop-header';
    const title = document.createElement('h2');
    title.className = 'ss-pop-title';
    title.textContent = 'Skill Usage Heatmap (8w)';
    header.appendChild(title);

    const badgeWrap = document.createElement('div');
    header.appendChild(badgeWrap);
    wrap.appendChild(header);

    const loadingNote = document.createElement('p');
    loadingNote.className = 'ss-hm-sub';
    loadingNote.textContent = 'Loading opencode.db heatmap…';
    wrap.appendChild(loadingNote);

    root.appendChild(wrap);
    syncFrameHeight(POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT);

    try {
      const res = await host.serviceRequest({
        method: 'GET',
        path: '/heatmap',
        query: { window: '8w' },
      });
      if (res.status !== 200) {
        loadingNote.textContent = 'Could not load skill heatmap.';
        syncFrameHeight(POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT);
        return;
      }
      const parsed = JSON.parse(res.body) as SkillHeatmapResponse;
      if (!isRecord(parsed) || !Array.isArray(parsed.skills) || !Array.isArray(parsed.weeks)) {
        loadingNote.textContent = 'Invalid heatmap data.';
        syncFrameHeight(POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT);
        return;
      }

      let showDormantOnly = false;

      const renderHeatmapInner = (): void => {
        clearActiveHandles();
        wrap.replaceChildren();

        const hdr = document.createElement('div');
        hdr.className = 'ss-pop-header';
        const ttl = document.createElement('h2');
        ttl.className = 'ss-pop-title';
        ttl.textContent = 'Skill Usage Heatmap (8w)';
        hdr.appendChild(ttl);

        const controls = document.createElement('div');
        controls.className = 'ss-pop-actions';
        const toggleWrap = document.createElement('span');
        const toggleBtn = mountButton(toggleWrap, {
          label: showDormantOnly
            ? `All (${parsed.skills.length})`
            : `0 uses (${parsed.stats.dormantInstalledCount})`,
          variant: 'outline',
          size: 'sm',
          onClick: () => {
            showDormantOnly = !showDormantOnly;
            renderHeatmapInner();
          },
        });
        activeDisposers.push(() => toggleBtn.dispose());
        controls.appendChild(toggleWrap);

        const bWrap = document.createElement('span');
        const bHandle = mountBadge(bWrap, {
          label: `${parsed.stats.cleanEvents} uses`,
          tone: 'success',
        });
        activeDisposers.push(() => bHandle.dispose());
        controls.appendChild(bWrap);

        hdr.appendChild(controls);
        wrap.appendChild(hdr);

        const sub = document.createElement('p');
        sub.className = 'ss-hm-sub';
        sub.textContent = `${parsed.stats.distinctSkillsUsed} / ${parsed.stats.installedSkillsCount} installed active · ${parsed.stats.dormantInstalledCount} dormant · Open Extension pages → Skill Usage Heatmap for full view`;
        wrap.appendChild(sub);

        const rows = (showDormantOnly
          ? parsed.skills.filter((s) => s.total === 0)
          : parsed.skills.slice(0, 20));

        let maxVal = 1;
        for (const r of rows) {
          for (const v of r.weekCounts) {
            if (v > maxVal) maxVal = v;
          }
        }

        const tWrap = document.createElement('div');
        tWrap.className = 'ss-hm-table-wrap';
        const table = document.createElement('table');
        table.className = 'ss-hm-table';
        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        const thS = document.createElement('th');
        thS.className = 'left';
        thS.textContent = 'Skill';
        htr.appendChild(thS);
        const thT = document.createElement('th');
        thT.textContent = 'Uses';
        htr.appendChild(thT);
        for (const w of parsed.weeks) {
          const th = document.createElement('th');
          th.textContent = w.slice(5);
          htr.appendChild(th);
        }
        thead.appendChild(htr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const r of rows) {
          const tr = document.createElement('tr');
          const tdS = document.createElement('td');
          tdS.className = 'left';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ss-hm-skill-btn';
          btn.textContent = r.id;
          btn.title = `Click to insert $${r.id} in chat`;
          btn.addEventListener('click', () => {
            void host.compose({ text: `$${r.id} `, mode: 'append' })
              .then(() => host.toast({ kind: 'success', message: `Inserted $${r.id}` }))
              .catch(() => {});
          });
          tdS.appendChild(btn);
          tr.appendChild(tdS);

          const tdT = document.createElement('td');
          tdT.textContent = String(r.total);
          tr.appendChild(tdT);

          for (let i = 0; i < parsed.weeks.length; i += 1) {
            const v = r.weekCounts[i] ?? 0;
            const td = document.createElement('td');
            const cell = document.createElement('span');
            const lvl = v <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(v / maxVal) * 4)));
            cell.className = `ss-hm-cell l${lvl}`;
            cell.textContent = v > 0 ? String(v) : '';
            td.appendChild(cell);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tWrap.appendChild(table);
        wrap.appendChild(tWrap);

        syncFrameHeight(POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT);
      };

      renderHeatmapInner();
    } catch {
      loadingNote.textContent = 'Could not load skill heatmap.';
      syncFrameHeight(POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT);
    }
  };

  const mountPopoverSurface = (ctx: HostReadyContext): void => {
    if (
      ctx.popover?.id === HEATMAP_POPOVER_ID
      || (isRecord(ctx.popover?.data) && ctx.popover.data.kind === 'heatmap')
    ) {
      void mountHeatmapPopover();
      return;
    }

    clearActiveHandles();
    root.replaceChildren();

    const wrap = document.createElement('div');
    wrap.className = 'ss-popover';

    const skill = parseSkillSummary(ctx.popover?.data);
    if (!skill) {
      const empty = document.createElement('p');
      empty.className = 'ss-note';
      empty.textContent = 'Skill details unavailable.';
      wrap.appendChild(empty);
    } else {
      const handles = mountSkillDetailCard(wrap, skill, { isPopover: true });
      for (const h of handles) {
        activeDisposers.push(() => h.dispose());
      }
    }

    root.appendChild(wrap);
    syncFrameHeight(POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT);
  };

  const setupResizeObserver = (minPx: number, maxPx: number): void => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      syncFrameHeight(minPx, maxPx);
    });
    observer.observe(root);
  };

  host.onReady((ctx) => {
    latestContext = ctx;
    applyHostReady(ctx, document.documentElement);

    if (ctx.surface === 'popover') {
      if (mountedSurface !== 'popover') {
        mountedSurface = 'popover';
        setupResizeObserver(POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT);
        mountPopoverSurface(ctx);
      }
      return;
    }

    if (mountedSurface !== 'status') {
      mountedSurface = 'status';
      setupResizeObserver(STATUS_MIN_HEIGHT, STATUS_MAX_HEIGHT);

      if (ctx.features?.statusControls) {
        void host.setStatusControls([{ kind: 'button', id: 'heatmap', label: 'Map' }]).catch(() => {});
        host.onStatusControl(({ id }) => {
          if (id !== 'heatmap') return;
          void host.openSurface('plugin:session-skills').catch(() => {
            if (!latestContext?.features?.popovers) return;
            void host.openPopover({
              id: HEATMAP_POPOVER_ID,
              anchor: { x: 0, y: 0, width: 1, height: 1 },
              width: HEATMAP_POPOVER_WIDTH,
              height: HEATMAP_POPOVER_HEIGHT,
              side: 'left',
              data: { kind: 'heatmap' },
            }).catch(() => {});
          });
        });
      }

      host.onSession((session) => {
        const nextId = session?.id ?? null;
        if (initializedSession && nextId === currentSessionId) return;
        initializedSession = true;
        currentSessionId = nextId;
        expandedInlineKey = null;
        void loadSessionSkills(currentSessionId);
      });

      host.onServiceEvent(({ topic, data }) => {
        if (topic !== SKILLS_UPDATED_TOPIC || !currentSessionId) return;
        if (isRecord(data) && data.sessionId === currentSessionId) {
          void loadSessionSkills(currentSessionId);
        }
      });

      host.onSessionLifecycle(({ sessionId, phase }) => {
        const prev = lifecyclePhases.get(sessionId);
        lifecyclePhases.set(sessionId, phase);
        if (sessionId === currentSessionId && prev === 'started' && phase === 'completed') {
          void loadSessionSkills(currentSessionId);
        }
      });

      if (!initializedSession) {
        initializedSession = true;
        currentSessionId = ctx.session?.id ?? null;
        void loadSessionSkills(currentSessionId);
      }
    }
  });
};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootStatusApp();
}
