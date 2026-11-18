# Session Skills

OpenChamber extension that shows skills activated in the current session (and its subagents) inside the **Work Status** panel, with a live context-window position bar and turn-age readout.

## What it shows

- **Main session skills**: Each row displays `[skill-id] [context-window bar] [turn age]` (`now`, `1t`, `3t`).
  - The context-window bar plots where the skill's latest activation sits inside the active prompt window (`0 → latestContextTokens` from OpenCode step token watermarks: left = deep/early in context, right = live prompt tip).
  - Skills evicted by a completed session compaction render with a hollow dot and dashed empty bar.
- **Collapsible Subagent group**: Skills activated inside child subagents (`parentID` / `subagent` tool) sit under a collapsible `Subagent · <agent>` / `Subagents` header, plotting position inside each subagent's own context window paired with main-session turn age.
- **Detail popover**: Hovering, focusing, or clicking any row opens a floating card with exact token depth (`at 36k / 241k`), description, `SKILL.md` path & preview, and quick buttons (`Insert in chat`, `Copy $skill`, `Copy path`).

## Commands

```bash
bun run build
bun run typecheck
bun run check
bun test
```
