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
  mountEmpty,
  mountSearchField,
  mountSelect,
  mountTabs,
  type Handle,
  type SelectHandle,
  type TabsHandle,
} from '@openchamber/sdk/ui';
import {
  HEATMAP_UPDATED_TOPIC,
  type SkillHeatmapResponse,
  type SkillHeatmapRow,
  type SkillHeatmapScopeFilter,
  type SkillHeatmapWindow,
} from '../shared/types.ts';

type ActivityFilter = 'all' | 'active' | 'dormant';
type PolicyFilter = 'all' | 'allow' | 'deny' | 'explicit';
type HeatmapMetric = 'events' | 'sessions';
type SortMode = 'total' | 'sessions' | 'recent' | 'dormant' | 'name';
type TabId = 'timeline' | 'projects' | 'cadence';

const isRecord = (val: unknown): val is Record<string, unknown> => (
  Boolean(val) && typeof val === 'object' && !Array.isArray(val)
);

const parseHeatmapResponse = (rawText: string): SkillHeatmapResponse | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw.skills) || !Array.isArray(raw.weeks) || !isRecord(raw.stats)) {
    return null;
  }
  return raw as unknown as SkillHeatmapResponse;
};

const intensityLevel = (val: number, max: number): number => {
  if (val <= 0 || max <= 0) return 0;
  const ratio = Math.sqrt(val / max);
  if (ratio < 0.28) return 1;
  if (ratio < 0.52) return 2;
  if (ratio < 0.78) return 3;
  return 4;
};

