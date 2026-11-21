// service/main.ts
import fs2 from "node:fs/promises";
import http from "node:http";
import os2 from "node:os";
import path2 from "node:path";
// node_modules/@openchamber/sdk/dist/scrollbar-style.js
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = new WeakMap;
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== undefined)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1000));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
// node_modules/@openchamber/sdk/dist/manifest.js
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
// node_modules/@openchamber/sdk/dist/session-events.js
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
// node_modules/@openchamber/sdk/dist/service-host.js
var SERVICE_HOST_PATH = "/service/call";
var OPENCHAMBER_HOST_CALLBACK_URL_ENV = "OPENCHAMBER_HOST_CALLBACK_URL";
var SERVICE_HOST_TIMEOUT_MS = 30000;
var SERVICE_SCHEDULE_IDLE_MS = 10 * 60000;
var MENTIONS_IDLE_MS = 10 * 60000;
class ServiceHostError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "ServiceHostError";
    this.code = code;
    this.status = status;
  }
}
var createServiceHost = ({ env }) => {
  const call = async (method, input) => {
    const base = env[OPENCHAMBER_HOST_CALLBACK_URL_ENV];
    const token = env.OPENCHAMBER_SERVICE_TOKEN;
    if (!base || !token)
      throw new ServiceHostError("This service was not started by OpenChamber.", "HOST_UNAVAILABLE", 0);
    let response;
    try {
      response = await fetch(`${base.replace(/\/+$/, "")}${SERVICE_HOST_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(SERVICE_HOST_TIMEOUT_MS)
      });
    } catch {
      throw new ServiceHostError("OpenChamber did not answer.", "HOST_UNAVAILABLE", 0);
    }
    const body = await response.json().catch(() => null);
    if (response.ok && body?.result !== undefined)
      return body.result;
    throw new ServiceHostError(body?.error?.message ?? `OpenChamber answered HTTP ${response.status}.`, body?.error?.code ?? "HOST_UNAVAILABLE", response.status);
  };
  return {
    sessions: {
      start: (input) => call("sessions.start", input),
      send: (sessionId, prompt) => call("sessions.send", { sessionId, prompt }),
      retry: (sessionId) => call("sessions.retry", { sessionId }),
      status: (sessionId) => call("sessions.status", { sessionId }),
      lastReply: (sessionId) => call("sessions.lastReply", { sessionId }),
      stop: (sessionId) => call("sessions.stop", { sessionId }),
      answerPermission: (sessionId, requestId, answer) => call("sessions.answerPermission", { sessionId, requestId, ...answer }),
      answerForm: (sessionId, formId, values, message) => call("sessions.answerForm", { sessionId, formId, values, ...message === undefined ? {} : { message } })
    },
    setInstructions: (directory, text) => call("instructions.set", { directory, text }),
    emit: (topic, data) => call("panels.emit", { topic, data }),
    readSettings: () => call("settings.read", {}).then(({ settings }) => settings),
    needsConfiguration: (message) => call("status.set", { needsConfiguration: message })
  };
};
// node_modules/@openchamber/sdk/dist/file-editor.js
var patternExpressions = new Map;
// node_modules/@openchamber/sdk/dist/contract.js
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 60000;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
var HOST_PUSH_TYPES = new Set([
  "workspace",
  "shells",
  "ready",
  "directory",
  "session",
  "connection",
  "settings",
  "session-lifecycle",
  "item",
  "resolve",
  "action",
  "service-event",
  "status-control-event",
  "popover-closed",
  "file-open",
  "file-snapshot",
  "file-saved",
  "generate-late"
]);
// node_modules/@openchamber/sdk/dist/service-providers.js
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 60000;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var QUOTA_PROVIDER_IDLE_MS = 10 * 60000;
// node_modules/@openchamber/sdk/dist/service-surface.js
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// service/heatmap.ts
import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// service/parser.ts
var MAX_DESCRIPTION_CHARS = 220;
var MAX_PREVIEW_CHARS = 1500;
var MAX_ERROR_CHARS = 400;
var MAX_ACTORS = 16;
var isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
var trimmed = (value) => typeof value === "string" ? value.trim() : "";
var clampUnit = (value, min = 0.04, max = 1) => Math.max(min, Math.min(max, value));
var formatDisplayPath = (rawPath, homeDir) => {
  if (!rawPath)
    return null;
  const normalized = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized)
    return null;
  if (homeDir) {
    const cleanHome = homeDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (cleanHome && normalized === cleanHome)
      return "~";
    if (cleanHome && normalized.startsWith(`${cleanHome}/`)) {
      return `~/${normalized.slice(cleanHome.length + 1)}`;
    }
  }
  return normalized;
};
var unquoteYamlScalar = (raw) => {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).trim();
  }
  return s;
};
var parseFrontmatter = (markdown) => {
  const normalized = markdown.replace(/\r\n/g, `
`);
  if (!normalized.startsWith(`---
`)) {
    return { name: null, description: null, body: normalized };
  }
  const endIdx = normalized.indexOf(`
---
`, 4);
  if (endIdx === -1) {
    return { name: null, description: null, body: normalized };
  }
  const headerLines = normalized.slice(4, endIdx).split(`
`);
  const body = normalized.slice(endIdx + 5);
  let name = null;
  let description = null;
  let blockKey = null;
  const blockLines = [];
  for (const line of headerLines) {
    if (blockKey) {
      if (/^[ \t]+\S/.test(line)) {
        blockLines.push(line.trim());
        continue;
      }
      if (line.trim() === "") {
        continue;
      }
      description = blockLines.join(" ").trim() || description;
      blockKey = null;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match)
      continue;
    const key = match[1];
    const rest = (match[2] ?? "").trim();
    if (key === "name" && rest) {
      name = unquoteYamlScalar(rest) || null;
    } else if (key === "description") {
      if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-" || rest === "") {
        blockKey = "description";
        blockLines.length = 0;
      } else {
        description = unquoteYamlScalar(rest) || null;
      }
    }
  }
  if (blockKey && blockLines.length > 0) {
    description = blockLines.join(" ").trim() || description;
  }
  return { name, description, body };
};
var truncateClean = (text, maxChars) => {
  const clean = text.trim();
  if (clean.length <= maxChars)
    return clean;
  return `${clean.slice(0, maxChars - 1).trimEnd()}…`;
};
var extractFirstSummaryParagraph = (body) => {
  const lines = body.split(`
`);
  const paragraph = [];
  let inFence = false;
  let endLineIdx = -1;
  for (let i = 0;i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("```")) {
      if (paragraph.length > 0) {
        endLineIdx = i;
        break;
      }
      inFence = !inFence;
      continue;
    }
    if (inFence)
      continue;
    if (!line) {
      if (paragraph.length > 0) {
        endLineIdx = i + 1;
        break;
      }
      continue;
    }
    if (line.startsWith("#") || line.startsWith("|") || line.startsWith("---")) {
      if (paragraph.length > 0) {
        endLineIdx = i;
        break;
      }
      continue;
    }
    paragraph.push(line);
    if (paragraph.join(" ").length >= MAX_DESCRIPTION_CHARS) {
      endLineIdx = i + 1;
      break;
    }
  }
  if (paragraph.length === 0) {
    return { summary: null, remainder: body };
  }
  const joined = paragraph.join(" ").replace(/\s+/g, " ").trim();
  const rest = endLineIdx === -1 ? "" : lines.slice(endLineIdx).join(`
`).trim();
  return {
    summary: joined ? truncateClean(joined, MAX_DESCRIPTION_CHARS) : null,
    remainder: rest
  };
};
var parseSkillContent = (rawText) => {
  if (!rawText || typeof rawText !== "string") {
    return { name: null, directory: null, description: null, preview: null };
  }
  let working = rawText.replace(/\r\n/g, `
`);
  let tagName = null;
  const openTagMatch = /<skill_content(?:\s+name="([^"]+)")?\s*>/i.exec(working);
  if (openTagMatch) {
    tagName = trimmed(openTagMatch[1]) || null;
    const startIdx = openTagMatch.index + openTagMatch[0].length;
    const closeIdx = working.indexOf("</skill_content>", startIdx);
    working = closeIdx !== -1 ? working.slice(startIdx, closeIdx) : working.slice(startIdx);
  }
  working = working.replace(/<skill_files>[\s\S]*?<\/skill_files>/gi, "");
  let directory = null;
  const baseDirMatch = /^Base directory for this skill:\s*(.+)$/m.exec(working);
  if (baseDirMatch) {
    directory = trimmed(baseDirMatch[1]) || null;
    working = working.replace(/^Base directory for this skill:\s*.+$/gm, "").replace(/^Relative paths in this skill.*$/gm, "").replace(/^Note:\s*file list is sampled\.\s*$/gm, "");
  }
  const { name: fmName, description: fmDesc, body: afterFm } = parseFrontmatter(working.trim());
  let cleanBody = afterFm.trim();
  let headingSkillName = null;
  const skillHeaderMatch = /^#\s+Skill:\s+([^\n]+)\n+/i.exec(cleanBody);
  if (skillHeaderMatch) {
    headingSkillName = trimmed(skillHeaderMatch[1]) || null;
    cleanBody = cleanBody.slice(skillHeaderMatch[0].length).trim();
  }
  let description = null;
  let previewSource = cleanBody;
  if (fmDesc) {
    description = truncateClean(fmDesc.replace(/\s+/g, " "), MAX_DESCRIPTION_CHARS);
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
    preview
  };
};
var extractSkillTagNameFromToolContent = (content) => {
  if (!Array.isArray(content))
    return { id: null, rawText: null };
  for (const part of content) {
    if (!isRecord(part) || trimmed(part.type) !== "text")
      continue;
    const text = typeof part.text === "string" ? part.text : "";
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
var extractInjectedSubagentSkills = (text) => {
  const normalized = text.replace(/\r\n/g, `
`);
  const pattern = /^\[SKILL:\s*([A-Za-z0-9_.:-]+)\][ \t]*\n/gm;
  const matches = [];
  let m = pattern.exec(normalized);
  while (m !== null) {
    const id = trimmed(m[1]);
    if (id) {
      matches.push({
        id,
        matchStart: m.index,
        contentStart: m.index + m[0].length
      });
    }
    m = pattern.exec(normalized);
  }
  if (matches.length === 0)
    return [];
  return matches.map((entry, idx) => {
    const nextMatch = matches[idx + 1];
    let sliceEnd = nextMatch ? nextMatch.matchStart : Math.min(normalized.length, entry.contentStart + 3000);
    if (!nextMatch) {
      const taskBoundary = normalized.indexOf(`
1. TASK
`, entry.contentStart);
      if (taskBoundary !== -1 && taskBoundary < sliceEnd) {
        sliceEnd = taskBoundary;
      }
    }
    return {
      id: entry.id,
      rawSection: normalized.slice(entry.contentStart, sliceEnd).trim()
    };
  });
};
var readMessageCreatedTimestamp = (msg, fallback) => {
  const time = isRecord(msg.time) ? msg.time : null;
  if (time && typeof time.created === "number" && Number.isFinite(time.created)) {
    return time.created;
  }
  return fallback;
};
var readMessageTimestamp = (msg, fallback) => {
  const time = isRecord(msg.time) ? msg.time : null;
  if (time) {
    if (typeof time.completed === "number" && Number.isFinite(time.completed))
      return time.completed;
    if (typeof time.created === "number" && Number.isFinite(time.created))
      return time.created;
  }
  return fallback;
};
var parseToolInputObject = (rawInput) => {
  if (isRecord(rawInput))
    return rawInput;
  if (typeof rawInput === "string" && rawInput.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawInput);
      if (isRecord(parsed))
        return parsed;
    } catch {
      return {};
    }
  }
  return {};
};
var extractAssistantStepTokens = (msg) => {
  const tokens = isRecord(msg.tokens) ? msg.tokens : null;
  if (!tokens)
    return null;
  const input = typeof tokens.input === "number" && Number.isFinite(tokens.input) ? Math.max(0, tokens.input) : 0;
  const output = typeof tokens.output === "number" && Number.isFinite(tokens.output) ? Math.max(0, tokens.output) : 0;
  const cache = isRecord(tokens.cache) ? tokens.cache : null;
  const cacheRead = cache && typeof cache.read === "number" && Number.isFinite(cache.read) ? Math.max(0, cache.read) : 0;
  const cacheWrite = cache && typeof cache.write === "number" && Number.isFinite(cache.write) ? Math.max(0, cache.write) : 0;
  const promptTokens = input + cacheRead + cacheWrite;
  if (promptTokens <= 0)
    return null;
  return {
    promptTokens,
    endWatermark: promptTokens + output
  };
};
var parseSessionMessages = (params) => {
  const { sessionId, isSubagent, defaultAgent, messages } = params;
  const scope = isSubagent ? "subagent" : "session";
  const records = [];
  const childIds = new Set;
  const childSpawnTurnBySessionId = new Map;
  const persistedMessageIds = new Set;
  const terminalToolCallIds = new Set;
  const subagentHandoffs = [];
  let hasUserMessage = false;
  let lastCompactionIdx = -1;
  let lastTurnOpenMsgIdx = -1;
  const messageTurnIndices = new Array(messages.length).fill(0);
  const turns = [];
  let turnIndex = -1;
  let waitingNewTurn = true;
  let turnHasAssistant = false;
  for (let idx = 0;idx < messages.length; idx += 1) {
    const raw = messages[idx];
    if (!isRecord(raw))
      continue;
    const msgType = trimmed(raw.type);
    const createdAt = readMessageCreatedTimestamp(raw, idx + 1);
    if (msgType === "compaction" && trimmed(raw.status) === "completed") {
      lastCompactionIdx = idx;
      waitingNewTurn = true;
      turnHasAssistant = false;
      messageTurnIndices[idx] = Math.max(0, turnIndex);
      continue;
    }
    if (msgType === "idle") {
      waitingNewTurn = true;
      turnHasAssistant = false;
      messageTurnIndices[idx] = Math.max(0, turnIndex);
      continue;
    }
    if (msgType === "user") {
      if (waitingNewTurn || turnHasAssistant) {
        turnIndex += 1;
        lastTurnOpenMsgIdx = idx;
        turns.push({ turnIndex, startedAt: createdAt });
        waitingNewTurn = false;
        turnHasAssistant = false;
      }
    } else if (msgType === "synthetic" || msgType === "skill") {
      if (waitingNewTurn) {
        turnIndex += 1;
        lastTurnOpenMsgIdx = idx;
        turns.push({ turnIndex, startedAt: createdAt });
        waitingNewTurn = false;
        turnHasAssistant = false;
      }
    } else if (msgType === "assistant") {
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
  const postCompactionAwaitingTurn = lastCompactionIdx > lastTurnOpenMsgIdx && turnIndex >= 0;
  const currentTurnIndex = postCompactionAwaitingTurn ? turnIndex + 1 : Math.max(0, turnIndex);
  const turnCount = turnIndex >= 0 ? postCompactionAwaitingTurn ? turnIndex + 2 : turnIndex + 1 : 0;
  const postCompactionSteps = [];
  for (let idx = lastCompactionIdx + 1;idx < messages.length; idx += 1) {
    const raw = messages[idx];
    if (!isRecord(raw) || trimmed(raw.type) !== "assistant")
      continue;
    const stepTok = extractAssistantStepTokens(raw);
    if (stepTok) {
      postCompactionSteps.push({
        msgIdx: idx,
        promptTokens: stepTok.promptTokens,
        endWatermark: stepTok.endWatermark
      });
    }
  }
  const latestWindowTokens = postCompactionSteps.at(-1)?.endWatermark ?? null;
  const resolveActivationWatermark = (msgIdx) => {
    if (msgIdx < lastCompactionIdx) {
      return { compacted: true, activationTokens: null, windowTokens: null };
    }
    if (latestWindowTokens === null) {
      return { compacted: false, activationTokens: null, windowTokens: null };
    }
    const firstStepAfter = postCompactionSteps.find((s) => s.msgIdx > msgIdx);
    const activationTokens = firstStepAfter ? Math.min(latestWindowTokens, firstStepAfter.endWatermark) : latestWindowTokens;
    return {
      compacted: false,
      activationTokens,
      windowTokens: latestWindowTokens
    };
  };
  for (let idx = 0;idx < messages.length; idx += 1) {
    const raw = messages[idx];
    if (!isRecord(raw))
      continue;
    const msgId = trimmed(raw.id);
    if (msgId)
      persistedMessageIds.add(msgId);
    const msgType = trimmed(raw.type);
    const msgAt = readMessageTimestamp(raw, idx + 1);
    const msgTurn = messageTurnIndices[idx] ?? 0;
    const wm = resolveActivationWatermark(idx);
    if (msgType === "user") {
      hasUserMessage = true;
      if (Array.isArray(raw.skills)) {
        for (const attachment of raw.skills) {
          if (!isRecord(attachment))
            continue;
          const id = trimmed(attachment.id) || trimmed(attachment.name);
          if (!id)
            continue;
          const rawText = typeof attachment.text === "string" ? attachment.text : null;
          const parsed = parseSkillContent(rawText);
          records.push({
            id,
            name: trimmed(attachment.name) || parsed.name || id,
            scope,
            trigger: isSubagent ? "subagent" : "user",
            status: "active",
            at: msgAt,
            turnIndex: msgTurn,
            compacted: wm.compacted,
            activationTokens: wm.activationTokens,
            windowTokens: wm.windowTokens,
            sessionTurnCount: Math.max(1, turnCount),
            actor: isSubagent ? defaultAgent || "subagent" : "You",
            sessionId,
            directory: parsed.directory,
            description: parsed.description,
            preview: parsed.preview,
            error: null
          });
        }
      }
      if (isSubagent && typeof raw.text === "string" && raw.text.includes("[SKILL:")) {
        const injected = extractInjectedSubagentSkills(raw.text);
        for (const item of injected) {
          const parsed = parseSkillContent(item.rawSection);
          records.push({
            id: item.id,
            name: parsed.name || item.id,
            scope: "subagent",
            trigger: "subagent",
            status: "active",
            at: msgAt,
            turnIndex: msgTurn,
            compacted: wm.compacted,
            activationTokens: wm.activationTokens,
            windowTokens: wm.windowTokens,
            sessionTurnCount: Math.max(1, turnCount),
            actor: defaultAgent || "subagent",
            sessionId,
            directory: parsed.directory,
            description: parsed.description,
            preview: parsed.preview,
            error: null
          });
        }
      }
      continue;
    }
    if (msgType === "skill") {
      const id = trimmed(raw.skill) || trimmed(raw.name);
      if (!id)
        continue;
      const rawText = typeof raw.text === "string" ? raw.text : null;
      const parsed = parseSkillContent(rawText);
      records.push({
        id,
        name: trimmed(raw.name) || parsed.name || id,
        scope,
        trigger: isSubagent ? "subagent" : "user",
        status: "active",
        at: msgAt,
        turnIndex: msgTurn,
        compacted: wm.compacted,
        activationTokens: wm.activationTokens,
        windowTokens: wm.windowTokens,
        sessionTurnCount: Math.max(1, turnCount),
        actor: isSubagent ? defaultAgent || "subagent" : "You",
        sessionId,
        directory: parsed.directory,
        description: parsed.description,
        preview: parsed.preview,
        error: null
      });
      continue;
    }
    if (msgType === "assistant") {
      const msgAgent = trimmed(raw.agent) || defaultAgent || null;
      const content = Array.isArray(raw.content) ? raw.content : [];
      for (const part of content) {
        if (!isRecord(part) || trimmed(part.type) !== "tool")
          continue;
        const callId = trimmed(part.id);
        const toolName = trimmed(part.name);
        const state = isRecord(part.state) ? part.state : {};
        const statusRaw = trimmed(state.status);
        if (callId && (statusRaw === "completed" || statusRaw === "error")) {
          terminalToolCallIds.add(callId);
        }
        const input = parseToolInputObject(state.input);
        const metadata = isRecord(state.metadata) ? state.metadata : {};
        const partAt = readMessageTimestamp(part, msgAt);
        if (toolName === "skill") {
          const fromContent = extractSkillTagNameFromToolContent(state.content);
          const id = trimmed(metadata.name) || trimmed(input.id) || trimmed(input.name) || fromContent.id || "";
          if (!id)
            continue;
          const parsed = parseSkillContent(fromContent.rawText);
          const directory = trimmed(metadata.directory) || parsed.directory || null;
          const trigger = isSubagent ? "subagent" : "agent";
          if (statusRaw === "completed") {
            records.push({
              id,
              name: parsed.name || trimmed(metadata.name) || id,
              scope,
              trigger,
              status: "active",
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
              error: null
            });
          } else if (statusRaw === "error") {
            const errObj = isRecord(state.error) ? state.error : null;
            const rawErr = (errObj ? trimmed(errObj.message) : trimmed(state.error)) || `Failed to load ${id}`;
            records.push({
              id,
              name: id,
              scope,
              trigger,
              status: "failed",
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
              error: truncateClean(rawErr, MAX_ERROR_CHARS)
            });
          } else if (statusRaw === "pending" || statusRaw === "running" || statusRaw === "streaming") {
            records.push({
              id,
              name: id,
              scope,
              trigger,
              status: "loading",
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
              error: null
            });
          }
          continue;
        }
        if (toolName === "subagent" || toolName === "task") {
          const childSessionId = trimmed(metadata.sessionID) || trimmed(metadata.sessionId) || null;
          if (childSessionId && /^ses_[\w-]+$/.test(childSessionId)) {
            childIds.add(childSessionId);
            if (!childSpawnTurnBySessionId.has(childSessionId)) {
              childSpawnTurnBySessionId.set(childSessionId, msgTurn);
            }
          }
          if (statusRaw === "error")
            continue;
          const rawSkills = Array.isArray(input.skills) ? input.skills : Array.isArray(input.load_skills) ? input.load_skills : [];
          const skillNames = rawSkills.map((s) => trimmed(s)).filter(Boolean);
          if (skillNames.length > 0) {
            const subagentActor = trimmed(input.agent) || trimmed(input.category) || "subagent";
            subagentHandoffs.push({
              childSessionId,
              skills: skillNames,
              actor: subagentActor,
              at: partAt,
              parentTurnIndex: msgTurn,
              status: statusRaw === "completed" ? "completed" : "loading"
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
    subagentHandoffs
  };
};
var mapTimestampToParentTurn = (params) => {
  const { at, rootTurns, rootCurrentTurnIndex, minTurnIndex = 0 } = params;
  if (rootTurns.length === 0)
    return Math.max(0, minTurnIndex);
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
var computeRecordDepth = (params) => {
  const { rec, effectiveRootTurnIndex, effectiveRootTurnCount } = params;
  const turnsAgo = Math.max(0, effectiveRootTurnIndex - rec.turnIndex);
  if (rec.compacted) {
    return {
      compacted: true,
      turnsAgo: Math.max(1, turnsAgo),
      tokensAgo: null,
      activationTokens: null,
      windowTokens: rec.windowTokens,
      position: null
    };
  }
  if (rec.status === "failed") {
    return {
      compacted: false,
      turnsAgo,
      tokensAgo: null,
      activationTokens: null,
      windowTokens: rec.windowTokens,
      position: null
    };
  }
  if (rec.windowTokens !== null && rec.windowTokens > 0 && rec.activationTokens !== null && rec.activationTokens >= 0) {
    const clampedAct = Math.min(rec.windowTokens, rec.activationTokens);
    const tokensAgo = Math.max(0, rec.windowTokens - clampedAct);
    const position = tokensAgo === 0 ? 1 : clampUnit(clampedAct / rec.windowTokens, 0.05, 0.98);
    return {
      compacted: false,
      turnsAgo,
      tokensAgo,
      activationTokens: clampedAct,
      windowTokens: rec.windowTokens,
      position
    };
  }
  const denom = Math.max(1, rec.scope === "session" ? effectiveRootTurnCount : rec.sessionTurnCount);
  const fallbackPos = turnsAgo === 0 ? 1 : clampUnit((rec.turnIndex + 1) / Math.max(denom, rec.turnIndex + 1), 0.08, 0.96);
  return {
    compacted: false,
    turnsAgo,
    tokensAgo: null,
    activationTokens: null,
    windowTokens: null,
    position: fallbackPos
  };
};
var choosePrimaryTrigger = (triggers) => {
  if (triggers.includes("user"))
    return "user";
  if (triggers.includes("agent"))
    return "agent";
  return "subagent";
};
var aggregateScopedSkills = (params) => {
  const {
    scope,
    records,
    effectiveRootTurnIndex,
    effectiveRootTurnCount,
    diskMetadataByDirectory,
    homeDir
  } = params;
  const sorted = [...records].sort((a, b) => a.at - b.at);
  const map = new Map;
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
        error: rec.error
      };
      map.set(rec.id, acc);
    }
    acc.totalCount += 1;
    if (rec.name && rec.name !== rec.id)
      acc.name = rec.name;
    if (rec.at < acc.firstActivatedAt)
      acc.firstActivatedAt = rec.at;
    if (rec.at >= acc.lastActivatedAt) {
      acc.lastActivatedAt = rec.at;
    }
    if (rec.directory && !acc.directory)
      acc.directory = rec.directory;
    if (rec.description && !acc.description)
      acc.description = rec.description;
    if (rec.preview && !acc.preview)
      acc.preview = rec.preview;
    if (rec.status === "active") {
      acc.hasActive = true;
      acc.activeCount += 1;
      acc.error = null;
      acc.latestDepthRecord = rec;
    } else if (rec.status === "loading") {
      acc.hasLoading = true;
      if (!acc.hasActive) {
        acc.latestDepthRecord = rec;
      }
    } else if (rec.status === "failed" && !acc.hasActive) {
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
  const summaries = [];
  for (const acc of map.values()) {
    const diskMeta = acc.directory ? diskMetadataByDirectory.get(acc.directory) : undefined;
    const description = diskMeta?.description || acc.description || null;
    const preview = (diskMeta?.description ? diskMeta.preview : null) || acc.preview || diskMeta?.preview || null;
    const status = acc.hasActive ? "active" : acc.hasLoading ? "loading" : "failed";
    const depth = computeRecordDepth({
      rec: acc.latestDepthRecord,
      effectiveRootTurnIndex,
      effectiveRootTurnCount
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
      error: status === "failed" && acc.error ? truncateClean(acc.error, MAX_ERROR_CHARS) : null
    });
  }
  return summaries.sort((a, b) => a.firstActivatedAt - b.firstActivatedAt);
};

// service/heatmap.ts
var CACHE_FILENAME = "heatmap-cache-v1.json";
var DEFAULT_CACHE_TTL_MS = 5000;
var INSTALLED_SKILLS_TTL_MS = 30000;
var BUILTIN_ALIASES = [
  ["opencode", "opencode"],
  ["OpenCode", "opencode"],
  ["report", "report"],
  ["Report", "report"],
  ["policy-management", "policy-management"],
  ["Policy Management", "policy-management"],
  ["sift", "sift"],
  ["Sift", "sift"],
  ["slack-headless", "slack-headless"],
  ["Slack Headless Reader", "slack-headless"],
  ["gemini-extension-authoring", "gemini-extension-authoring"],
  ["Gemini Extension Authoring", "gemini-extension-authoring"],
  ["notion-apparel-inventory-management", "notion-apparel-inventory-management"],
  ["Notion Apparel Inventory Management", "notion-apparel-inventory-management"],
  ["skill-development", "skill-development"],
  ["Skill Development", "skill-development"]
];
var localDateParts = (ms) => {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dayNum = String(d.getDate()).padStart(2, "0");
  const day = `${y}-${m}-${dayNum}`;
  const dow = (d.getDay() + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  const wy = monday.getFullYear();
  const wm = String(monday.getMonth() + 1).padStart(2, "0");
  const wd = String(monday.getDate()).padStart(2, "0");
  return { day, week: `${wy}-${wm}-${wd}`, dow, hour: d.getHours() };
};
var deriveProjectLabel = (dir, homeDir) => {
  if (!dir)
    return "unknown";
  const norm = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!norm)
    return "unknown";
  if (norm.includes("/.config/openchamber/chats/"))
    return "openchamber-scratch";
  if (norm.includes("/.local/share/opencode/worktree/"))
    return "opencode-worktree";
  if (homeDir) {
    const cleanHome = homeDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const spacesPrefix = `${cleanHome}/Projects/spaces/`;
    if (norm.startsWith(spacesPrefix)) {
      const seg = norm.slice(spacesPrefix.length).split("/")[0] || "spaces";
      if (seg.startsWith("DISPLAYS-") || seg.startsWith("PR-DISPLAYS-"))
        return "DISPLAYS";
      return seg;
    }
    if (norm === cleanHome)
      return "~";
  }
  return path.basename(norm) || norm;
};
var extractSkillTag = (text) => {
  const m = /<skill_content\s+name="([^"]+)"/i.exec(text);
  return m?.[1]?.trim() || null;
};
var formatUpstreamLabel = (rawSource, sourceType, sourceUrl, homeDir) => {
  if (sourceType === "local") {
    const rawPath = rawSource || sourceUrl || "";
    return formatDisplayPath(rawPath, homeDir) ?? rawPath;
  }
  if (/^https?:\/\//i.test(rawSource)) {
    return rawSource.replace(/^https?:\/\//i, "").replace(/\.git$/i, "");
  }
  if (sourceType === "git" && rawSource && sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
    try {
      const host = new URL(sourceUrl).hostname;
      if (host && host !== "github.com" && !rawSource.startsWith(`${host}/`)) {
        return `${host}/${rawSource}`;
      }
    } catch {}
  }
  if (rawSource)
    return rawSource;
  if (sourceUrl)
    return sourceUrl.replace(/^https?:\/\//i, "").replace(/\.git$/i, "");
  return sourceType;
};
var discoverSkillLockfile = async (homeDir, extraLockfiles = []) => {
  const candidates = [];
  if (homeDir) {
    candidates.push(path.join(homeDir, ".agents", ".skill-lock.json"), path.join(homeDir, ".config", "opencode", ".skill-lock.json"), path.join(homeDir, ".gemini", ".skill-lock.json"));
  }
  for (const p of extraLockfiles) {
    if (p && !candidates.includes(p))
      candidates.push(p);
  }
  const upstreamById = new Map;
  for (const lockPath of candidates) {
    let raw;
    try {
      raw = await fs.readFile(lockPath, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.skills))
      continue;
    for (const [skillId, entry] of Object.entries(parsed.skills)) {
      const id = skillId.trim();
      if (!id || upstreamById.has(id) || !isRecord(entry))
        continue;
      const sourceType = trimmed(entry.sourceType) || "unknown";
      const rawSource = trimmed(entry.source);
      const sourceUrl = trimmed(entry.sourceUrl) || null;
      const ref = trimmed(entry.ref) || null;
      const skillPath = trimmed(entry.skillPath) || null;
      const source = formatUpstreamLabel(rawSource, sourceType, sourceUrl, homeDir);
      if (!source && !sourceUrl)
        continue;
      upstreamById.set(id, {
        source,
        sourceType,
        sourceUrl,
        ref,
        skillPath
      });
    }
  }
  return upstreamById;
};
var discoverInstalledSkills = async (homeDir, extraRoots = [], extraLockfiles = []) => {
  const upstreamById = await discoverSkillLockfile(homeDir, extraLockfiles);
  const roots = [];
  if (homeDir) {
    roots.push(path.join(homeDir, ".config", "opencode", "skills"), path.join(homeDir, ".agents", "skills"));
  }
  for (const r of extraRoots) {
    if (r && !roots.includes(r))
      roots.push(r);
  }
  const seenRealDirs = new Set;
  const installed = new Map;
  const aliasToId = new Map;
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
      if (!entry.isDirectory() && !entry.isSymbolicLink())
        continue;
      const skillDir = path.join(root, entry.name);
      let realDir = skillDir;
      try {
        realDir = realpathSync(skillDir);
      } catch {}
      if (seenRealDirs.has(realDir))
        continue;
      const mdPath = path.join(skillDir, "SKILL.md");
      let raw;
      try {
        raw = await fs.readFile(mdPath, "utf8");
      } catch {
        continue;
      }
      seenRealDirs.add(realDir);
      const id = entry.name.trim();
      if (!id)
        continue;
      const parsed = parseSkillContent(raw);
      if (!installed.has(id)) {
        installed.set(id, {
          id,
          name: parsed.name || id,
          fmName: parsed.name,
          description: parsed.description,
          directory: skillDir,
          displayPath: formatDisplayPath(mdPath, homeDir),
          upstream: upstreamById.get(id) ?? null
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
var normalizeSkillId = (raw, aliasToId) => {
  const s = raw.trim();
  if (!s)
    return "";
  return aliasToId.get(s) ?? aliasToId.get(s.toLowerCase()) ?? s;
};
var stripJsonc = (raw) => {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0;i < raw.length; i += 1) {
    const ch = raw[i] ?? "";
    const next = raw[i + 1] ?? "";
    if (inLineComment) {
      if (ch === `
`) {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      } else if (ch === `
`) {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
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
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  let finalOut = "";
  inString = false;
  escaped = false;
  for (let i = 0;i < out.length; i += 1) {
    const ch = out[i] ?? "";
    if (inString) {
      finalOut += ch;
      if (escaped)
        escaped = false;
      else if (ch === "\\")
        escaped = true;
      else if (ch === quote)
        inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      finalOut += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j] ?? ""))
        j += 1;
      if (out[j] === "}" || out[j] === "]")
        continue;
    }
    finalOut += ch;
  }
  return finalOut;
};
var matchSkillWildcard = (input, pattern) => {
  let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (escaped.endsWith(" .*"))
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"));
};
var extractSkillUseStatements = (info, sourcePath) => {
  if (!isRecord(info))
    return [];
  const exp = isRecord(info.experimental) ? info.experimental : null;
  const rawList = [
    ...Array.isArray(exp?.policies) ? exp.policies : [],
    ...Array.isArray(info.policies) ? info.policies : []
  ];
  const rules = [];
  for (const item of rawList) {
    if (!isRecord(item))
      continue;
    const action = trimmed(item.action);
    const resource = trimmed(item.resource);
    const effect = trimmed(item.effect);
    if (effect !== "allow" && effect !== "deny")
      continue;
    if (action === "skill.use" && resource) {
      rules.push({ pattern: resource, effect, sourcePath });
    } else if (action === "integration.use" && resource.startsWith("skill:") && resource.length > 6) {
      rules.push({ pattern: resource.slice(6), effect, sourcePath });
    }
  }
  return rules;
};
var loadSkillUseRules = async (opts) => {
  const { homeDir, directory, extraConfigPaths = [], opencodeUrl, serviceToken } = opts;
  if (opencodeUrl && serviceToken) {
    try {
      const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
      const controller = new AbortController;
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const res = await fetch(`${opencodeUrl}/api/config${qs}`, {
          headers: { Authorization: `Bearer ${serviceToken}` },
          signal: controller.signal
        });
        if (res.ok) {
          const parsed = await res.json();
          const entries = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : null;
          if (entries) {
            const docs = entries.filter((e) => isRecord(e) && trimmed(e.type) === "document");
            if (docs.length > 0) {
              return docs.reverse().flatMap((doc) => {
                const rawPath = typeof doc.path === "string" ? doc.path : null;
                return extractSkillUseStatements(doc.info, formatDisplayPath(rawPath, homeDir));
              });
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {}
  }
  const paths = [];
  if (homeDir) {
    paths.push(path.join(homeDir, ".config", "opencode", "opencode.json"), path.join(homeDir, ".config", "opencode", "opencode.jsonc"));
  }
  const envCfg = process.env.OPENCODE_CONFIG?.trim();
  if (envCfg && !paths.includes(envCfg))
    paths.push(envCfg);
  if (directory) {
    paths.push(path.join(directory, "opencode.json"), path.join(directory, "opencode.jsonc"), path.join(directory, ".opencode", "opencode.json"), path.join(directory, ".opencode", "opencode.jsonc"));
  }
  for (const p of extraConfigPaths) {
    if (p && !paths.includes(p))
      paths.push(p);
  }
  const docs = [];
  for (const cfgPath of paths) {
    let raw;
    try {
      raw = await fs.readFile(cfgPath, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(stripJsonc(raw));
      docs.push({ info: parsed, sourcePath: formatDisplayPath(cfgPath, homeDir) });
    } catch {}
  }
  return docs.reverse().flatMap((doc) => extractSkillUseStatements(doc.info, doc.sourcePath));
};
var evaluateSkillPolicy = (rules, skillId) => {
  for (let i = rules.length - 1;i >= 0; i -= 1) {
    const rule = rules[i];
    if (rule && matchSkillWildcard(skillId, rule.pattern)) {
      return {
        effect: rule.effect,
        explicit: true,
        pattern: rule.pattern,
        sourcePath: rule.sourcePath
      };
    }
  }
  return {
    effect: "allow",
    explicit: false,
    pattern: null,
    sourcePath: null
  };
};
var resolveDefaultOpencodeDbPath = (homeDir, env = process.env) => {
  const override = env.OPENCODE_DB_PATH?.trim();
  if (override)
    return override;
  const xdgData = env.XDG_DATA_HOME?.trim();
  if (xdgData)
    return path.join(xdgData, "opencode", "opencode.db");
  if (homeDir)
    return path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  return null;
};
var cachedSqlitePromise = null;
var loadSqliteModule = async () => {
  if (!cachedSqlitePromise) {
    cachedSqlitePromise = import("node:sqlite").catch(() => null);
  }
  return cachedSqlitePromise;
};
var isForkClonedMessage = (msgId, msgCreated, sessionCreated) => /^msg_[a-zA-Z0-9]{16,}_\d+$/.test(msgId) || sessionCreated > 0 && msgCreated < sessionCreated;
var isSubagentSource = (source) => source === "subagent_injected" || source === "subagent_handoff" || source === "subagent_tool";
var createHeatmapStore = (options = {}) => {
  const homeDir = options.homeDir === undefined ? os.homedir() || null : options.homeDir;
  const dbPath = options.dbPath !== undefined ? options.dbPath : resolveDefaultOpencodeDbPath(homeDir);
  const dataDir = options.dataDir !== undefined ? options.dataDir : process.env.OPENCHAMBER_SERVICE_DATA_DIR?.trim() || null;
  const extraRoots = options.extraSkillRoots ?? [];
  const extraConfigPaths = options.extraConfigPaths ?? [];
  const opencodeUrl = options.opencodeUrl;
  const serviceToken = options.serviceToken;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let memoryCache = null;
  let lastSyncedAt = 0;
  let diskCacheLoaded = false;
  let inflightSync = null;
  let installedCache = null;
  const getInstalled = async (force = false) => {
    const now = Date.now();
    if (!force && installedCache && now - installedCache.at < INSTALLED_SKILLS_TTL_MS) {
      return installedCache;
    }
    const discovered = await discoverInstalledSkills(homeDir, extraRoots);
    installedCache = { at: now, ...discovered };
    return installedCache;
  };
  const loadDiskCache = async () => {
    if (diskCacheLoaded)
      return;
    diskCacheLoaded = true;
    if (!dataDir)
      return;
    const cacheFile = path.join(dataDir, CACHE_FILENAME);
    try {
      const raw = await fs.readFile(cacheFile, "utf8");
      const parsed = JSON.parse(raw);
      if (isRecord(parsed) && parsed.version === 1 && typeof parsed.dbPath === "string" && typeof parsed.dbSize === "number" && typeof parsed.watermarkTimeCreated === "number" && Array.isArray(parsed.events)) {
        memoryCache = {
          version: 1,
          dbPath: parsed.dbPath,
          dbSize: parsed.dbSize,
          watermarkTimeCreated: parsed.watermarkTimeCreated,
          excludedEvalSessions: typeof parsed.excludedEvalSessions === "number" ? parsed.excludedEvalSessions : 0,
          forkClonedMessagesSkipped: typeof parsed.forkClonedMessagesSkipped === "number" ? parsed.forkClonedMessagesSkipped : 0,
          dedupedHandoffs: typeof parsed.dedupedHandoffs === "number" ? parsed.dedupedHandoffs : 0,
          events: parsed.events
        };
      }
    } catch {}
  };
  const saveDiskCache = async (payload) => {
    if (!dataDir)
      return;
    const cacheFile = path.join(dataDir, CACHE_FILENAME);
    const tmpFile = `${cacheFile}.tmp-${process.pid}`;
    try {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(tmpFile, JSON.stringify(payload), "utf8");
      await fs.rename(tmpFile, cacheFile);
    } catch {}
  };
  const syncFromDb = async (forceRefresh) => {
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
    const runSync = async () => {
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
      const slashAliases = [...aliasToId.keys()].filter((k) => k.length >= 2).sort((a, b) => b.length - a.length);
      let db = null;
      try {
        db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        const hasValidCache = Boolean(!forceRefresh && memoryCache && memoryCache.dbPath === dbPath && dbSize >= memoryCache.dbSize && memoryCache.watermarkTimeCreated > 0);
        const watermark = hasValidCache && memoryCache ? memoryCache.watermarkTimeCreated : 0;
        if (hasValidCache && memoryCache) {
          const latestRow = db.prepare("SELECT max(time_created) as max_t FROM session_message").get();
          const maxT = typeof latestRow?.max_t === "number" ? latestRow.max_t : 0;
          if (maxT <= watermark) {
            cacheHit = true;
            lastSyncedAt = Date.now();
            return;
          }
        }
        const sessionRows = db.prepare("SELECT id, parent_id, directory, agent, title, time_created FROM session_v2").all();
        const sessionMap = new Map;
        for (const s of sessionRows) {
          sessionMap.set(s.id, s);
        }
        const resolveRootSession = (sid) => {
          let cur = sid;
          const seen = new Set;
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            const row = sessionMap.get(cur);
            if (!row?.parent_id)
              return cur;
            cur = row.parent_id;
          }
          return sid;
        };
        const isExcludedSession = (s) => {
          if (s.agent === "auto-gate-eval" || s.agent === "hindsight-survey")
            return true;
          if (s.directory?.startsWith("/tmp/"))
            return true;
          if ((s.title ?? "").includes("auto-gate"))
            return true;
          if (s.parent_id) {
            const root = sessionMap.get(resolveRootSession(s.id));
            if (root && (root.agent === "auto-gate-eval" || root.directory?.startsWith("/tmp/"))) {
              return true;
            }
          }
          return false;
        };
        let excludedEvalSessions = 0;
        for (const s of sessionRows) {
          if (isExcludedSession(s))
            excludedEvalSessions += 1;
        }
        const msgRows = watermark > 0 ? db.prepare(`
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
            `).all(watermark) : db.prepare(`
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
            `).all();
        const baseEvents = hasValidCache && memoryCache ? [...memoryCache.events] : [];
        let forkClonedMessagesSkipped = hasValidCache && memoryCache ? memoryCache.forkClonedMessagesSkipped : 0;
        let dedupedHandoffs = hasValidCache && memoryCache ? memoryCache.dedupedHandoffs : 0;
        const childRecordedSkills = new Set;
        const sessionMinuteSkillSeen = new Set;
        for (const existing of baseEvents) {
          if (existing.source === "subagent_injected" || existing.source === "subagent_tool") {
            childRecordedSkills.add(`${existing.sessionId}\x00${existing.skill}`);
          }
          sessionMinuteSkillSeen.add(`${existing.sessionId}\x00${Math.floor(existing.at / 60000)}\x00${existing.skill}`);
        }
        const pendingHandoffs = [];
        let maxTimeCreated = watermark;
        for (const row of msgRows) {
          if (row.time_created > maxTimeCreated)
            maxTimeCreated = row.time_created;
          const sess = sessionMap.get(row.session_id);
          if (!sess || isExcludedSession(sess))
            continue;
          if (isForkClonedMessage(row.id, row.time_created, sess.time_created)) {
            forkClonedMessagesSkipped += 1;
            continue;
          }
          let parsedData;
          try {
            parsedData = JSON.parse(row.data);
          } catch {
            continue;
          }
          if (!isRecord(parsedData))
            continue;
          const isSubagent = Boolean(sess.parent_id);
          const rootSessionId = resolveRootSession(sess.id);
          const rootSess = sessionMap.get(rootSessionId) ?? sess;
          const project = deriveProjectLabel(rootSess.directory || sess.directory, homeDir);
          if (row.type === "assistant" && Array.isArray(parsedData.content)) {
            const actor = trimmed(parsedData.agent) || trimmed(sess.agent) || "assistant";
            for (const part of parsedData.content) {
              if (!isRecord(part) || trimmed(part.type) !== "tool")
                continue;
              const toolName = trimmed(part.name);
              if (toolName === "skill") {
                const st = isRecord(part.state) ? part.state : {};
                const input = isRecord(st.input) ? st.input : {};
                const meta = isRecord(st.metadata) ? st.metadata : {};
                let rawSkill = trimmed(input.id) || trimmed(input.name);
                if (!rawSkill && typeof meta.directory === "string" && meta.directory.trim()) {
                  rawSkill = path.basename(meta.directory.trim().replace(/^skill:\/\//, ""));
                }
                if (!rawSkill && Array.isArray(st.content)) {
                  for (const c of st.content) {
                    if (isRecord(c) && typeof c.text === "string") {
                      const tag = extractSkillTag(c.text);
                      if (tag) {
                        rawSkill = tag;
                        break;
                      }
                    }
                  }
                }
                if (!rawSkill)
                  rawSkill = trimmed(meta.name);
                const skill = normalizeSkillId(rawSkill, aliasToId);
                if (!skill)
                  continue;
                const partTime = isRecord(part.time) ? part.time : null;
                const at = (typeof partTime?.completed === "number" ? partTime.completed : null) ?? (typeof partTime?.created === "number" ? partTime.created : null) ?? row.time_created;
                const statusRaw = trimmed(st.status);
                const status = statusRaw === "error" ? "failed" : statusRaw === "completed" ? "active" : "loading";
                baseEvents.push({
                  skill,
                  source: isSubagent ? "subagent_tool" : "agent_tool",
                  status,
                  sessionId: sess.id,
                  rootSessionId,
                  actor,
                  project,
                  at
                });
                if (isSubagent)
                  childRecordedSkills.add(`${sess.id}\x00${skill}`);
                sessionMinuteSkillSeen.add(`${sess.id}\x00${Math.floor(at / 60000)}\x00${skill}`);
              } else if (toolName === "subagent" || toolName === "task") {
                const st = isRecord(part.state) ? part.state : {};
                if (trimmed(st.status) === "error")
                  continue;
                const input = isRecord(st.input) ? st.input : {};
                const meta = isRecord(st.metadata) ? st.metadata : {};
                const rawSkills = Array.isArray(input.skills) ? input.skills : Array.isArray(input.load_skills) ? input.load_skills : [];
                if (rawSkills.length === 0)
                  continue;
                const childSessionId = trimmed(meta.sessionID) || trimmed(meta.sessionId) || null;
                const subActor = trimmed(input.agent) || trimmed(input.category) || "subagent";
                const partTime = isRecord(part.time) ? part.time : null;
                const at = typeof partTime?.created === "number" ? partTime.created : row.time_created;
                const status = trimmed(st.status) === "completed" ? "active" : "loading";
                for (const rawSk of rawSkills) {
                  if (typeof rawSk !== "string")
                    continue;
                  const skill = normalizeSkillId(rawSk, aliasToId);
                  if (!skill)
                    continue;
                  pendingHandoffs.push({
                    childSessionId,
                    event: {
                      skill,
                      source: "subagent_handoff",
                      status,
                      sessionId: childSessionId || sess.id,
                      rootSessionId,
                      actor: subActor,
                      project,
                      at
                    }
                  });
                }
              }
            }
            continue;
          }
          if (row.type === "user" || row.type === "synthetic") {
            const msgTime = isRecord(parsedData.time) ? parsedData.time : null;
            const at = typeof msgTime?.created === "number" ? msgTime.created : row.time_created;
            if (Array.isArray(parsedData.skills)) {
              for (const sk of parsedData.skills) {
                if (!isRecord(sk))
                  continue;
                const rawId = trimmed(sk.id) || trimmed(sk.name);
                if (!rawId)
                  continue;
                const skill = normalizeSkillId(rawId, aliasToId);
                if (!skill)
                  continue;
                baseEvents.push({
                  skill,
                  source: "user_attach",
                  status: "active",
                  sessionId: sess.id,
                  rootSessionId,
                  actor: isSubagent ? trimmed(sess.agent) || "subagent" : "user",
                  project,
                  at
                });
                if (isSubagent)
                  childRecordedSkills.add(`${sess.id}\x00${skill}`);
                sessionMinuteSkillSeen.add(`${sess.id}\x00${Math.floor(at / 60000)}\x00${skill}`);
              }
            }
            const text = typeof parsedData.text === "string" ? parsedData.text : "";
            if (isSubagent && text.includes("[SKILL:")) {
              for (const m of text.matchAll(/^\[SKILL:\s*([A-Za-z0-9_.:-]+)\]/gm)) {
                const rawId = m[1] ?? "";
                const skill = normalizeSkillId(rawId, aliasToId);
                if (!skill)
                  continue;
                baseEvents.push({
                  skill,
                  source: "subagent_injected",
                  status: "active",
                  sessionId: sess.id,
                  rootSessionId,
                  actor: trimmed(sess.agent) || "subagent",
                  project,
                  at
                });
                childRecordedSkills.add(`${sess.id}\x00${skill}`);
              }
            }
            if (row.type === "user" && text.startsWith("/") && !text.startsWith("//") && !Array.isArray(parsedData.skills)) {
              const afterSlash = text.slice(1);
              for (const alias of slashAliases) {
                if (afterSlash.toLowerCase().startsWith(alias.toLowerCase()) && (afterSlash.length === alias.length || /[\s\n.,:;!?]/.test(afterSlash[alias.length] ?? ""))) {
                  const skill = normalizeSkillId(alias, aliasToId);
                  if (!skill)
                    break;
                  const minuteKey = `${sess.id}\x00${Math.floor(at / 60000)}\x00${skill}`;
                  if (!sessionMinuteSkillSeen.has(minuteKey)) {
                    baseEvents.push({
                      skill,
                      source: "user_slash",
                      status: "active",
                      sessionId: sess.id,
                      rootSessionId,
                      actor: "user",
                      project,
                      at
                    });
                    sessionMinuteSkillSeen.add(minuteKey);
                  }
                  break;
                }
              }
            }
          }
        }
        const filteredBase = baseEvents.filter((ev) => {
          if (ev.source === "subagent_handoff" && childRecordedSkills.has(`${ev.sessionId}\x00${ev.skill}`)) {
            dedupedHandoffs += 1;
            return false;
          }
          return true;
        });
        for (const h of pendingHandoffs) {
          if (h.childSessionId && childRecordedSkills.has(`${h.childSessionId}\x00${h.event.skill}`)) {
            dedupedHandoffs += 1;
            continue;
          }
          filteredBase.push(h.event);
        }
        filteredBase.sort((a, b) => a.at - b.at);
        const nextPayload = {
          version: 1,
          dbPath,
          dbSize,
          watermarkTimeCreated: maxTimeCreated,
          excludedEvalSessions,
          forkClonedMessagesSkipped,
          dedupedHandoffs,
          events: filteredBase
        };
        memoryCache = nextPayload;
        lastSyncedAt = Date.now();
        await saveDiskCache(nextPayload);
      } catch {
        dbAvailable = false;
      } finally {
        try {
          db?.close();
        } catch {}
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
  const query = async (queryOpts = {}) => {
    const windowOpt = queryOpts.window ?? "16w";
    const scopeOpt = queryOpts.scope ?? "all";
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
        serviceToken
      })
    ]);
    const allEvents = memoryCache?.events ?? [];
    const projectCounts = new Map;
    for (const ev of allEvents) {
      projectCounts.set(ev.project, (projectCounts.get(ev.project) ?? 0) + 1);
    }
    const projects = [...projectCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
    const filteredEvents = allEvents.filter((ev) => {
      if (scopeOpt === "direct" && isSubagentSource(ev.source))
        return false;
      if (scopeOpt === "subagent" && !isSubagentSource(ev.source))
        return false;
      if (projectOpt && projectOpt !== "all" && ev.project !== projectOpt)
        return false;
      return true;
    });
    const weekSourceEvents = filteredEvents.length > 0 ? filteredEvents : allEvents;
    const allWeekSet = new Set;
    for (const ev of weekSourceEvents) {
      allWeekSet.add(localDateParts(ev.at).week);
    }
    const sortedWeeks = [...allWeekSet].sort();
    const continuousWeeks = [];
    if (sortedWeeks.length > 0) {
      const first = new Date(`${sortedWeeks[0]}T12:00:00`);
      const last = new Date(`${sortedWeeks[sortedWeeks.length - 1]}T12:00:00`);
      for (let cur = new Date(first);cur <= last; cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7)) {
        continuousWeeks.push(localDateParts(cur.getTime()).day);
      }
    }
    const weeks = windowOpt === "8w" ? continuousWeeks.slice(-8) : windowOpt === "16w" ? continuousWeeks.slice(-16) : continuousWeeks;
    const minWeek = weeks[0] ?? null;
    const weekIndexByKey = new Map(weeks.map((w, idx) => [w, idx]));
    const windowedEvents = minWeek ? filteredEvents.filter((ev) => localDateParts(ev.at).week >= minWeek) : filteredEvents;
    const bySkill = new Map;
    const byDay = new Map;
    const dowHour = Array.from({ length: 7 }, () => Array(24).fill(0));
    const rootSessionsSet = new Set;
    for (const ev of windowedEvents) {
      const lp = localDateParts(ev.at);
      rootSessionsSet.add(ev.rootSessionId);
      const dowRow = dowHour[lp.dow];
      if (dowRow) {
        dowRow[lp.hour] = (dowRow[lp.hour] ?? 0) + 1;
      }
      let dayEntry = byDay.get(lp.day);
      if (!dayEntry) {
        dayEntry = { count: 0, sessions: new Set, skills: new Map };
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
          sessions: new Set,
          user: 0,
          agent: 0,
          subagent: 0,
          failed: 0,
          firstAt: ev.at,
          lastAt: ev.at,
          weekCounts: Array(weeks.length).fill(0),
          weekSessionSets: Array.from({ length: weeks.length }, () => new Set),
          byProject: {}
        };
        bySkill.set(ev.skill, acc);
      }
      acc.total += 1;
      acc.sessions.add(ev.rootSessionId);
      if (ev.status === "failed")
        acc.failed += 1;
      if (ev.source === "user_attach" || ev.source === "user_slash")
        acc.user += 1;
      else if (ev.source === "agent_tool")
        acc.agent += 1;
      else
        acc.subagent += 1;
      if (ev.at < acc.firstAt)
        acc.firstAt = ev.at;
      if (ev.at > acc.lastAt)
        acc.lastAt = ev.at;
      const wIdx = weekIndexByKey.get(lp.week);
      if (wIdx !== undefined) {
        acc.weekCounts[wIdx] = (acc.weekCounts[wIdx] ?? 0) + 1;
        acc.weekSessionSets[wIdx]?.add(ev.rootSessionId);
      }
      acc.byProject[ev.project] = (acc.byProject[ev.project] ?? 0) + 1;
    }
    const seenIds = new Set;
    const rows = [];
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
        policy: evaluateSkillPolicy(policyRules, id)
      });
    }
    let dormantInstalledCount = 0;
    for (const [id, inst] of installed.entries()) {
      if (seenIds.has(id))
        continue;
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
        weekCounts: Array(weeks.length).fill(0),
        weekSessions: Array(weeks.length).fill(0),
        byProject: {},
        description: inst.description,
        displayPath: inst.displayPath,
        upstream: inst.upstream,
        policy: evaluateSkillPolicy(policyRules, id)
      });
    }
    for (const rule of policyRules) {
      const pattern = rule.pattern;
      if (!pattern || /[*?]/.test(pattern) || seenIds.has(pattern))
        continue;
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
        weekCounts: Array(weeks.length).fill(0),
        weekSessions: Array(weeks.length).fill(0),
        byProject: {},
        description: null,
        displayPath: null,
        upstream: upstreamById.get(pattern) ?? null,
        policy: evaluateSkillPolicy(policyRules, pattern)
      });
    }
    const deniedCount = rows.filter((r) => r.policy.effect === "deny").length;
    rows.sort((a, b) => b.total - a.total || b.sessions - a.sessions || a.id.localeCompare(b.id));
    const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, info]) => ({
      day,
      count: info.count,
      sessions: info.sessions.size,
      topSkills: [...info.skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n})`)
    }));
    const firstEvent = windowedEvents[0];
    const lastEvent = windowedEvents[windowedEvents.length - 1];
    const dateRange = firstEvent && lastEvent ? [localDateParts(firstEvent.at).day, localDateParts(lastEvent.at).day] : null;
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
        dedupedHandoffs: memoryCache?.dedupedHandoffs ?? 0
      },
      daily,
      dowHour,
      skills: rows
    };
  };
  const invalidate = () => {
    lastSyncedAt = 0;
  };
  return { query, invalidate };
};

// shared/types.ts
var SKILLS_UPDATED_TOPIC = "skills-updated";
var HEATMAP_UPDATED_TOPIC = "heatmap-updated";

// service/main.ts
var SESSION_ID_PATTERN = /^ses_[\w-]+$/;
var MAX_TRACKED_SESSIONS = 200;
var MAX_DISK_CACHE = 256;
var MESSAGE_PAGE_LIMIT = 100;
var MAX_MESSAGE_PAGES = 15;
var EMIT_DEBOUNCE_MS = 80;
var createSkillServiceStore = (homeDir = os2.homedir() || null) => ({
  sessions: new Map,
  childrenByParent: new Map,
  diskMetadata: new Map,
  inflightHydrations: new Map,
  emitTimers: new Map,
  sseConnected: false,
  homeDir
});
var linkChildSession = (store, parentId, childId) => {
  if (!parentId || !childId || parentId === childId)
    return false;
  let set = store.childrenByParent.get(parentId);
  if (!set) {
    set = new Set;
    store.childrenByParent.set(parentId, set);
  }
  const before = set.size;
  set.add(childId);
  return set.size !== before;
};
var ensureSessionNode = (store, sessionId, now = Date.now()) => {
  const existing = store.sessions.get(sessionId);
  if (existing) {
    existing.lastTouchedAt = now;
    return existing;
  }
  if (store.sessions.size >= MAX_TRACKED_SESSIONS) {
    let oldestId = null;
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
  const created = {
    sessionId,
    parentId: null,
    agent: null,
    hydratedAt: null,
    dirty: true,
    dirtySeq: 1,
    lastTouchedAt: now,
    parsed: null,
    inFlightTools: new Map,
    enqueuedInboxSkills: new Map
  };
  store.sessions.set(sessionId, created);
  return created;
};
var markSessionDirty = (node) => {
  node.dirty = true;
  node.dirtySeq += 1;
};
var resolveRootSessionId = (store, sessionId) => {
  const visited = new Set;
  let current = sessionId;
  while (!visited.has(current)) {
    visited.add(current);
    const node = store.sessions.get(current);
    if (!node?.parentId)
      break;
    current = node.parentId;
  }
  return current;
};
var collectDescendants = (store, rootSessionId) => {
  const result = [];
  const visited = new Set([rootSessionId]);
  const queue = [{ id: rootSessionId, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (item.depth >= 6)
      continue;
    const direct = store.childrenByParent.get(item.id);
    const parsedKids = store.sessions.get(item.id)?.parsed?.discoveredChildSessionIds ?? [];
    const combined = new Set([
      ...direct ?? [],
      ...parsedKids
    ]);
    for (const childId of combined) {
      if (visited.has(childId))
        continue;
      visited.add(childId);
      result.push(childId);
      queue.push({ id: childId, depth: item.depth + 1 });
    }
  }
  return result;
};
var treeHasAnySkills = (store, rootSessionId) => {
  const ids = [rootSessionId, ...collectDescendants(store, rootSessionId)];
  for (const id of ids) {
    const n = store.sessions.get(id);
    if (!n)
      continue;
    if ((n.parsed?.records.length ?? 0) > 0)
      return true;
    if ((n.parsed?.subagentHandoffs.length ?? 0) > 0)
      return true;
    if (n.inFlightTools.size > 0 || n.enqueuedInboxSkills.size > 0)
      return true;
  }
  return false;
};
var enrichSkillMetadataFromDisk = async (store, directory) => {
  if (!directory || store.diskMetadata.has(directory))
    return;
  if (!path2.isAbsolute(directory))
    return;
  if (store.diskMetadata.size >= MAX_DISK_CACHE) {
    const firstKey = store.diskMetadata.keys().next().value;
    if (typeof firstKey === "string")
      store.diskMetadata.delete(firstKey);
  }
  try {
    const skillMdPath = path2.join(directory, "SKILL.md");
    const content = await fs2.readFile(skillMdPath, "utf8");
    const parsed = parseSkillContent(content);
    store.diskMetadata.set(directory, {
      description: parsed.description,
      preview: parsed.preview
    });
  } catch {
    store.diskMetadata.set(directory, { description: null, preview: null });
  }
};
var unwrapData = (body) => {
  if (!isRecord(body))
    return body;
  return "data" in body ? body.data : body;
};
var fetchSessionMessages = async (opencodeUrl, headers, sessionId) => {
  const newestFirst = [];
  let cursor = null;
  for (let page = 0;page < MAX_MESSAGE_PAGES; page += 1) {
    const query = cursor ? `limit=${MESSAGE_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}` : `limit=${MESSAGE_PAGE_LIMIT}&order=desc`;
    const res = await fetch(`${opencodeUrl}/api/session/${encodeURIComponent(sessionId)}/message?${query}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok)
      return page === 0 ? null : newestFirst.reverse();
    const raw = await res.json().catch(() => null);
    const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.data) ? raw.data : null;
    if (!list)
      return page === 0 ? null : newestFirst.reverse();
    newestFirst.push(...list);
    const nextCursor = isRecord(raw) && isRecord(raw.cursor) && typeof raw.cursor.next === "string" ? raw.cursor.next.trim() : "";
    if (!nextCursor || list.length < MESSAGE_PAGE_LIMIT) {
      break;
    }
    cursor = nextCursor;
  }
  return newestFirst.reverse();
};
var hydrateSingleSession = async (store, opencodeUrl, token, sessionId) => {
  if (!SESSION_ID_PATTERN.test(sessionId))
    return;
  for (let pass = 0;pass < 2; pass += 1) {
    const existingPromise = store.inflightHydrations.get(sessionId);
    if (existingPromise) {
      await existingPromise;
      const afterNode = store.sessions.get(sessionId);
      if (!afterNode || !afterNode.dirty && afterNode.hydratedAt !== null) {
        return;
      }
    }
    const node = ensureSessionNode(store, sessionId, Date.now());
    const startSeq = node.dirtySeq;
    const job = (async () => {
      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      };
      const now = Date.now();
      try {
        const [infoRes, childrenRes, messages] = await Promise.all([
          fetch(`${opencodeUrl}/api/session/${encodeURIComponent(sessionId)}`, {
            headers,
            signal: AbortSignal.timeout(6000)
          }).catch(() => null),
          fetch(`${opencodeUrl}/api/session?parentID=${encodeURIComponent(sessionId)}&limit=50`, {
            headers,
            signal: AbortSignal.timeout(6000)
          }).catch(() => null),
          fetchSessionMessages(opencodeUrl, headers, sessionId).catch(() => null)
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
            if (agent)
              node.agent = agent;
          }
        }
        if (childrenRes?.ok) {
          const rawKids = await childrenRes.json().catch(() => null);
          const kidsList = Array.isArray(rawKids) ? rawKids : isRecord(rawKids) && Array.isArray(rawKids.data) ? rawKids.data : [];
          for (const kid of kidsList) {
            if (!isRecord(kid))
              continue;
            const kidId = trimmed(kid.id);
            if (!SESSION_ID_PATTERN.test(kidId))
              continue;
            const kidNode = ensureSessionNode(store, kidId, now);
            kidNode.parentId = sessionId;
            const kidAgent = trimmed(kid.agent) || null;
            if (kidAgent)
              kidNode.agent = kidAgent;
            linkChildSession(store, sessionId, kidId);
          }
        }
        if (messages !== null) {
          const isSubagent = Boolean(node.parentId);
          const parsed = parseSessionMessages({
            sessionId,
            isSubagent,
            defaultAgent: node.agent,
            messages
          });
          node.parsed = parsed;
          node.hydratedAt = Date.now();
          if (node.dirtySeq === startSeq) {
            node.dirty = false;
          }
          for (const childId of parsed.discoveredChildSessionIds) {
            const kidNode = ensureSessionNode(store, childId, now);
            if (!kidNode.parentId)
              kidNode.parentId = sessionId;
            linkChildSession(store, sessionId, childId);
          }
          for (const inboxId of node.enqueuedInboxSkills.keys()) {
            if (parsed.persistedMessageIds.has(inboxId)) {
              node.enqueuedInboxSkills.delete(inboxId);
            }
          }
          for (const [callId, tool] of node.inFlightTools.entries()) {
            if (parsed.terminalToolCallIds.has(callId) || node.dirtySeq === startSeq && tool.status !== "loading") {
              node.inFlightTools.delete(callId);
            }
          }
          const dirsToEnrich = new Set;
          for (const rec of parsed.records) {
            if (rec.directory && !store.diskMetadata.has(rec.directory)) {
              dirsToEnrich.add(rec.directory);
            }
          }
          if (dirsToEnrich.size > 0) {
            await Promise.all(Array.from(dirsToEnrich).map((dir) => enrichSkillMetadataFromDisk(store, dir)));
          }
        }
      } finally {
        store.inflightHydrations.delete(sessionId);
      }
    })();
    store.inflightHydrations.set(sessionId, job);
    await job;
    if (!node.dirty)
      return;
  }
};
var hydrateSessionTree = async (store, opencodeUrl, token, rootSessionId) => {
  const rootNode = ensureSessionNode(store, rootSessionId);
  if (rootNode.hydratedAt === null || rootNode.dirty) {
    await hydrateSingleSession(store, opencodeUrl, token, rootSessionId);
  }
  for (let wave = 0;wave < 2; wave += 1) {
    const descendants = collectDescendants(store, rootSessionId);
    const pendingKids = descendants.filter((id) => {
      const n = ensureSessionNode(store, id);
      return n.hydratedAt === null || n.dirty;
    });
    if (pendingKids.length === 0)
      break;
    await Promise.all(pendingKids.slice(0, 24).map((id) => hydrateSingleSession(store, opencodeUrl, token, id)));
  }
};
var buildSessionSkillsResponse = (store, sessionId) => {
  const rootNode = store.sessions.get(sessionId);
  const descendants = collectDescendants(store, sessionId);
  const rootParsed = rootNode?.parsed ?? null;
  const baseTurnCount = rootParsed?.turnCount ?? 0;
  const baseTurnIndex = rootParsed?.currentTurnIndex ?? 0;
  const hasLiveNewTurn = Boolean(rootNode && rootNode.enqueuedInboxSkills.size > 0 && (baseTurnCount === 0 || rootParsed?.lastTurnEndedIdle || rootParsed?.latestTurnHasAssistant));
  const effectiveRootTurnCount = hasLiveNewTurn ? baseTurnCount + 1 : baseTurnCount;
  const effectiveRootTurnIndex = effectiveRootTurnCount > 0 ? effectiveRootTurnCount - 1 : 0;
  const rootWindowTokens = rootParsed?.latestWindowTokens ?? null;
  const rootTurns = rootParsed?.turns ?? [];
  const spawnTurnBySessionId = new Map;
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
  const sessionRecords = [];
  const subagentRecords = [];
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
            scope: "subagent",
            trigger: "subagent",
            status: handoff.status === "loading" ? "loading" : "active",
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
            error: null
          });
        }
      }
    }
    for (const inboxRecords of rootNode.enqueuedInboxSkills.values()) {
      for (const rec of inboxRecords) {
        sessionRecords.push({
          ...rec,
          scope: "session",
          turnIndex: effectiveRootTurnIndex,
          compacted: false,
          activationTokens: rootWindowTokens,
          windowTokens: rootWindowTokens,
          sessionTurnCount: Math.max(1, effectiveRootTurnCount)
        });
      }
    }
    for (const liveTool of rootNode.inFlightTools.values()) {
      if (liveTool.toolName === "skill" && liveTool.skillId) {
        sessionRecords.push({
          id: liveTool.skillId,
          name: liveTool.skillId,
          scope: "session",
          trigger: "agent",
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
          error: liveTool.error
        });
      } else if (liveTool.toolName === "subagent" && liveTool.subagentSkills.length > 0) {
        const childNode = liveTool.childSessionId ? store.sessions.get(liveTool.childSessionId) : undefined;
        if (!childNode?.parsed?.hasUserMessage) {
          for (const skillId of liveTool.subagentSkills) {
            subagentRecords.push({
              id: skillId,
              name: skillId,
              scope: "subagent",
              trigger: "subagent",
              status: liveTool.status === "loading" ? "loading" : "active",
              at: liveTool.at,
              turnIndex: effectiveRootTurnIndex,
              compacted: false,
              activationTokens: null,
              windowTokens: null,
              sessionTurnCount: Math.max(1, effectiveRootTurnCount),
              actor: liveTool.subagentActor || "subagent",
              sessionId: liveTool.childSessionId || sessionId,
              directory: null,
              description: null,
              preview: null,
              error: null
            });
          }
        }
      }
    }
  }
  for (const childId of descendants) {
    const childNode = store.sessions.get(childId);
    if (!childNode)
      continue;
    const minTurn = spawnTurnBySessionId.get(childId) ?? 0;
    const childWindowTokens = childNode.parsed?.latestWindowTokens ?? null;
    if (childNode.parsed) {
      for (const rec of childNode.parsed.records) {
        const mappedTurn = mapTimestampToParentTurn({
          at: rec.at,
          rootTurns,
          rootCurrentTurnIndex: effectiveRootTurnIndex,
          minTurnIndex: minTurn
        });
        subagentRecords.push({
          ...rec,
          scope: "subagent",
          trigger: "subagent",
          turnIndex: mappedTurn
        });
      }
      for (const handoff of childNode.parsed.subagentHandoffs) {
        const grandChild = handoff.childSessionId ? store.sessions.get(handoff.childSessionId) : undefined;
        if (grandChild?.parsed?.hasUserMessage)
          continue;
        const mappedTurn = mapTimestampToParentTurn({
          at: handoff.at,
          rootTurns,
          rootCurrentTurnIndex: effectiveRootTurnIndex,
          minTurnIndex: minTurn
        });
        for (const skillId of handoff.skills) {
          subagentRecords.push({
            id: skillId,
            name: skillId,
            scope: "subagent",
            trigger: "subagent",
            status: handoff.status === "loading" ? "loading" : "active",
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
            error: null
          });
        }
      }
    }
    for (const inboxRecords of childNode.enqueuedInboxSkills.values()) {
      for (const rec of inboxRecords) {
        subagentRecords.push({
          ...rec,
          scope: "subagent",
          trigger: "subagent",
          turnIndex: effectiveRootTurnIndex,
          activationTokens: childWindowTokens,
          windowTokens: childWindowTokens
        });
      }
    }
    for (const liveTool of childNode.inFlightTools.values()) {
      if (liveTool.toolName === "skill" && liveTool.skillId) {
        subagentRecords.push({
          id: liveTool.skillId,
          name: liveTool.skillId,
          scope: "subagent",
          trigger: "subagent",
          status: liveTool.status,
          at: liveTool.at,
          turnIndex: effectiveRootTurnIndex,
          compacted: false,
          activationTokens: childWindowTokens,
          windowTokens: childWindowTokens,
          sessionTurnCount: Math.max(1, childNode.parsed?.turnCount ?? 1),
          actor: childNode.agent || "subagent",
          sessionId: childId,
          directory: liveTool.directory,
          description: liveTool.description,
          preview: liveTool.preview,
          error: liveTool.error
        });
      }
    }
  }
  const sessionSkills = aggregateScopedSkills({
    scope: "session",
    records: sessionRecords,
    effectiveRootTurnIndex,
    effectiveRootTurnCount: Math.max(1, effectiveRootTurnCount),
    diskMetadataByDirectory: store.diskMetadata,
    homeDir: store.homeDir
  });
  const subagentSkills = aggregateScopedSkills({
    scope: "subagent",
    records: subagentRecords,
    effectiveRootTurnIndex,
    effectiveRootTurnCount: Math.max(1, effectiveRootTurnCount),
    diskMetadataByDirectory: store.diskMetadata,
    homeDir: store.homeDir
  });
  const subagentActorSet = new Set;
  for (const s of subagentSkills) {
    for (const actor of s.actors) {
      if (actor)
        subagentActorSet.add(actor);
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
    subagentSkills
  };
};
var applyOpenCodeWireEvent = (store, payload, effects, now = Date.now()) => {
  if (!isRecord(payload))
    return;
  const type = trimmed(payload.type);
  if (!type)
    return;
  const data = isRecord(payload.data) ? payload.data : isRecord(payload.properties) ? payload.properties : {};
  const info = isRecord(data.info) ? data.info : null;
  const sessionId = trimmed(data.sessionID) || (info ? trimmed(info.sessionID) || trimmed(info.id) : "");
  if (!SESSION_ID_PATTERN.test(sessionId))
    return;
  const eventAt = typeof payload.created === "number" && Number.isFinite(payload.created) ? payload.created : now;
  const node = ensureSessionNode(store, sessionId, now);
  switch (type) {
    case "session.created":
    case "session.updated": {
      const target = info ?? data;
      const parentId = trimmed(target.parentID) || null;
      const agent = trimmed(target.agent) || null;
      if (agent)
        node.agent = agent;
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
    case "session.step.started": {
      const agent = trimmed(data.agent);
      if (agent)
        node.agent = agent;
      break;
    }
    case "session.step.ended":
    case "session.compaction.ended": {
      const rootId = resolveRootSessionId(store, sessionId);
      if (treeHasAnySkills(store, rootId)) {
        markSessionDirty(node);
        effects.onHydrateSession(sessionId, rootId);
      }
      break;
    }
    case "session.inbox.enqueued": {
      const inboxId = trimmed(data.inboxID);
      const item = isRecord(data.item) ? data.item : null;
      const itemPayload = item && isRecord(item.payload) ? item.payload : null;
      const skills = itemPayload && Array.isArray(itemPayload.skills) ? itemPayload.skills : [];
      const rootId = resolveRootSessionId(store, sessionId);
      if (inboxId && skills.length > 0) {
        const isSubagent = Boolean(node.parentId);
        const extracted = [];
        for (const s of skills) {
          if (!isRecord(s))
            continue;
          const id = trimmed(s.id) || trimmed(s.name);
          if (!id)
            continue;
          const rawText = typeof s.text === "string" ? s.text : null;
          const parsed = parseSkillContent(rawText);
          if (parsed.directory) {
            effects.onEnrichDirectory?.(parsed.directory, rootId);
          }
          extracted.push({
            id,
            name: trimmed(s.name) || parsed.name || id,
            scope: isSubagent ? "subagent" : "session",
            trigger: isSubagent ? "subagent" : "user",
            status: "active",
            at: eventAt,
            turnIndex: 0,
            compacted: false,
            activationTokens: null,
            windowTokens: null,
            sessionTurnCount: 1,
            actor: isSubagent ? node.agent || "subagent" : "You",
            sessionId,
            directory: parsed.directory,
            description: parsed.description,
            preview: parsed.preview,
            error: null
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
    case "session.inbox.delivered": {
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
    case "session.inbox.cancelled": {
      const inboxId = trimmed(data.inboxID);
      if (inboxId && node.enqueuedInboxSkills.delete(inboxId)) {
        effects.onEmitRootSession(resolveRootSessionId(store, sessionId));
      }
      break;
    }
    case "session.skill.activated": {
      markSessionDirty(node);
      effects.onHeatmapDirty?.();
      effects.onHydrateSession(sessionId, resolveRootSessionId(store, sessionId));
      break;
    }
    case "session.tool.input.started": {
      const callId = trimmed(data.id);
      const name = trimmed(data.name);
      if (!callId)
        break;
      if (name === "skill") {
        node.inFlightTools.set(callId, {
          callId,
          toolName: "skill",
          skillId: null,
          childSessionId: null,
          subagentSkills: [],
          subagentActor: null,
          status: "loading",
          at: eventAt,
          directory: null,
          description: null,
          preview: null,
          error: null
        });
      } else if (name === "subagent" || name === "task") {
        node.inFlightTools.set(callId, {
          callId,
          toolName: "subagent",
          skillId: null,
          childSessionId: null,
          subagentSkills: [],
          subagentActor: null,
          status: "loading",
          at: eventAt,
          directory: null,
          description: null,
          preview: null,
          error: null
        });
      }
      break;
    }
    case "session.tool.input.ended": {
      const callId = trimmed(data.id);
      const tracked = callId ? node.inFlightTools.get(callId) : undefined;
      if (!tracked || typeof data.text !== "string")
        break;
      try {
        const parsedInput = JSON.parse(data.text);
        if (!isRecord(parsedInput))
          break;
        if (tracked.toolName === "skill") {
          const skillId = trimmed(parsedInput.id) || trimmed(parsedInput.name);
          if (skillId && skillId !== tracked.skillId) {
            tracked.skillId = skillId;
            effects.onEmitRootSession(resolveRootSessionId(store, sessionId));
          }
        } else if (tracked.toolName === "subagent") {
          const rawSkills = Array.isArray(parsedInput.skills) ? parsedInput.skills : Array.isArray(parsedInput.load_skills) ? parsedInput.load_skills : [];
          const names = rawSkills.map((s) => trimmed(s)).filter(Boolean);
          if (names.length > 0) {
            tracked.subagentSkills = names;
            tracked.subagentActor = trimmed(parsedInput.agent) || trimmed(parsedInput.category) || "subagent";
            effects.onEmitRootSession(resolveRootSessionId(store, sessionId));
          }
        }
      } catch {}
      break;
    }
    case "session.tool.called": {
      const callId = trimmed(data.id);
      const input = isRecord(data.input) ? data.input : {};
      const tracked = callId ? node.inFlightTools.get(callId) : undefined;
      if (tracked) {
        if (tracked.toolName === "skill") {
          const skillId = trimmed(input.id) || trimmed(input.name);
          if (skillId) {
            tracked.skillId = skillId;
            effects.onEmitRootSession(resolveRootSessionId(store, sessionId));
          }
        } else if (tracked.toolName === "subagent") {
          const rawSkills = Array.isArray(input.skills) ? input.skills : Array.isArray(input.load_skills) ? input.load_skills : [];
          const names = rawSkills.map((s) => trimmed(s)).filter(Boolean);
          if (names.length > 0) {
            tracked.subagentSkills = names;
            tracked.subagentActor = trimmed(input.agent) || trimmed(input.category) || "subagent";
            effects.onEmitRootSession(resolveRootSessionId(store, sessionId));
          }
        }
      }
      break;
    }
    case "session.tool.progress": {
      const callId = trimmed(data.id);
      const metadata = isRecord(data.metadata) ? data.metadata : {};
      const childSessionId = trimmed(metadata.sessionID) || trimmed(metadata.sessionId);
      if (SESSION_ID_PATTERN.test(childSessionId)) {
        const tracked = callId ? node.inFlightTools.get(callId) : undefined;
        if (tracked) {
          tracked.childSessionId = childSessionId;
        }
        const kid = ensureSessionNode(store, childSessionId, now);
        if (!kid.parentId)
          kid.parentId = sessionId;
        if (linkChildSession(store, sessionId, childSessionId)) {
          const rootId = resolveRootSessionId(store, sessionId);
          effects.onHydrateSession(childSessionId, rootId);
        }
      }
      break;
    }
    case "session.tool.success": {
      const callId = trimmed(data.id);
      const metadata = isRecord(data.metadata) ? data.metadata : {};
      const tracked = callId ? node.inFlightTools.get(callId) : undefined;
      const fromContent = extractSkillTagNameFromToolContent(data.content);
      const rootId = resolveRootSessionId(store, sessionId);
      if (tracked?.toolName === "skill" || fromContent.id) {
        const parsed = parseSkillContent(fromContent.rawText);
        const skillId = trimmed(metadata.name) || tracked?.skillId || fromContent.id;
        const directory = trimmed(metadata.directory) || parsed.directory || null;
        if (skillId && callId) {
          node.inFlightTools.set(callId, {
            callId,
            toolName: "skill",
            skillId,
            childSessionId: null,
            subagentSkills: [],
            subagentActor: null,
            status: "active",
            at: eventAt,
            directory,
            description: parsed.description,
            preview: parsed.preview,
            error: null
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
      if (tracked?.toolName === "subagent" || SESSION_ID_PATTERN.test(childSessionId)) {
        if (callId)
          node.inFlightTools.delete(callId);
        markSessionDirty(node);
        if (SESSION_ID_PATTERN.test(childSessionId)) {
          const kid = ensureSessionNode(store, childSessionId, now);
          if (!kid.parentId)
            kid.parentId = sessionId;
          linkChildSession(store, sessionId, childSessionId);
          effects.onHydrateSession(childSessionId, rootId);
        }
        effects.onHydrateSession(sessionId, rootId);
      }
      break;
    }
    case "session.tool.failed": {
      const callId = trimmed(data.id);
      const tracked = callId ? node.inFlightTools.get(callId) : undefined;
      if (!tracked)
        break;
      const rootId = resolveRootSessionId(store, sessionId);
      if (tracked.toolName === "skill" && tracked.skillId) {
        const errObj = isRecord(data.error) ? data.error : null;
        const rawErr = (errObj ? trimmed(errObj.message) : trimmed(data.error)) || `Failed to load ${tracked.skillId}`;
        tracked.status = "failed";
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
    case "session.idle":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted": {
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
var connectEventStream = (store, opencodeUrl, token, effects) => {
  let stopped = false;
  let activeController = null;
  let backoffMs = 1000;
  const loop = async () => {
    while (!stopped) {
      activeController = new AbortController;
      try {
        const res = await fetch(`${opencodeUrl}/api/event`, {
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`
          },
          signal: activeController.signal
        });
        if (!res.ok || !res.body) {
          store.sseConnected = false;
          await new Promise((r) => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 15000);
          continue;
        }
        store.sseConnected = true;
        backoffMs = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder;
        let buffer = "";
        let dataLines = [];
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done)
            break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIdx = buffer.indexOf(`
`);
          while (newlineIdx !== -1) {
            const rawLine = buffer.slice(0, newlineIdx).replace(/\r$/, "");
            buffer = buffer.slice(newlineIdx + 1);
            if (rawLine === "") {
              if (dataLines.length > 0) {
                const payloadText = dataLines.join(`
`);
                dataLines = [];
                try {
                  const parsed = JSON.parse(payloadText);
                  applyOpenCodeWireEvent(store, parsed, effects, Date.now());
                } catch {}
              }
            } else if (rawLine.startsWith("data:")) {
              dataLines.push(rawLine.slice(5).trimStart());
            }
            newlineIdx = buffer.indexOf(`
`);
          }
        }
      } catch {
        store.sseConnected = false;
      }
      store.sseConnected = false;
      if (stopped)
        break;
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 15000);
    }
  };
  loop();
  return {
    stop: () => {
      stopped = true;
      activeController?.abort();
    }
  };
};
var parseHeatmapWindow = (raw) => {
  if (raw === "8w" || raw === "16w" || raw === "all")
    return raw;
  return "16w";
};
var parseHeatmapScope = (raw) => {
  if (raw === "all" || raw === "direct" || raw === "subagent")
    return raw;
  return "all";
};
var startServer = (options) => {
  const env = options?.env ?? process.env;
  const port = options?.port ?? Number(env.OPENCHAMBER_SERVICE_PORT);
  const token = options?.token ?? env.OPENCHAMBER_SERVICE_TOKEN;
  if (!port || !token)
    return null;
  const opencodeUrl = (options?.opencodeUrl ?? env.OPENCHAMBER_OPENCODE_URL ?? "").replace(/\/+$/, "");
  const host = createServiceHost({ env });
  const homeDir = options?.homeDir === undefined ? os2.homedir() || null : options.homeDir;
  const store = createSkillServiceStore(homeDir);
  const heatmapStore = createHeatmapStore({
    homeDir,
    dbPath: options?.dbPath,
    dataDir: options?.dataDir !== undefined ? options.dataDir : env.OPENCHAMBER_SERVICE_DATA_DIR?.trim() || null,
    extraSkillRoots: options?.extraSkillRoots,
    extraConfigPaths: options?.extraConfigPaths,
    opencodeUrl: opencodeUrl || undefined,
    serviceToken: token
  });
  let heatmapEmitTimer = null;
  const scheduleEmit = (rootSessionId) => {
    if (!rootSessionId || store.emitTimers.has(rootSessionId))
      return;
    const timer = setTimeout(() => {
      store.emitTimers.delete(rootSessionId);
      host.emit(SKILLS_UPDATED_TOPIC, { sessionId: rootSessionId }).catch(() => {});
    }, EMIT_DEBOUNCE_MS);
    store.emitTimers.set(rootSessionId, timer);
  };
  const scheduleHeatmapEmit = () => {
    heatmapStore.invalidate();
    if (heatmapEmitTimer)
      return;
    heatmapEmitTimer = setTimeout(() => {
      heatmapEmitTimer = null;
      host.emit(HEATMAP_UPDATED_TOPIC, { at: Date.now() }).catch(() => {});
    }, EMIT_DEBOUNCE_MS * 4);
  };
  const effects = {
    onEmitRootSession: scheduleEmit,
    onHydrateSession: (targetSessionId, rootSessionId) => {
      if (!opencodeUrl)
        return;
      hydrateSingleSession(store, opencodeUrl, token, targetSessionId).then(() => {
        scheduleEmit(resolveRootSessionId(store, targetSessionId) || rootSessionId);
      }).catch(() => {});
    },
    onEnrichDirectory: (directory, rootSessionId) => {
      enrichSkillMetadataFromDisk(store, directory).then(() => scheduleEmit(rootSessionId)).catch(() => {});
    },
    onHeatmapDirty: scheduleHeatmapEmit
  };
  const streamHandle = opencodeUrl ? connectEventStream(store, opencodeUrl, token, effects) : null;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && reqUrl.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/heatmap") {
      const windowParam = parseHeatmapWindow(reqUrl.searchParams.get("window"));
      const scopeParam = parseHeatmapScope(reqUrl.searchParams.get("scope"));
      const projectParam = reqUrl.searchParams.get("project")?.trim() || null;
      const directoryParam = reqUrl.searchParams.get("directory")?.trim() || null;
      const refreshParam = reqUrl.searchParams.get("refresh") === "1" || reqUrl.searchParams.get("refresh") === "true";
      heatmapStore.query({
        window: windowParam,
        scope: scopeParam,
        project: projectParam,
        directory: directoryParam,
        refresh: refreshParam
      }).then((payload) => {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      }).catch(() => {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Failed to build skill usage heatmap." }));
      });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/skills") {
      const sessionId = reqUrl.searchParams.get("sessionId")?.trim() ?? "";
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Provide a valid sessionId query parameter." }));
        return;
      }
      if (!opencodeUrl) {
        res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "OpenCode connection is unavailable." }));
        return;
      }
      const answerSkills = async () => {
        await hydrateSessionTree(store, opencodeUrl, token, sessionId);
        const rootNode = store.sessions.get(sessionId);
        const payload = buildSessionSkillsResponse(store, sessionId);
        if (!rootNode || rootNode.hydratedAt === null && payload.sessionSkills.length === 0 && payload.subagentSkills.length === 0) {
          res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Failed to read session messages from OpenCode." }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      };
      answerSkills().catch(() => {
        res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Failed to read session messages from OpenCode." }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
  });
  server.listen(port, "127.0.0.1");
  return {
    server,
    store,
    close: () => new Promise((resolve) => {
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
    })
  };
};
if (process.env.OPENCHAMBER_SERVICE_PORT && process.env.OPENCHAMBER_SERVICE_TOKEN) {
  startServer();
}
export {
  applyOpenCodeWireEvent,
  buildSessionSkillsResponse,
  createSkillServiceStore,
  ensureSessionNode,
  hydrateSessionTree,
  hydrateSingleSession,
  resolveRootSessionId,
  startServer
};
