# AI Draft via opencode headless — design

**Date:** 2026-06-07
**Target:** `design-template-generator.html` (single-file HTML app, no build step)
**Goal:** Reduce Fill-mode friction (blank-page paralysis, repetitive typing) with per-section, codebase-grounded AI drafting through a local `opencode serve` instance.

## Problem

Fill mode requires users to hand-type every placeholder across 10+ sections. Users don't know what to write (blank-page paralysis) and the table editing is repetitive. The facts needed (routes, schemas, endpoints, dependencies) already exist in the service's codebase.

## Solution overview

The user runs `opencode serve` from the service repo root. The generator page calls the server's HTTP API directly from the browser. Each Fill-mode section gets a "✨ Draft" button: the agent inspects the real codebase and returns the completed section markdown, which replaces that section's fill data. Anything the agent cannot verify from code stays as a placeholder, so the existing completeness signals remain an honest review queue.

Chosen over two alternatives:
- **Prompt-pack export + `opencode run` re-import** — rejected: manual multi-step loop defeats the friction-reduction goal.
- **Whole-doc one-shot generation** — rejected: per-section granularity was chosen for reviewable chunks and cheap retries.

## 1. Architecture & connection

- All code stays in `design-template-generator.html`. No build step, no new runtime files.
- New module block `// ── AI draft (opencode) ──` containing a small client: `aiCreateSession()`, `aiDraftSection(n)`, plus the pure helpers listed in §4.
- **Config:** new fields in the existing settings object (`CFG`, localStorage key `dds_settings_v1`):
  - `aiUrl` — default `http://127.0.0.1:4096`
  - `aiModel` — blank = server default
  - `aiAgent` — blank = default agent
- **Session lifecycle:** lazy. First Draft click → `POST /session` (title `"<service> design doc"`). Session ID kept in memory only — not persisted; a stale session after reload has no value. One session per page load so the agent retains repo context across sections (faster, more consistent later sections).
- **Per-section call:** `POST /session/:id/message` with `{ model?, agent?, parts: [{type:'text', text: prompt}] }`, synchronous wait. Response text = concatenation of text parts from the returned `parts` array.
- **Connectivity check:** before the first call, `GET /doc` as a cheap ping. Unreachable → inline banner with the exact launch command: `opencode serve --cors <origin>` run from the service repo root.
- **`file://` caveat:** a page opened from disk sends `Origin: null`; the banner shows the `--cors null` variant and notes that serving the HTML via any static server is an alternative.

## 2. Prompt construction & response handling

Prompt per section, assembled entirely from existing data structures:

1. **Role line:** "You are filling one section of a system-design doc for the codebase in your working directory. Inspect the code; state facts, don't invent."
2. **Service context:** name, one-liner, owner, tech-stack lines (`buildTechStackLines()`).
3. **Current section markdown:** `serializeBlocks(fillData[n])` — the user's partial edits are included so the agent fills only the remaining placeholders and respects existing content.
4. **Section rules:** the section's `hint` plus a guide excerpt — `guideMarkdown(n)` truncated at the first worked-example heading (same `/worked example/i` heading detection as `extractExampleTables`), so example data is never sent and the agent cannot copy it.
5. **Output contract:** "Return ONLY the completed section markdown, same headings, same table columns. Keep `_placeholder_` style for anything you cannot verify from code."

Response handling:

- Extract text parts → strip a single wrapping code fence if the agent fenced the whole answer → `parseMarkdownBlocks()`.
- **Validation:** result must contain ≥ 1 block; the first text block must start with `## ` matching the section heading; every table must keep the same header signature (`tableSig`). A table with a mismatched signature is rejected and the original block kept.
- **On accept:** snapshot the old blocks to `aiUndo[n]` (memory only, one level), replace `fillData[n]`, `rerenderSection(n)`. Placeholder badges and global progress update through the existing machinery.

## 3. UI flow

- Fill mode only — no new wizard step. Each section header gains a `✨ Draft` button next to the existing `Load example` / `Guide` / `Reset` buttons.
- Click → button becomes a spinner with `Drafting…` and elapsed seconds; the section dims slightly. Other sections' Draft buttons stay enabled, but requests are queued client-side (FIFO, one in-flight message per session — concurrent messages to one opencode session are not assumed safe). A queued section's button shows `Queued`.
- Success → section re-renders filled; the button shows `↩ Undo` (one level, reverts from `aiUndo[n]`). Undo does not survive page reload — the snapshot is memory-only.
- The sticky fill-nav gains `✨ Draft unfilled`: loops over sections with placeholder count > 0, sequentially (one at a time to keep server load sane). Progress shows in the nav: `Drafting 07 AuthN… (3/9)`. A Cancel button stops after the current section completes.
- Drafting over a section the user has edited asks for confirmation via `confirm()` — same pattern as `loadExample`.
- First use with no reachable server → banner in the fill-nav area with the launch command and a small inline `AI settings` panel (URL / model / agent fields).

## 4. Error handling

Each error shows inline near the section header (or fill-nav for batch); no `alert()` mid-flow.

| Condition | Detection | Behaviour |
|---|---|---|
| Server down / CORS blocked | `fetch` rejects with TypeError | Banner with exact launch command (`--cors` variant chosen by current origin) |
| HTTP 4xx/5xx | response status | "Server error (status): body excerpt" + Retry button |
| Slow call | — | No imposed timeout (agent calls are legitimately slow). Elapsed seconds shown; batch has Cancel |
| Validation reject | §2 validation fails | "Response didn't match section format" + Retry; `fillData` untouched |
| Mid-batch failure | any of the above during Draft-unfilled | Loop stops, failed section reported, completed drafts kept |

## 5. Testing

The project has no test infrastructure (buildless single HTML file). Plan:

- **Pure, extractable functions** kept side-effect-free for future unit testing: `buildSectionPrompt(n, ctx)`, `validateSectionResponse(n, text)`, `extractResponseText(parts)`.
- **Mock server:** `test/mock-opencode.js` (~40-line Node script) mimicking `GET /doc`, `POST /session`, `POST /session/:id/message` with canned section responses.
- **Manual E2E checklist** (run against the mock, then once against real opencode):
  1. Connect: banner shown when server down; disappears when reachable
  2. Draft one section — placeholders filled, badge flips to ✓ ready
  3. Undo — section reverts, badge restored
  4. Draft over edited section — confirm dialog appears
  5. Draft unfilled batch — sequential progress, only placeholder-bearing sections drafted
  6. Cancel mid-batch — stops after current section, drafts kept
  7. Error paths: server down, HTTP 500, malformed markdown response (validation reject)
  8. Settings: custom URL/model/agent persist across reload

**Deviation noted:** this does not meet the global 80% automated-coverage rule. Adding a test framework (vitest + jsdom) to a buildless single-file tool was judged larger than the feature itself. Accepted by user during design review; revisit if the file gains more AI features.

## Out of scope (this round)

- Cross-section value reuse, cell autocomplete, keyboard navigation (explicitly deferred)
- Per-cell / per-table AI suggestions
- Whole-doc one-shot generation
- API-key-in-browser direct LLM calls
- Streaming responses (sync request/response only)
