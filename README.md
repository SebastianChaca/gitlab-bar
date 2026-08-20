# gitlab-bar

A macOS menu-bar app that watches your GitLab merge requests and shows you what needs attention, without keeping a browser tab open.

Click the tray icon to open a small popup with your merge requests, grouped into categories. It refreshes automatically every 60 seconds.

## Setup

1. Create a GitLab personal access token with `read_api` scope.
2. Launch the app and paste the token in on first run.

Your token is encrypted at rest using your OS's secure storage (Keychain on macOS) and never leaves the app's main process — the UI only ever talks to GitLab through it.

## Categories

- **To Review** — open MRs where you're a requested reviewer, and you haven't approved yet.
- **New Comments** — MRs you're reviewing or authoring that have a human comment you haven't seen yet (system notes like pushes/label changes don't count). Click a row to open it and mark it as seen.
- **Approved by me** — open MRs you've already approved. Just a reference list, no unread-comment tracking.
- **Ready to Merge** — open MRs where you're the assignee, that already have at least one approval from someone else.

An MR only disappears from these lists once it's merged, closed, or no longer matches the category's condition (e.g. you approve it, so it moves out of "To Review").

## Badges

Shown as small tags on a merge request row:

- **QA pending** — the MR carries the `qa_pending` GitLab label. Shown in any category, not just "Ready to Merge".
- **Approval pending** — only in "Ready to Merge": our team policy requires two approvals before merging, so this flags an MR that's only gotten one so far — it's a candidate, not fully cleared yet.

## Logging out

Right-click the tray icon → **Log out**. This clears the stored token and all local state (last-seen comments, cached username) — the next launch starts fresh.

## Development

### Install

```bash
$ npm install
```

### Run

```bash
$ npm run dev
```

### Type-check

```bash
$ npm run typecheck
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

For the internal architecture (main/preload/renderer split, how categories and badges are computed, how to add a new one), see [AGENTS.md](./AGENTS.md).
