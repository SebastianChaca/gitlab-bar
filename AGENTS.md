# AGENTS.md

Architecture map for AI agents (and humans) working on this repo. Read this before making changes — it explains the shape of the app so you don't have to re-derive it from scratch every session.

## What this is

`gitlab-bar` is an Electron menu-bar app (macOS tray icon, no Dock icon) that polls GitLab for merge requests relevant to the logged-in user and shows them in a small popup window, grouped into categories with status badges.

Stack: Electron + React + TypeScript, scaffolded with `electron-vite`. Package manager: npm.

## Process split (standard Electron three-process model)

```
src/main/         → main process: Node/Electron APIs, GitLab API calls, credential storage, IPC
src/preload/      → contextBridge surface exposed to the renderer as `window.api`
src/renderer/src/ → React UI (single popup window's content)
```

The renderer runs `sandbox: true` + `contextIsolation: true`. It never touches the GitLab token, the filesystem, or `fetch` to GitLab directly — everything goes through `window.api` → IPC → main process.

## `src/main/index.ts` — app lifecycle

- Single-instance lock: a second launch just focuses/toggles the existing tray popup and quits itself.
- Creates one `Tray` and one frameless, always-on-top `BrowserWindow` ("popup") sized 280×420, positioned under the tray icon. The popup hides on blur rather than being destroyed/recreated.
- Right-click on the tray shows a small context menu (Log out / Quit), rebuilt on every click so "Log out" reflects current credential state.
- On `app.whenReady()`: hides the Dock icon (macOS), registers GitLab IPC handlers, and starts the poll loop. Both take a `getWindow: () => BrowserWindow | null` getter rather than a captured reference, since the popup is created once and lives for the app's lifetime.

## `src/main/gitlab/` — the GitLab integration

This is where almost all domain logic lives. Five files, each with one job:

| File | Responsibility |
|---|---|
| `client.ts` | Thin GitLab REST v4 wrapper. Plain `fetch`, no HTTP library. Every exported function is one API call. |
| `service.ts` | **The categorization logic.** Fetches raw MRs via `client.ts`, cross-references them, and produces the typed result the renderer consumes. This is the file to read/edit when changing what counts as "ready to merge", adding a badge, etc. |
| `storage.ts` | Persists credentials (OS-encrypted via `safeStorage`, written to `credentials.enc`) and small JSON state files (`config.json` for instance URL + cached username, `mr-state.json` for last-seen-comment ids) under Electron's `userData` dir. |
| `ipc.ts` | Registers `ipcMain.handle` handlers, runs the 60s poll loop (`startGitLabPolling`), and pushes `MergeRequestsUpdatePayload` events to the renderer. |
| `types.ts` | Shared types (`MergeRequestSummary`, `MergeRequestsResult`, IPC payload shapes). Deliberately dependency-free so it's safe to import from main, preload, and renderer alike. |

### How categorization works (`service.ts: fetchMergeRequestsUpdate`)

GitLab's list endpoint (`GET /merge_requests`) can't answer "who approved this" or "is this ready to merge" directly — it can only filter by reviewer/author/assignee/approved-by-a-specific-user. So the categories are built by fetching several filtered lists in parallel and cross-referencing them, plus one extra per-MR call where GitLab genuinely has no batch equivalent (approvals).

Fetched in parallel: MRs where the user is **reviewer**, **author**, **assignee**, and MRs **approved by the user**. All four requests add `with_merge_status_recheck: 'true'` — GitLab's docs note `has_conflicts`/`merge_status` on the plain list endpoint can be stale otherwise, since listing MRs doesn't proactively recompute merge status.

Categories produced (`MergeRequestsResult`):