const localIsoDay = (dt: Date): string => {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export const filterAndSortHeatmapSkills = (
  skills: readonly SkillHeatmapRow[],
  opts: {
    search: string;
    activity: ActivityFilter;
    policy?: PolicyFilter;
    upstream?: string;
    sort: SortMode;
  },
): SkillHeatmapRow[] => {
  const q = opts.search.trim().toLowerCase();
  const upFilter = opts.upstream ?? 'all';
  const polFilter = opts.policy ?? 'all';
  const filtered = skills.filter((s) => {
    if (opts.activity === 'active' && s.total === 0) return false;
    if (opts.activity === 'dormant' && s.total > 0) return false;
    if (polFilter === 'allow' && s.policy.effect !== 'allow') return false;
    if (polFilter === 'deny' && s.policy.effect !== 'deny') return false;
    if (polFilter === 'explicit' && !s.policy.explicit) return false;
    if (upFilter === '__none__' && s.upstream !== null) return false;
    if (upFilter === '__has__' && s.upstream === null) return false;
    if (upFilter !== 'all' && upFilter !== '__none__' && upFilter !== '__has__' && s.upstream?.source !== upFilter) {
      return false;
    }
    if (q) {
      const hay = `${s.id} ${s.name} ${s.description ?? ''} ${s.upstream?.source ?? ''} ${s.upstream?.sourceUrl ?? ''} ${s.policy.effect} ${s.policy.pattern ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    switch (opts.sort) {
      case 'sessions':
        return b.sessions - a.sessions || b.total - a.total || a.id.localeCompare(b.id);
      case 'recent': {
        const ad = a.lastDay ?? '';
        const bd = b.lastDay ?? '';
        return bd.localeCompare(ad) || b.total - a.total || a.id.localeCompare(b.id);
      }
      case 'dormant':
        return (a.total === 0 ? 0 : 1) - (b.total === 0 ? 0 : 1) || a.total - b.total || a.id.localeCompare(b.id);
      case 'name':
        return a.id.localeCompare(b.id);
      case 'total':
      default:
        return b.total - a.total || b.sessions - a.sessions || a.id.localeCompare(b.id);
    }
  });

  return filtered;
};

const buildUpstreamWebUrl = (sourceUrl: string | null): string | null => {
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;
  return sourceUrl.replace(/\.git$/i, '');
};

const renderUpstreamCell = (upstream: SkillHeatmapRow['upstream']): HTMLTableCellElement => {
  const td = document.createElement('td');
  td.className = 'left sh-upstream-col';
  const span = document.createElement('span');
  if (upstream) {
    span.className = 'sh-upstream';
    span.textContent = upstream.source;
    const tipParts = [`${upstream.source} (${upstream.sourceType})`];
    if (upstream.ref) tipParts.push(`ref: ${upstream.ref}`);
    if (upstream.skillPath) tipParts.push(upstream.skillPath);
    span.title = tipParts.join(' · ');
  } else {
    span.className = 'sh-upstream sh-upstream-empty';
    span.textContent = '—';
    span.title = 'Not tracked in .skill-lock.json';
  }
  td.appendChild(span);
  return td;
};

const formatPolicyTooltip = (policy: SkillHeatmapRow['policy']): string => {
  if (!policy.explicit) return 'skill.use: allow (default)';
  const where = policy.sourcePath ? ` (${policy.sourcePath})` : '';
  return `skill.use "${policy.pattern ?? '*'}" → ${policy.effect}${where}`;
};

const renderPolicyCell = (policy: SkillHeatmapRow['policy']): HTMLTableCellElement => {
  const td = document.createElement('td');
  td.className = 'sh-policy-col';
  const pill = document.createElement('span');
  pill.className = 'sh-policy-pill';
  pill.dataset.effect = policy.effect;
  pill.dataset.explicit = policy.explicit ? 'true' : 'false';
  pill.textContent = policy.effect === 'deny'
    ? 'deny'
    : (policy.explicit ? 'allow*' : 'allow');
  pill.title = formatPolicyTooltip(policy);
  td.appendChild(pill);
  return td;
};

export const bootHeatmapPage = (): void => {
  const host = connectHost();
  const root = document.querySelector<HTMLElement>('#root');
  if (!root) return;

  let currentDirectory: string | null = null;
  let windowFilter: SkillHeatmapWindow = '16w';
  let scopeFilter: SkillHeatmapScopeFilter = 'all';
  let projectFilter = 'all';
  let upstreamFilter = 'all';
  let activityFilter: ActivityFilter = 'all';
  let policyFilter: PolicyFilter = 'all';
  let metric: HeatmapMetric = 'events';
  let sortMode: SortMode = 'total';
  let searchQuery = '';
  let activeTab: TabId = 'timeline';
  let selectedSkillId: string | null = null;
  let savedMatrixScroll: { tab: TabId; top: number; left: number } | null = null;
  let data: SkillHeatmapResponse | null = null;
  let loading = true;
  let errorMsg: string | null = null;
  let fetchSeq = 0;

  // Persistent shell elements so search & filter controls keep focus across re-renders
  const headerEl = document.createElement('header');
  headerEl.className = 'sh-header';
  const titleGroupEl = document.createElement('div');
  titleGroupEl.className = 'sh-title-group';
  const titleRowEl = document.createElement('div');
  titleRowEl.className = 'sh-title-row';
  const h1El = document.createElement('h1');
  h1El.className = 'sh-title';
  h1El.textContent = 'Skill Usage Heatmap';
  const statusBadgeHost = document.createElement('span');
  titleRowEl.append(h1El, statusBadgeHost);
  const subEl = document.createElement('p');
  subEl.className = 'sh-subtitle';
  subEl.textContent = 'Aggregates local skill activations and dormant installed skills from opencode.db';
  titleGroupEl.append(titleRowEl, subEl);
  const headerActionsEl = document.createElement('div');
  headerActionsEl.className = 'sh-header-actions';
  const refreshHost = document.createElement('span');
  headerActionsEl.appendChild(refreshHost);
  headerEl.append(titleGroupEl, headerActionsEl);

  const bannerHost = document.createElement('div');
  const kpisEl = document.createElement('div');
  kpisEl.className = 'sh-kpis';

  const toolbarEl = document.createElement('div');
  toolbarEl.className = 'sh-toolbar';
  const searchHost = document.createElement('div');
  searchHost.className = 'sh-search';
  const filterGroupEl = document.createElement('div');
  filterGroupEl.className = 'sh-filter-group';
  const actHost = document.createElement('span');
  const policyHost = document.createElement('span');
  const winHost = document.createElement('span');
  const scopeHost = document.createElement('span');
  const projHost = document.createElement('span');
  const upstreamHost = document.createElement('span');
  const metricHost = document.createElement('span');
  const sortHost = document.createElement('span');
  filterGroupEl.append(actHost, policyHost, winHost, scopeHost, projHost, upstreamHost, metricHost, sortHost);
  toolbarEl.append(searchHost, filterGroupEl);

  const tabsHost = document.createElement('div');
  const bodyEl = document.createElement('div');
  bodyEl.className = 'sh-body';

  root.replaceChildren(headerEl, bannerHost, kpisEl, toolbarEl, tabsHost, bodyEl);

  const bodyDisposers: Array<() => void> = [];
  const headerDisposers: Array<() => void> = [];

  const clearBodyDisposers = (): void => {
    while (bodyDisposers.length > 0) {
      try {
        bodyDisposers.pop()?.();
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  const trackBody = <T>(h: Handle<T>): Handle<T> => {
    bodyDisposers.push(() => h.dispose());
    return h;
  };

  const refreshBtn = mountButton(refreshHost, {
    label: 'Loading…',
    variant: 'outline',
    size: 'sm',
    disabled: true,
    onClick: () => {
      void fetchHeatmap(true);
    },
  });
  let statusBadgeHandle: Handle<unknown> | null = null;
  let bannerHandle: Handle<unknown> | null = null;

  const searchHandle = mountSearchField(searchHost, {
    value: searchQuery,
    label: 'Filter skills',
    placeholder: 'Filter skills by id, description, or upstream…',
    onChange: (val) => {
      searchQuery = val;
      savedMatrixScroll = null;
      renderBody();
    },
  });

  const actSelect: SelectHandle = mountSelect(actHost, {
    value: activityFilter,
    options: [
      { id: 'all', label: 'All skills' },
      { id: 'active', label: 'Active only' },
      { id: 'dormant', label: 'Zero activations' },
    ],
    onChange: (id) => {
      activityFilter = id as ActivityFilter;
      savedMatrixScroll = null;
      renderHeaderAndControls();
      renderBody();
    },
  });

  const policySelect: SelectHandle = mountSelect(policyHost, {
    value: policyFilter,
    options: [
      { id: 'all', label: 'All policies' },
      { id: 'allow', label: 'Allowed' },
      { id: 'deny', label: 'Denied (skill.use)' },
      { id: 'explicit', label: 'Explicit rules' },
    ],
    onChange: (id) => {
      policyFilter = id as PolicyFilter;
      savedMatrixScroll = null;
      renderHeaderAndControls();
      renderBody();
    },
  });

  const winSelect: SelectHandle = mountSelect(winHost, {
    value: windowFilter,
    options: [
      { id: '8w', label: 'Last 8 weeks' },
      { id: '16w', label: 'Last 16 weeks' },
      { id: 'all', label: 'All time' },
    ],
    onChange: (id) => {
      windowFilter = id as SkillHeatmapWindow;
      void fetchHeatmap(false);
    },
  });

  const scopeSelect: SelectHandle = mountSelect(scopeHost, {
    value: scopeFilter,
    options: [
      { id: 'all', label: 'All scopes' },
      { id: 'direct', label: 'User + Agent' },
      { id: 'subagent', label: 'Subagents only' },
    ],
    onChange: (id) => {
      scopeFilter = id as SkillHeatmapScopeFilter;
      void fetchHeatmap(false);
    },
  });

  const projSelect: SelectHandle = mountSelect(projHost, {
    value: projectFilter,
    options: [{ id: 'all', label: 'All projects' }],
    searchable: true,
    onChange: (id) => {
      projectFilter = id;
      void fetchHeatmap(false);
    },
  });

  const upstreamSelect: SelectHandle = mountSelect(upstreamHost, {
    value: upstreamFilter,
    options: [{ id: 'all', label: 'All upstreams' }],
    searchable: true,
    onChange: (id) => {
      upstreamFilter = id;
      renderBody();
    },
  });

  const metricSelect: SelectHandle = mountSelect(metricHost, {
    value: metric,
    options: [
      { id: 'events', label: 'Metric: Activations' },
      { id: 'sessions', label: 'Metric: Sessions' },
    ],
    onChange: (id) => {
      metric = id as HeatmapMetric;
      renderBody();
    },
  });

  const sortSelect: SelectHandle = mountSelect(sortHost, {
    value: sortMode,
    options: [
      { id: 'total', label: 'Sort: Most used' },
      { id: 'sessions', label: 'Sort: Sessions' },
      { id: 'recent', label: 'Sort: Recently used' },
      { id: 'dormant', label: 'Sort: Zero uses first' },
      { id: 'name', label: 'Sort: Name A–Z' },
    ],
    onChange: (id) => {
      sortMode = id as SortMode;
      renderBody();
    },
  });

  const TAB_ITEMS = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'projects', label: 'Projects' },
    { id: 'cadence', label: 'Cadence' },
  ];

  const handleTabChange = (nextId: string): void => {
    activeTab = nextId as TabId;
    savedMatrixScroll = null;
    tabsHandle.update({
      activeId: activeTab,
      items: TAB_ITEMS,
      onChange: handleTabChange,
    });
    renderBody();
  };

  const tabsHandle: TabsHandle = mountTabs(tabsHost, {
    activeId: activeTab,
    items: TAB_ITEMS,
    onChange: handleTabChange,
  });

  headerDisposers.push(
    () => refreshBtn.dispose(),
    () => searchHandle.dispose(),
    () => actSelect.dispose(),
    () => policySelect.dispose(),
    () => winSelect.dispose(),
    () => scopeSelect.dispose(),
    () => projSelect.dispose(),
    () => upstreamSelect.dispose(),
    () => metricSelect.dispose(),
    () => sortSelect.dispose(),
    () => tabsHandle.dispose(),
  );

  const fetchHeatmap = async (refresh = false): Promise<void> => {
    const seq = ++fetchSeq;
    loading = true;
    renderHeaderAndControls();

    try {
      const query: Record<string, string> = {
        window: windowFilter,
        scope: scopeFilter,
      };
      if (projectFilter !== 'all') query.project = projectFilter;
      if (currentDirectory) query.directory = currentDirectory;
      if (refresh) query.refresh = '1';

      const res = await host.serviceRequest({
        method: 'GET',
        path: '/heatmap',
        query,
      });
      if (seq !== fetchSeq) return;
      loading = false;

      if (res.status !== 200) {
        errorMsg = 'Could not load skill usage heatmap from Session Skills service.';
        renderHeaderAndControls();
        renderBody();
        return;
      }
      const parsed = parseHeatmapResponse(res.body);
      if (!parsed) {
        errorMsg = 'Received invalid heatmap response.';
        renderHeaderAndControls();
        renderBody();
        return;
      }
      data = parsed;
      errorMsg = null;
      if (selectedSkillId && !parsed.skills.some((s) => s.id === selectedSkillId)) {
        selectedSkillId = null;
      }
      renderHeaderAndControls();
      renderBody();
    } catch (err) {
      if (seq !== fetchSeq) return;
      loading = false;
      if (err instanceof HostRequestError && (err.code === 'NO_SERVICE' || err.code === 'NOT_GRANTED')) {
        errorMsg = 'Approve Session Skills in Settings → Extensions to read opencode.db.';
      } else {
        errorMsg = 'Session Skills service is unavailable.';
      }
      renderHeaderAndControls();
      renderBody();
    }
  };

  const renderInspector = (container: HTMLElement, skill: SkillHeatmapRow): void => {
    const box = document.createElement('section');
    box.className = 'sh-inspector';
    box.setAttribute('aria-label', `Selected skill ${skill.id}`);

    const head = document.createElement('div');
    head.className = 'sh-insp-head';

    const title = document.createElement('div');
    title.className = 'sh-insp-title';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = skill.id;
    title.appendChild(nameSpan);

    const badgeWrap = document.createElement('span');
    trackBody(mountBadge(badgeWrap, skill.total > 0
      ? { label: `${skill.total} uses · ${skill.sessions} sessions`, tone: 'success' }
      : { label: '0 activations (dormant)', tone: 'neutral' }));
    title.appendChild(badgeWrap);

    const policyBadgeWrap = document.createElement('span');
    trackBody(mountBadge(policyBadgeWrap, skill.policy.effect === 'deny'
      ? { label: 'Policy: deny', tone: 'error' }
      : (skill.policy.explicit
        ? { label: 'Policy: allow*', tone: 'success' }
        : { label: 'Policy: allow', tone: 'neutral' })));
    title.appendChild(policyBadgeWrap);

    if (!skill.installed) {
      const uninstWrap = document.createElement('span');
      trackBody(mountBadge(uninstWrap, { label: 'Not installed', tone: 'warning' }));
      title.appendChild(uninstWrap);
    }
    head.appendChild(title);

    const closeWrap = document.createElement('div');
    trackBody(mountButton(closeWrap, {
      label: 'Close',
      variant: 'ghost',
      size: 'sm',
      onClick: () => {
        selectedSkillId = null;
        renderBody();
      },
    }));
    head.appendChild(closeWrap);
    box.appendChild(head);

    if (skill.description) {
      const desc = document.createElement('p');
      desc.className = 'sh-insp-desc';
      desc.textContent = skill.description;
      box.appendChild(desc);
    }

    const meta = document.createElement('div');
    meta.className = 'sh-insp-meta';
    const parts = [
      `User: ${skill.user}`,
      `Agent: ${skill.agent}`,
      `Subagent: ${skill.subagent}`,
    ];
    if (skill.failed > 0) parts.push(`Failed: ${skill.failed}`);
    if (skill.firstDay && skill.lastDay) parts.push(`Active: ${skill.firstDay} → ${skill.lastDay}`);
    meta.textContent = parts.join(' · ');
    box.appendChild(meta);

    if (skill.displayPath) {
      const pathEl = document.createElement('div');
      pathEl.className = 'sh-insp-path';
      pathEl.textContent = skill.displayPath;
      box.appendChild(pathEl);
    }

    const policyEl = document.createElement('div');
    policyEl.className = 'sh-insp-path';
    policyEl.textContent = skill.policy.explicit
      ? `OpenCode policy: skill.use "${skill.policy.pattern ?? '*'}" → ${skill.policy.effect}${skill.policy.sourcePath ? ` (${skill.policy.sourcePath})` : ''}`
      : 'OpenCode policy: allow (default; no matching skill.use rule)';
    box.appendChild(policyEl);

    if (skill.upstream) {
      const upEl = document.createElement('div');
      upEl.className = 'sh-insp-path';
      const upParts = [`Upstream (${skill.upstream.sourceType}): ${skill.upstream.source}`];
      if (skill.upstream.ref) upParts.push(`ref ${skill.upstream.ref}`);
      if (skill.upstream.skillPath) upParts.push(skill.upstream.skillPath);
      upEl.textContent = upParts.join(' · ');
      box.appendChild(upEl);
    }

    const actions = document.createElement('div');
    actions.className = 'sh-insp-actions';

    const insertWrap = document.createElement('span');
    trackBody(mountButton(insertWrap, {
      label: 'Insert in chat',
      variant: 'default',
      size: 'sm',
      onClick: async () => {
        try {
          await host.compose({ text: `$${skill.id} `, mode: 'append' });
          await host.toast({ kind: 'success', message: `Inserted $${skill.id}` });
        } catch {
          await host.toast({ kind: 'error', message: 'Could not insert into composer.' });
        }
      },
    }));
    actions.appendChild(insertWrap);

    const copyWrap = document.createElement('span');
    trackBody(mountButton(copyWrap, {
      label: 'Copy $skill',
      variant: 'outline',
      size: 'sm',
      onClick: async () => {
        try {
          await host.writeClipboard(`$${skill.id}`);
          await host.toast({ kind: 'success', message: `Copied $${skill.id}` });
        } catch {
          await host.toast({ kind: 'error', message: 'Clipboard unavailable.' });
        }
      },
    }));
    actions.appendChild(copyWrap);

    if (skill.displayPath) {
      const pathBtnWrap = document.createElement('span');
      const fullPath = skill.displayPath;
      trackBody(mountButton(pathBtnWrap, {
        label: 'Copy path',
        variant: 'outline',
        size: 'sm',
        onClick: async () => {
          try {
            await host.writeClipboard(fullPath);
            await host.toast({ kind: 'success', message: 'Copied SKILL.md path' });
          } catch {
            await host.toast({ kind: 'error', message: 'Clipboard unavailable.' });
          }
        },
      }));
      actions.appendChild(pathBtnWrap);
    }

    const webUpstreamUrl = buildUpstreamWebUrl(skill.upstream?.sourceUrl ?? null);
    if (webUpstreamUrl) {
      const openUpWrap = document.createElement('span');
      trackBody(mountButton(openUpWrap, {
        label: 'Open upstream',
        variant: 'outline',
        size: 'sm',
        onClick: async () => {
          try {
            await host.openUrl(webUpstreamUrl);
          } catch {
            await host.toast({ kind: 'error', message: 'Could not open upstream URL.' });
          }
        },
      }));
      actions.appendChild(openUpWrap);
    } else if (skill.upstream) {
      const copyUpWrap = document.createElement('span');
      const upSource = skill.upstream.source;
      trackBody(mountButton(copyUpWrap, {
        label: 'Copy upstream',
        variant: 'outline',
        size: 'sm',
        onClick: async () => {
          try {
            await host.writeClipboard(upSource);
            await host.toast({ kind: 'success', message: `Copied ${upSource}` });
          } catch {
            await host.toast({ kind: 'error', message: 'Clipboard unavailable.' });
          }
        },
      }));
      actions.appendChild(copyUpWrap);
    }

    box.appendChild(actions);
    container.appendChild(box);
  };

  const renderTimelineTab = (
    container: HTMLElement,
    payload: SkillHeatmapResponse,
    visibleSkills: readonly SkillHeatmapRow[],
  ): void => {
    if (payload.daily.length > 0 && payload.weeks.length > 0) {
      const calCard = document.createElement('section');
      calCard.className = 'sh-card';

      const head = document.createElement('div');
      head.className = 'sh-card-head';
      const title = document.createElement('h2');
      title.className = 'sh-card-title';
      title.textContent = `Daily Skill Activity (${payload.dateRange ? `${payload.dateRange[0]} → ${payload.dateRange[1]}` : 'Window'})`;
      head.appendChild(title);

      const legend = document.createElement('span');
      legend.className = 'sh-legend';
      legend.innerHTML = 'Less <span class="sh-sw l0"></span><span class="sh-sw l1"></span><span class="sh-sw l2"></span><span class="sh-sw l3"></span><span class="sh-sw l4"></span> More';
      head.appendChild(legend);
      calCard.appendChild(head);

      const calWrap = document.createElement('div');
      calWrap.className = 'sh-cal-wrap';

      const dayLabels = document.createElement('div');
      dayLabels.className = 'sh-cal-days';
      dayLabels.innerHTML = '<span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span>Sun</span>';
      calWrap.appendChild(dayLabels);

      const cols = document.createElement('div');
      cols.className = 'sh-cal-cols';

      const dailyMap = new Map(payload.daily.map((d) => [d.day, d]));
      const maxDay = Math.max(1, ...payload.daily.map((d) => (metric === 'sessions' ? d.sessions : d.count)));

      const readout = document.createElement('div');
      readout.className = 'sh-readout';
      readout.textContent = 'Hover or tap any day cell to inspect skill counts.';

      const start = new Date(`${payload.weeks[0]}T12:00:00`);
      const lastWeekStart = new Date(`${payload.weeks[payload.weeks.length - 1]}T12:00:00`);
      const end = new Date(lastWeekStart.getFullYear(), lastWeekStart.getMonth(), lastWeekStart.getDate() + 6);

      for (let cur = new Date(start); cur <= end; ) {
        const col = document.createElement('div');
        col.className = 'sh-cal-col';
        for (let d = 0; d < 7; d += 1) {
          const iso = localIsoDay(cur);
          const rec = dailyMap.get(iso);
          const val = rec ? (metric === 'sessions' ? rec.sessions : rec.count) : 0;
          const cell = document.createElement('button');
          cell.type = 'button';
          cell.className = `sh-cal-cell l${intensityLevel(val, maxDay)}`;
          const msg = rec
            ? `${iso}: ${rec.count} activations across ${rec.sessions} sessions${rec.topSkills.length ? ` — ${rec.topSkills.join(', ')}` : ''}`
            : `${iso}: 0 activations`;
          cell.setAttribute('aria-label', msg);
          cell.title = msg;
          cell.addEventListener('mouseenter', () => { readout.textContent = msg; });
          cell.addEventListener('focus', () => { readout.textContent = msg; });
          cell.addEventListener('click', () => { readout.textContent = msg; });
          col.appendChild(cell);
          cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
        }
        cols.appendChild(col);
      }

      calWrap.appendChild(cols);
      calCard.appendChild(calWrap);
      calCard.appendChild(readout);
      container.appendChild(calCard);
    }

    const matCard = document.createElement('section');
    matCard.className = 'sh-card sh-matrix-card';

    const mHead = document.createElement('div');
    mHead.className = 'sh-card-head';
    const mTitle = document.createElement('h2');
    mTitle.className = 'sh-card-title';
    mTitle.textContent = `Skill × Week Matrix (${visibleSkills.length} shown)`;
    mHead.appendChild(mTitle);

    const mixLegend = document.createElement('span');
    mixLegend.className = 'sh-legend';
    mixLegend.innerHTML = '<span style="color:var(--oc-info,#3b82f6)">■</span> user <span style="color:var(--oc-success,#2fb375)">■</span> agent <span style="color:var(--oc-warning,#e59934)">■</span> subagent';
    mHead.appendChild(mixLegend);
    matCard.appendChild(mHead);

    if (visibleSkills.length === 0) {
      const emptyWrap = document.createElement('div');
      trackBody(mountEmpty(emptyWrap, {
        title: 'No matching skills',
        body: 'Try clearing the search query or switching the activity/project filters.',
      }));
      matCard.appendChild(emptyWrap);
      container.appendChild(matCard);
      return;
    }

    let maxWeekVal = 1;
    for (const sk of visibleSkills) {
      const series = metric === 'sessions' ? sk.weekSessions : sk.weekCounts;
      for (const v of series) {
        if (v > maxWeekVal) maxWeekVal = v;
      }
    }

    const scroll = document.createElement('div');
    scroll.className = 'sh-scroll';

    const table = document.createElement('table');
    table.className = 'sh-table';

    const thead = document.createElement('thead');
    const hdrRow = document.createElement('tr');
    const thSkill = document.createElement('th');
    thSkill.className = 'left';
    thSkill.textContent = 'Skill';
    hdrRow.appendChild(thSkill);

    const thUpstream = document.createElement('th');
    thUpstream.className = 'left sh-upstream-col';
    thUpstream.textContent = 'Upstream';
    hdrRow.appendChild(thUpstream);

    const thPolicy = document.createElement('th');
    thPolicy.className = 'sh-policy-col';
    thPolicy.textContent = 'Policy';
    hdrRow.appendChild(thPolicy);

    const thTot = document.createElement('th');
    thTot.textContent = 'Uses';
    hdrRow.appendChild(thTot);

    const thSess = document.createElement('th');
    thSess.textContent = 'Sess';
    hdrRow.appendChild(thSess);

    const thMix = document.createElement('th');
    thMix.className = 'sh-mix-col';
    thMix.textContent = 'Mix';
    hdrRow.appendChild(thMix);

    for (const w of payload.weeks) {
      const th = document.createElement('th');
      th.textContent = w.slice(5);
      th.title = `Week of ${w}`;
      hdrRow.appendChild(th);
    }
    thead.appendChild(hdrRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const sk of visibleSkills) {
      const tr = document.createElement('tr');
      tr.className = 'sh-skill-row';
      tr.dataset.skillId = sk.id;
      tr.dataset.dormant = sk.total === 0 ? 'true' : 'false';
      tr.dataset.selected = selectedSkillId === sk.id ? 'true' : 'false';
      tr.addEventListener('click', () => {
        savedMatrixScroll = { tab: 'timeline', top: scroll.scrollTop, left: scroll.scrollLeft };
        selectedSkillId = selectedSkillId === sk.id ? null : sk.id;
        renderBody();
      });

      const tdName = document.createElement('td');
      tdName.className = 'left';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sh-skill-btn';
      btn.title = sk.description ? `${sk.id} — ${sk.description}` : sk.id;
      const lbl = document.createElement('span');
      lbl.className = 'sh-skill-label';
      lbl.textContent = sk.id;
      btn.appendChild(lbl);
      if (sk.total === 0) {
        const pill = document.createElement('span');
        pill.className = 'sh-dormant-pill';
        pill.textContent = '0 uses';
        btn.appendChild(pill);
      }
      if (sk.policy.effect === 'deny') {
        const denyPill = document.createElement('span');
        denyPill.className = 'sh-policy-pill';
        denyPill.dataset.effect = 'deny';
        denyPill.textContent = 'denied';
        btn.appendChild(denyPill);
      }
      tdName.appendChild(btn);
      tr.appendChild(tdName);
      tr.appendChild(renderUpstreamCell(sk.upstream));
      tr.appendChild(renderPolicyCell(sk.policy));

      const tdTot = document.createElement('td');
      tdTot.textContent = String(sk.total);
      tr.appendChild(tdTot);

      const tdSess = document.createElement('td');
      tdSess.textContent = String(sk.sessions);
      tr.appendChild(tdSess);

      const tdMix = document.createElement('td');
      tdMix.className = 'sh-mix-col';
      const mix = document.createElement('span');
      mix.className = 'sh-mix';
      if (sk.total > 0) {
        const u = document.createElement('span');
        u.className = 'sh-mix-u';
        u.style.width = `${(sk.user / sk.total) * 100}%`;
        const a = document.createElement('span');
        a.className = 'sh-mix-a';
        a.style.width = `${(sk.agent / sk.total) * 100}%`;
        const s = document.createElement('span');
        s.className = 'sh-mix-s';
        s.style.width = `${(sk.subagent / sk.total) * 100}%`;
        mix.append(u, a, s);
        mix.title = `user: ${sk.user}, agent: ${sk.agent}, subagent: ${sk.subagent}`;
      } else {
        mix.title = 'No activations recorded';
      }
      tdMix.appendChild(mix);
      tr.appendChild(tdMix);

      const series = metric === 'sessions' ? sk.weekSessions : sk.weekCounts;
      for (let i = 0; i < payload.weeks.length; i += 1) {
        const v = series[i] ?? 0;
        const td = document.createElement('td');
        const box = document.createElement('span');
        box.className = `sh-box l${intensityLevel(v, maxWeekVal)}`;
        box.textContent = v > 0 ? String(v) : '';
        box.title = `${sk.id} · week of ${payload.weeks[i]}: ${v} ${metric === 'sessions' ? 'sessions' : 'activations'}`;
        td.appendChild(box);
        tr.appendChild(td);
      }

      tbody.appendChild(tr);

      if (selectedSkillId === sk.id) {
        const detailTr = document.createElement('tr');
        detailTr.className = 'sh-detail-row';
        detailTr.dataset.detailFor = sk.id;
        const detailTd = document.createElement('td');
        detailTd.colSpan = hdrRow.children.length;
        renderInspector(detailTd, sk);
        detailTr.appendChild(detailTd);
        tbody.appendChild(detailTr);
      }
    }

    table.appendChild(tbody);
    scroll.appendChild(table);
    matCard.appendChild(scroll);
    container.appendChild(matCard);
    if (savedMatrixScroll && savedMatrixScroll.tab === 'timeline') {
      scroll.scrollTop = savedMatrixScroll.top;
      scroll.scrollLeft = savedMatrixScroll.left;
    }
    if (selectedSkillId) {
      const detailRow = tbody.querySelector<HTMLElement>('.sh-detail-row');
      if (detailRow) {
        const scrollRect = scroll.getBoundingClientRect();
        const detailRect = detailRow.getBoundingClientRect();
        if (detailRect.bottom > scrollRect.bottom) {
          scroll.scrollTop += detailRect.bottom - scrollRect.bottom + 8;
        } else if (detailRect.top < scrollRect.top) {
          scroll.scrollTop -= scrollRect.top - detailRect.top + 8;
        }
      }
    }
  };

  const renderProjectsTab = (
    container: HTMLElement,
    payload: SkillHeatmapResponse,
    visibleSkills: readonly SkillHeatmapRow[],
  ): void => {
    const card = document.createElement('section');
    card.className = 'sh-card sh-matrix-card';
    const projects = payload.projects.slice(0, 12);

    const head = document.createElement('div');
    head.className = 'sh-card-head';
    const title = document.createElement('h2');
    title.className = 'sh-card-title';
    title.textContent = `Skill × Project Matrix (${visibleSkills.length} skills × ${projects.length} projects)`;
    head.appendChild(title);
    card.appendChild(head);

    if (visibleSkills.length === 0 || projects.length === 0) {
      const emptyWrap = document.createElement('div');
      trackBody(mountEmpty(emptyWrap, {
        title: 'No project matrix data',
        body: 'Adjust filters or wait until skills have been invoked across projects.',
      }));
      card.appendChild(emptyWrap);
      container.appendChild(card);
      return;
    }

    let maxVal = 1;
    for (const sk of visibleSkills) {
      for (const p of projects) {
        const v = sk.byProject[p] ?? 0;
        if (v > maxVal) maxVal = v;
      }
    }

    const scroll = document.createElement('div');
    scroll.className = 'sh-scroll';
    const table = document.createElement('table');
    table.className = 'sh-table';

    const thead = document.createElement('thead');
    const hdr = document.createElement('tr');
    const thSkill = document.createElement('th');
    thSkill.className = 'left';
    thSkill.textContent = 'Skill';
    hdr.appendChild(thSkill);
    const thUpstream = document.createElement('th');
    thUpstream.className = 'left sh-upstream-col';
    thUpstream.textContent = 'Upstream';
    hdr.appendChild(thUpstream);
    const thPolicy = document.createElement('th');
    thPolicy.className = 'sh-policy-col';
    thPolicy.textContent = 'Policy';
    hdr.appendChild(thPolicy);
    const thTot = document.createElement('th');
    thTot.textContent = 'Uses';
    hdr.appendChild(thTot);
    for (const p of projects) {
      const th = document.createElement('th');
      th.textContent = p;
      hdr.appendChild(th);
    }
    thead.appendChild(hdr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const sk of visibleSkills) {
      const tr = document.createElement('tr');
      tr.className = 'sh-skill-row';
      tr.dataset.skillId = sk.id;
      tr.dataset.dormant = sk.total === 0 ? 'true' : 'false';
      tr.dataset.selected = selectedSkillId === sk.id ? 'true' : 'false';
      tr.addEventListener('click', () => {
        savedMatrixScroll = { tab: 'projects', top: scroll.scrollTop, left: scroll.scrollLeft };
        selectedSkillId = selectedSkillId === sk.id ? null : sk.id;
        renderBody();
      });

      const tdName = document.createElement('td');
      tdName.className = 'left';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sh-skill-btn';
      const lbl = document.createElement('span');
      lbl.className = 'sh-skill-label';
      lbl.textContent = sk.id;
      btn.appendChild(lbl);
      if (sk.total === 0) {
        const pill = document.createElement('span');
        pill.className = 'sh-dormant-pill';
        pill.textContent = '0 uses';
        btn.appendChild(pill);
      }
      if (sk.policy.effect === 'deny') {
        const denyPill = document.createElement('span');
        denyPill.className = 'sh-policy-pill';
        denyPill.dataset.effect = 'deny';
        denyPill.textContent = 'denied';
        btn.appendChild(denyPill);
      }
      tdName.appendChild(btn);
      tr.appendChild(tdName);
      tr.appendChild(renderUpstreamCell(sk.upstream));
      tr.appendChild(renderPolicyCell(sk.policy));

      const tdTot = document.createElement('td');
      tdTot.textContent = String(sk.total);
      tr.appendChild(tdTot);

      for (const p of projects) {
        const v = sk.byProject[p] ?? 0;
        const td = document.createElement('td');
        const box = document.createElement('span');
        box.className = `sh-box l${intensityLevel(v, maxVal)}`;
        box.textContent = v > 0 ? String(v) : '';
        box.title = `${sk.id} in ${p}: ${v}`;
        td.appendChild(box);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);

      if (selectedSkillId === sk.id) {
        const detailTr = document.createElement('tr');
        detailTr.className = 'sh-detail-row';
        detailTr.dataset.detailFor = sk.id;
        const detailTd = document.createElement('td');
        detailTd.colSpan = hdr.children.length;
        renderInspector(detailTd, sk);
        detailTr.appendChild(detailTd);
        tbody.appendChild(detailTr);
      }
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    card.appendChild(scroll);
    container.appendChild(card);
    if (savedMatrixScroll && savedMatrixScroll.tab === 'projects') {
      scroll.scrollTop = savedMatrixScroll.top;
      scroll.scrollLeft = savedMatrixScroll.left;
    }
    if (selectedSkillId) {
      const detailRow = tbody.querySelector<HTMLElement>('.sh-detail-row');
      if (detailRow) {
        const scrollRect = scroll.getBoundingClientRect();
        const detailRect = detailRow.getBoundingClientRect();
        if (detailRect.bottom > scrollRect.bottom) {
          scroll.scrollTop += detailRect.bottom - scrollRect.bottom + 8;
        } else if (detailRect.top < scrollRect.top) {
          scroll.scrollTop -= scrollRect.top - detailRect.top + 8;
        }
      }
    }
  };

  const renderCadenceTab = (container: HTMLElement, payload: SkillHeatmapResponse): void => {
    const card = document.createElement('section');
    card.className = 'sh-card';

    const head = document.createElement('div');
    head.className = 'sh-card-head';
    const title = document.createElement('h2');
    title.className = 'sh-card-title';
    title.textContent = 'Local Cadence (Weekday × Hour)';
    head.appendChild(title);
    card.appendChild(head);

    const readout = document.createElement('div');
    readout.className = 'sh-readout';
    readout.textContent = 'Hover or tap any hour slot.';

    const maxHr = Math.max(1, ...payload.dowHour.flat());
    const scroll = document.createElement('div');
    scroll.className = 'sh-scroll';
    const table = document.createElement('table');
    table.className = 'sh-table';

    const thead = document.createElement('thead');
    const hdr = document.createElement('tr');
    const thDay = document.createElement('th');
    thDay.className = 'left';
    thDay.textContent = 'Day';
    hdr.appendChild(thDay);
    for (let h = 0; h < 24; h += 1) {
      const th = document.createElement('th');
      th.textContent = String(h).padStart(2, '0');
      hdr.appendChild(th);
    }
    thead.appendChild(hdr);
    table.appendChild(thead);

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const tbody = document.createElement('tbody');
    for (let d = 0; d < 7; d += 1) {
      const tr = document.createElement('tr');
      const tdDay = document.createElement('td');
      tdDay.className = 'left';
      tdDay.textContent = dayNames[d] ?? '';
      tr.appendChild(tdDay);

      const row = payload.dowHour[d] ?? [];
      for (let h = 0; h < 24; h += 1) {
        const v = row[h] ?? 0;
        const td = document.createElement('td');
        const box = document.createElement('span');
        box.className = `sh-box l${intensityLevel(v, maxHr)}`;
        box.textContent = v > 0 ? String(v) : '';
        const msg = `${dayNames[d]} ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59 local: ${v} activations`;
        box.title = msg;
        box.addEventListener('mouseenter', () => { readout.textContent = msg; });
        box.addEventListener('click', () => { readout.textContent = msg; });
        td.appendChild(box);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    scroll.appendChild(table);
    card.appendChild(scroll);
    card.appendChild(readout);
    container.appendChild(card);
  };

  const renderHeaderAndControls = (): void => {
    refreshBtn.update({
      label: loading ? 'Loading…' : 'Refresh',
      variant: 'outline',
      size: 'sm',
      disabled: loading,
      onClick: () => {
        void fetchHeatmap(true);
      },
    });

    statusBadgeHandle?.dispose();
    statusBadgeHandle = null;
    statusBadgeHost.replaceChildren();
    if (data) {
      statusBadgeHandle = mountBadge(statusBadgeHost, data.dbAvailable
        ? { label: `${data.scanMs}ms · ${data.cacheHit ? 'cached' : 'synced'}`, tone: 'success' }
        : { label: 'DB unavailable', tone: 'warning' });
    }

    if (data) {
      const span = data.dateRange ? `${data.dateRange[0]} → ${data.dateRange[1]}` : 'No recorded activations';
      subEl.textContent = `${span} · Excludes ${data.stats.excludedEvalSessions} eval/sandbox sessions, ${data.stats.forkClonedMessagesSkipped} fork-cloned msgs, ${data.stats.dedupedHandoffs} duplicate handoffs`;
    }

    bannerHandle?.dispose();
    bannerHandle = null;
    bannerHost.replaceChildren();
    if (errorMsg) {
      bannerHandle = mountBanner(bannerHost, {
        tone: 'warning',
        title: 'Heatmap unavailable',
        body: errorMsg,
      });
    } else if (data && !data.dbAvailable) {
      bannerHandle = mountBanner(bannerHost, {
        tone: 'info',
        title: 'opencode.db not found — showing installed skills only',
        body: 'All locally discovered skills appear below with 0 activations.',
      });
    }

    kpisEl.replaceChildren();
    if (data && !errorMsg) {
      const addKpi = (val: string, lbl: string, opts?: { pressed?: boolean; onClick?: () => void }): void => {
        const valEl = document.createElement('span');
        valEl.className = 'sh-kpi-val';
        valEl.textContent = val;
        const lblEl = document.createElement('span');
        lblEl.className = 'sh-kpi-lbl';
        lblEl.textContent = lbl;

        if (opts?.onClick) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'sh-kpi sh-kpi-btn';
          btn.setAttribute('aria-pressed', opts.pressed ? 'true' : 'false');
          btn.append(valEl, lblEl);
          btn.addEventListener('click', opts.onClick);
          kpisEl.appendChild(btn);
        } else {
          const div = document.createElement('div');
          div.className = 'sh-kpi';
          div.append(valEl, lblEl);
          kpisEl.appendChild(div);
        }
      };

      addKpi(String(data.stats.cleanEvents), `Activations across ${data.stats.rootSessions} sessions`);
      addKpi(`${data.stats.distinctSkillsUsed} / ${data.stats.installedSkillsCount}`, 'Active vs installed skills');
      addKpi(String(data.stats.dormantInstalledCount), 'Zero activations (click to filter)', {
        pressed: activityFilter === 'dormant',
        onClick: () => {
          activityFilter = activityFilter === 'dormant' ? 'all' : 'dormant';
          savedMatrixScroll = null;
          renderHeaderAndControls();
          renderBody();
        },
      });
      addKpi(String(data.stats.deniedCount), 'Denied by skill.use policy', {
        pressed: policyFilter === 'deny',
        onClick: () => {
          policyFilter = policyFilter === 'deny' ? 'all' : 'deny';
          savedMatrixScroll = null;
          renderHeaderAndControls();
          renderBody();
        },
      });
      addKpi(String(data.stats.activeDays), 'Active days in window');
    }

    const activeCount = data ? data.skills.filter((s) => s.total > 0).length : 0;
    const dormantCount = data ? data.skills.filter((s) => s.total === 0).length : 0;
    const allowPolCount = data ? data.skills.filter((s) => s.policy.effect === 'allow').length : 0;
    const denyPolCount = data ? data.skills.filter((s) => s.policy.effect === 'deny').length : 0;
    const explicitPolCount = data ? data.skills.filter((s) => s.policy.explicit).length : 0;

    actSelect.update({
      value: activityFilter,
      options: data
        ? [
          { id: 'all', label: `All skills (${data.skills.length})` },
          { id: 'active', label: `Active only (${activeCount})` },
          { id: 'dormant', label: `Zero activations (${dormantCount})` },
        ]
        : [
          { id: 'all', label: 'All skills' },
          { id: 'active', label: 'Active only' },
          { id: 'dormant', label: 'Zero activations' },
        ],
      onChange: (id) => {
        activityFilter = id as ActivityFilter;
        savedMatrixScroll = null;
        renderHeaderAndControls();
        renderBody();
      },
    });

    policySelect.update({
      value: policyFilter,
      options: data
        ? [
          { id: 'all', label: `All policies (${data.skills.length})` },
          { id: 'allow', label: `Allowed (${allowPolCount})` },
          { id: 'deny', label: `Denied (${denyPolCount})` },
          { id: 'explicit', label: `Explicit rules (${explicitPolCount})` },
        ]
        : [
          { id: 'all', label: 'All policies' },
          { id: 'allow', label: 'Allowed' },
          { id: 'deny', label: 'Denied (skill.use)' },
          { id: 'explicit', label: 'Explicit rules' },
        ],
      onChange: (id) => {
        policyFilter = id as PolicyFilter;
        savedMatrixScroll = null;
        renderHeaderAndControls();
        renderBody();
      },
    });

    projSelect.update({
      value: projectFilter,
      options: [
        { id: 'all', label: 'All projects' },
        ...(data?.projects ?? []).map((p) => ({
          id: p,
          label: p === data?.currentProject ? `${p} (current)` : p,
        })),
      ],
      searchable: true,
      onChange: (id) => {
        projectFilter = id;
        void fetchHeatmap(false);
      },
    });

    const upstreamCounts = new Map<string, number>();
    let noLockCount = 0;
    let hasLockCount = 0;
    for (const sk of data?.skills ?? []) {
      if (sk.upstream) {
        hasLockCount += 1;
        upstreamCounts.set(sk.upstream.source, (upstreamCounts.get(sk.upstream.source) ?? 0) + 1);
      } else {
        noLockCount += 1;
      }
    }
    const upstreamOptions = [
      { id: 'all', label: 'All upstreams' },
      ...(hasLockCount > 0 ? [{ id: '__has__', label: `Tracked in lockfile (${hasLockCount})` }] : []),
      ...(noLockCount > 0 ? [{ id: '__none__', label: `No lockfile (${noLockCount})` }] : []),
      ...[...upstreamCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([src, cnt]) => ({ id: src, label: `${src} (${cnt})` })),
    ];
    if (
      upstreamFilter !== 'all'
      && upstreamFilter !== '__has__'
      && upstreamFilter !== '__none__'
      && !upstreamCounts.has(upstreamFilter)
    ) {
      upstreamFilter = 'all';
    }
    upstreamSelect.update({
      value: upstreamFilter,
      options: upstreamOptions,
      searchable: true,
      onChange: (id) => {
        upstreamFilter = id;
        renderBody();
      },
    });

    const controlsHidden = Boolean(errorMsg) || !data;
    toolbarEl.hidden = controlsHidden;
    tabsHost.hidden = controlsHidden;
  };

  const renderBody = (): void => {
    clearBodyDisposers();
    bodyEl.replaceChildren();

    if (errorMsg) return;
    if (!data) {
      const note = document.createElement('p');
      note.className = 'sh-subtitle';
      note.textContent = 'Scanning opencode.db for skill activations…';
      bodyEl.appendChild(note);
      return;
    }

    const visibleSkills = filterAndSortHeatmapSkills(data.skills, {
      search: searchQuery,
      activity: activityFilter,
      policy: policyFilter,
      upstream: upstreamFilter,
      sort: sortMode,
    });

    if (activeTab === 'timeline') {
      renderTimelineTab(bodyEl, data, visibleSkills);
    } else if (activeTab === 'projects') {
      renderProjectsTab(bodyEl, data, visibleSkills);
    } else {
      renderCadenceTab(bodyEl, data);
    }
  };

  let initialized = false;
  host.onReady((ctx: HostReadyContext) => {
    applyHostReady(ctx, document.documentElement);
    currentDirectory = ctx.directory ?? null;

    if (!initialized) {
      initialized = true;
      host.onDirectory((dir) => {
        currentDirectory = dir ?? null;
      });
      host.onServiceEvent(({ topic }) => {
        if (topic === HEATMAP_UPDATED_TOPIC) {
          void fetchHeatmap(false);
        }
      });
      renderHeaderAndControls();
      renderBody();
      void fetchHeatmap(false);
    }
  });
};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootHeatmapPage();
}
