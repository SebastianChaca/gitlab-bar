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

Fetched in parallel: MRs where the user is **reviewer**, **author**, **assignee**, and MRs **approved by the user**.

Categories produced (`MergeRequestsResult`):

- **`reviewRequested`** — reviewer MRs, minus ones the user already approved.
- **`approved`** — MRs the user has approved (plain reference list, GitLab-filtered).
- **`newComments`** — reviewer+author MRs (deduped, minus self-approved), filtered down to ones with an unread human comment. Requires an extra per-MR call to `GET .../notes` (`fetchRecentNotes`) since the list endpoint doesn't include comments. "Unread" is tracked by comparing the latest human note id against `mr-state.json`'s last-seen id (`isNoteNewerThanLastSeen`).
- **`approvedByOthers`** ("Ready to Merge" in the UI) — MRs the user is **assignee** of, with at least one approval from someone other than themselves. Requires a per-MR call to `GET .../approvals` (`fetchMergeRequestApprovals`) since approvals aren't in the list payload either.

Badges (fields on `MergeRequestSummary`, computed in `toSummary()`):

- **`qaPending`** — `mr.labels.includes('qa_pending')`. Computed for every MR, shown wherever it's true.
- **`awaitingSecondApproval`** — only meaningful for `approvedByOthers`. Team policy requires 2 approvals before merge; this is `true` when the MR has exactly 1 non-self approval instead of the required `REQUIRED_APPROVALS = 2` (a local constant in `service.ts`).

**Failure isolation pattern, important to preserve:** the four parallel list-fetches (reviewer/author/approved/assignee) are a single `Promise.all` — if any one of them throws, the *entire* poll cycle fails and the renderer shows an error state (recovers on the next 60s tick). By contrast, every **per-MR** call (notes, approvals) is wrapped in its own try/catch that swallows the error and just excludes that one MR from the result — one flaky MR should never sink the whole poll. Keep this asymmetry when adding new per-MR enrichment calls.

## `src/preload/index.ts` — the `window.api` bridge

Exposes exactly five methods + two event subscriptions (`onMergeRequestsUpdate`, `onLoggedOut`) via `contextBridge`. IPC channel name strings are **hardcoded here** rather than imported from `gitlab/ipc.ts`, on purpose — that module transitively pulls in Node/Electron-main-only APIs (`fs`, `app`, `safeStorage`) which must not end up in this sandboxed script. If you rename a channel in `ipc.ts`, update the string literal here too.

## `src/renderer/src/App.tsx` — the UI

Single file, function components, no state management library. `App`'s `view` state machine: `checking → needs-credentials | loading → ready | error`. Renders one `<MergeRequestSection>` per category; sections with a possibly-empty list (`approved`, `approvedByOthers`) only render when non-empty. Badges render as `<span className="mr-badge ...">` inside `MergeRequestRow`, styled in `src/renderer/src/assets/main.css`.

## Extending the categorization (recipe)

Adding a new category or badge touches the same four files every time, in this order:

1. `client.ts` — add the API call (or field on `GitLabMergeRequest`) if GitLab doesn't already give you the data.
2. `service.ts` — compute it inside `fetchMergeRequestsUpdate`/`toSummary`, decide the failure-isolation story (batch vs. per-MR try/catch, per the pattern above).
2. `types.ts` — add the field to `MergeRequestSummary` and/or `MergeRequestsResult`.
4. `App.tsx` (+ `main.css`) — render it: a new `<MergeRequestSection>` for a category, a new `<span className="mr-badge">` for a badge.

Prefer a badge over a new category when the underlying signal is a *modifier* of an existing list (e.g. "still needs a second approval") rather than a genuinely new "why is this MR in front of me" reason — this keeps the section count from creeping up indefinitely. This was an explicit product decision made while building the QA/second-approval badges, not an accident.

## Commands

```bash
npm run dev         # electron-vite dev, hot reload
npm run typecheck   # tsc --noEmit for both main/preload (node) and renderer (web) configs
npm run build:mac   # production build
```

There is no test suite in this repo currently — verification is `npm run typecheck` plus manual exercise via `npm run dev`.