- **`reviewRequested`** — reviewer MRs, minus ones the user already approved.
- **`approved`** — MRs the user has approved (plain reference list, GitLab-filtered).
- **`newComments`** — reviewer+author MRs (deduped, minus self-approved), filtered down to ones with an actionable human comment. Requires an extra per-MR call to `GET .../discussions` (`fetchMergeRequestDiscussions`) rather than the flat `/notes` endpoint, specifically to get each note's `resolvable`/`resolved` state. Two different signals depending on the note type: a **resolvable** note (diff/review comment) counts only while its thread is `resolved: false` — GitLab is the source of truth here, so resolving it in GitLab itself (any client, not just this app) clears it, no local tracking involved. A **non-resolvable** note (plain top-level comment — GitLab has no "resolved" concept for these) falls back to the old mechanism: compared against `mr-state.json`'s last-seen id (`isNoteNewerThanLastSeen`), cleared only by clicking the row in this app. This hybrid exists because relying solely on local "seen" tracking meant resolving a review thread in GitLab's own UI never cleared the badge here — see the test names in `service.test.ts` for the exact before/after behavior.
- **`readyToMerge`** / **`awaitingReview`** — every MR the user is **assignee** of, *except ones carrying the `backlog` label* (filtered out before either bucket, before the approvals call even fires — deliberately parked work shouldn't nag for attention), is split between these two. `readyToMerge` requires **both** signals: 2+ non-self approvals (`REQUIRED_APPROVALS` in `service.ts`) **and** the `qa_approved` label. Everything else — including MRs with zero approvals and zero comments, which used to be invisible entirely — falls into `awaitingReview`. Both require a per-MR call to `GET .../approvals` (`fetchMergeRequestApprovals`) since approvals aren't in the list payload; unlike `newComments`, a failed per-MR approvals call does **not** drop the MR — it falls back into `awaitingReview` (treated as 0 approvals) rather than disappearing. This "never let an assignee MR vanish" behavior is deliberate — see the git history around the `awaitingReview` split for the incident that motivated it (an MR assigned same-day, no approvals/comments yet, wasn't showing up anywhere).

Badges (fields on `MergeRequestSummary`, computed in `toSummary()`):

- **`qaPending`** — `mr.labels.includes('qa_pending')`. Computed for every MR, shown wherever it's true.
- **`qaApproved`** — `mr.labels.includes('qa_approved')`. Not rendered as its own badge; used as one half of the `readyToMerge` gate.
- **`approvalsRemaining`** — meaningful for MRs the user is assignee of (both `readyToMerge` and `awaitingReview`). A **count**, not a boolean: `Math.max(REQUIRED_APPROVALS - othersApprovedCount, 0)` (`REQUIRED_APPROVALS = 2`, a local constant in `service.ts`) — 0, 1, or 2 non-self approvals still needed. This used to be a boolean (`awaitingSecondApproval`) that couldn't distinguish "0 approvals" from "1 approval", so the badge always said "1 approval pending" even for an MR with zero — fixed by making it a count the UI renders directly ("Needs 1 approval" / "Needs 2 approvals").
- **`hasConflicts`** — `mr.has_conflicts` straight from the list response (no extra per-MR call needed). Computed for every MR, shown wherever it's true, styled red (`.mr-badge-danger`) unlike the other badges.

**Failure isolation pattern, important to preserve:** the four parallel list-fetches (reviewer/author/approved/assignee) are a single `Promise.all` — if any one of them throws, the *entire* poll cycle fails and the renderer shows an error state (recovers on the next 60s tick). By contrast, every **per-MR** call (notes, approvals) never rejects the batch: `newComments` drops the offending MR on failure, while `readyToMerge`/`awaitingReview` never drop it at all (see above) — a flaky MR should never sink the whole poll, and an assignee MR should never disappear. Keep this asymmetry when adding new per-MR enrichment calls.

### "Actionable" MRs: tray badge + notifications (`getActionableMergeRequests`/`countActionableMergeRequests`)

These two pure functions in `service.ts` define what "needs your attention right now" means: `reviewRequested` + `newComments` + `readyToMerge`, deduped by id. `awaitingReview` is deliberately excluded — those are the user's own MRs waiting on *other people*, not something the user needs to act on. They take a `MergeRequestsResult` and have no I/O, which is exactly why they're covered by tests (see below) — cheap to verify, easy to silently break.

Two consumers in `ipc.ts`, both driven from `pushUpdate` on every successful poll:

- **Tray badge** (`updateTrayTitle`) — macOS only (`Tray.setTitle` is a no-op elsewhere); shows the actionable count as text next to the tray icon, or clears it when zero.
- **Native notifications** (`notifyNewlyActionable`) — diffs the current actionable id set against `previousActionableIds` (module-level `Set`, reset on log-out) and notifies only on *new* arrivals: one detailed notification for a single new MR, one summary notification for several at once (never a burst). The very first poll after (re)start/login only seeds `previousActionableIds` — it deliberately never notifies, since everything already pending would otherwise fire at once. Clicking a notification reuses `openMergeRequestUrl` (extracted from the IPC handler) so the same origin-allowlist check applies.

If you change what counts as "actionable," both the tray badge and notifications pick it up automatically — that's the point of centralizing it in one function.

## `src/preload/index.ts` — the `window.api` bridge

Exposes exactly five methods + two event subscriptions (`onMergeRequestsUpdate`, `onLoggedOut`) via `contextBridge`. IPC channel name strings are **hardcoded here** rather than imported from `gitlab/ipc.ts`, on purpose — that module transitively pulls in Node/Electron-main-only APIs (`fs`, `app`, `safeStorage`) which must not end up in this sandboxed script. If you rename a channel in `ipc.ts`, update the string literal here too.

## `src/renderer/src/` — the UI

`App.tsx` holds only the top-level state machine (`checking → needs-credentials | loading → ready | error`) and the bootstrap effect (initial fetch + `onMergeRequestsUpdate`/`onLoggedOut` subscriptions). Everything else was split out into `components/` once `App.tsx` grew past ~280 lines and got hard to scan:

| File | Responsibility |
|---|---|
| `components/CredentialsForm.tsx` | The "Connect GitLab" token form. |
| `components/MergeRequestSection.tsx` | One category section — title, empty state, and `sortByProject` (sorts a section's items by `projectPath` so same-repo MRs sit together; deliberately *not* sub-grouped, per an explicit product call — see below). |
| `components/MergeRequestRow.tsx` | One MR row: title, project name (last path segment via `projectName()`, full path in a `title` tooltip), and badges. Click behavior (`openMergeRequest` + `markMergeRequestSeen`) lives here. |
| `components/icons.tsx` | The three inline SVG badge icons (`ConflictIcon`, `ClockIcon`, `CheckCircleIcon`), sharing one `ICON_PROPS` object. |

No new abstraction beyond this — still plain function components, no state management library, no barrel `index.ts`.

`App` renders one `<MergeRequestSection>` per category; sections with a possibly-empty list (`approved`, `readyToMerge`, `awaitingReview`) only render when non-empty.

### Row layout, deliberate

The title (`.mr-title`) sits alone on its own row, full width — it never shares horizontal space with badges. Project name + badges (`.mr-row-meta`) sit together on a second row below it, and `flex-wrap: wrap` there lets them spill onto a third line rather than fight the title for space. This exists because badges used to sit beside the title on one row (`margin-left: auto` pushing them right) — with two verbose text badges (e.g. "QA" + "Needs 2 approvals") in a 280px popup, that squeezed the title down to a sliver, visually overlapping it. Keep new badges inside `.mr-row-meta`, not beside `.mr-title`.

Badges are icon-only (`.mr-badge-icon`, `icons.tsx`) rather than text — text badges ate too much of the 280px width even after being moved off the title's row. Each carries a short `data-tooltip` (see `[data-tooltip]` in `main.css`) rendered via a custom CSS `::after` tooltip instead of the native `title` attribute — native tooltips are slow to appear and can't be themed to match the dark UI. **Keep tooltip text to a couple of words** ("Merge conflicts", "QA pending", "2 approvals needed"): the tooltip anchors to the *badge's own* right edge (`right: 0`, growing leftward) since badges usually sit near the row's right edge in a 280px popup — a longer, centered tooltip (the original approach) pushed past the edge and forced horizontal scroll. `aria-label` carries the same meaning for screen readers without triggering a second, native tooltip.

## Extending the categorization (recipe)

Adding a new category or badge touches the same four files every time, in this order:

1. `client.ts` — add the API call (or field on `GitLabMergeRequest`) if GitLab doesn't already give you the data.
2. `service.ts` — compute it inside `fetchMergeRequestsUpdate`/`toSummary`, decide the failure-isolation story (batch vs. per-MR try/catch, per the pattern above).
2. `types.ts` — add the field to `MergeRequestSummary` and/or `MergeRequestsResult`.
4. `components/MergeRequestRow.tsx` (+ `main.css`) — render it: a new icon in `icons.tsx` + a new `<span className="mr-badge mr-badge-icon" data-tooltip="...">` inside `.mr-row-meta` for a badge (never beside `.mr-title` — see the layout note above), or a new `<MergeRequestSection>` in `App.tsx` for a category.

Prefer a badge over a new category when the underlying signal is a *modifier* of an existing list (e.g. "still needs a second approval") rather than a genuinely new "why is this MR in front of me" reason — this keeps the section count from creeping up indefinitely. This was an explicit product decision made while building the QA/second-approval badges, not an accident.

## Commands

```bash
npm run dev         # electron-vite dev, hot reload
npm run typecheck   # tsc --noEmit for both main/preload (node) and renderer (web) configs
npm run test        # vitest run — currently covers src/main/gitlab/service.ts only
npm run build:mac   # production build
```

Requires Node 18+ (vitest 4 won't run on older Node) — if `npm test` fails to even start, check `node -v` before assuming the test is broken.

## Tests (`src/main/gitlab/service.test.ts`)

Covers `service.ts` — the categorization engine — via `vitest`, mocking `./client` and `./storage` entirely (no network, no filesystem, no real Electron APIs). Cases: approved-MR exclusion from `reviewRequested`, `qaPending` label detection, the `readyToMerge` gate (approvals + `qa_approved` AND'd together) vs. `awaitingReview` catch-all, an MR surviving a failed approvals fetch instead of disappearing, `newComments`' resolved-thread vs. local-seen-tracking hybrid (an unresolved review thread shows regardless of local state; a resolved one hides even if never "seen" locally; system notes and the user's own notes never count), `isNoteNewerThanLastSeen`'s boundary conditions, and `getActionableMergeRequests`/`countActionableMergeRequests` dedup + exclusion behavior.

There's no test setup for `App.tsx`, `ipc.ts`, or `index.ts` yet — those still rely on `npm run typecheck` plus manual exercise via `npm run dev`.
