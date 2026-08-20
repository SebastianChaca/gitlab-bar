import { beforeEach, describe, expect, it, vi } from 'vitest'

// `service.ts` is the categorization engine — the part of this app most
// likely to silently regress (dedupe rules, approval thresholds, "unseen
// comment" detection). It's pure logic layered on top of `client.ts`/
// `storage.ts`, so both are mocked here and never hit the network or disk.
vi.mock('./client', () => ({
  fetchReviewerMergeRequests: vi.fn(),
  fetchAuthorMergeRequests: vi.fn(),
  fetchApprovedByMeMergeRequests: vi.fn(),
  fetchAssigneeMergeRequests: vi.fn(),
  fetchAuthenticatedUsername: vi.fn(),
  fetchMergeRequestDiscussions: vi.fn(),
  fetchMergeRequestApprovals: vi.fn()
}))

vi.mock('./storage', () => ({
  getCachedUsername: vi.fn(),
  setCachedUsername: vi.fn(),
  getLastSeenNoteId: vi.fn(),
  setLastSeenNoteId: vi.fn(),
  loadCredentials: vi.fn()
}))

import * as client from './client'
import * as storage from './storage'
import {
  countActionableMergeRequests,
  fetchMergeRequestsUpdate,
  getActionableMergeRequests,
  isNoteNewerThanLastSeen
} from './service'
import type { GitLabDiscussion, GitLabMergeRequest, GitLabNote } from './client'
import type { MergeRequestSummary, MergeRequestsResult } from './types'

const CURRENT_USER = 'seba'

function mr(overrides: Partial<GitLabMergeRequest> & { id: number }): GitLabMergeRequest {
  return {
    iid: overrides.id,
    project_id: 10,
    title: `MR ${overrides.id}`,
    web_url: `https://gitlab.example.com/group/project/-/merge_requests/${overrides.id}`,
    author: { username: 'author-user' },
    updated_at: '2026-01-01T00:00:00Z',
    references: { full: `group/project!${overrides.id}` },
    ...overrides
  }
}

function note(overrides: Partial<GitLabNote> & { id: number }): GitLabNote {
  return {
    system: false,
    author: { username: 'other-user' },
    resolvable: false,
    resolved: false,
    ...overrides
  }
}

/** Wraps a single note as its own one-note discussion thread. */
function discussionOf(n: GitLabNote): GitLabDiscussion {
  return { id: `discussion-${n.id}`, individual_note: !n.resolvable, notes: [n] }
}

beforeEach(() => {
  vi.resetAllMocks()

  vi.mocked(storage.loadCredentials).mockResolvedValue({
    instanceUrl: 'https://gitlab.example.com',
    token: 'token'
  })
  vi.mocked(storage.getCachedUsername).mockResolvedValue(CURRENT_USER)
  vi.mocked(storage.getLastSeenNoteId).mockResolvedValue(undefined)

  vi.mocked(client.fetchReviewerMergeRequests).mockResolvedValue([])
  vi.mocked(client.fetchAuthorMergeRequests).mockResolvedValue([])
  vi.mocked(client.fetchApprovedByMeMergeRequests).mockResolvedValue([])
  vi.mocked(client.fetchAssigneeMergeRequests).mockResolvedValue([])
  vi.mocked(client.fetchMergeRequestDiscussions).mockResolvedValue([])
  vi.mocked(client.fetchMergeRequestApprovals).mockResolvedValue({ approved_by: [] })
})

describe('fetchMergeRequestsUpdate', () => {
  it('excludes MRs the user already approved from "review requested", surfacing them under "approved" instead', async () => {
    const reviewed = mr({ id: 1 })
    const alreadyApproved = mr({ id: 2 })
    vi.mocked(client.fetchReviewerMergeRequests).mockResolvedValue([reviewed, alreadyApproved])
    vi.mocked(client.fetchApprovedByMeMergeRequests).mockResolvedValue([alreadyApproved])

    const result = await fetchMergeRequestsUpdate()

    expect(result.reviewRequested.map((m) => m.id)).toEqual([1])
    expect(result.approved.map((m) => m.id)).toEqual([2])
  })

  it('flags qaPending from the qa_pending GitLab label, regardless of category', async () => {
    vi.mocked(client.fetchReviewerMergeRequests).mockResolvedValue([
      mr({ id: 1, labels: ['qa_pending', 'other'] }),
      mr({ id: 2, labels: ['other'] })
    ])

    const result = await fetchMergeRequestsUpdate()

    expect(result.reviewRequested.find((m) => m.id === 1)?.qaPending).toBe(true)
    expect(result.reviewRequested.find((m) => m.id === 2)?.qaPending).toBe(false)
  })

  it('flags hasConflicts from has_conflicts, regardless of category', async () => {
    vi.mocked(client.fetchReviewerMergeRequests).mockResolvedValue([
      mr({ id: 1, has_conflicts: true }),
      mr({ id: 2, has_conflicts: false })
    ])

    const result = await fetchMergeRequestsUpdate()

    expect(result.reviewRequested.find((m) => m.id === 1)?.hasConflicts).toBe(true)
    expect(result.reviewRequested.find((m) => m.id === 2)?.hasConflicts).toBe(false)
  })

  it('puts an assignee MR in "Ready to Merge" only when it has 2+ approvals AND the qa_approved label', async () => {
    const fullyReady = mr({ id: 1, labels: ['qa_approved'] })
    const approvedButNoQa = mr({ id: 2 })
    const qaApprovedButOneReview = mr({ id: 3, labels: ['qa_approved'] })
    const onlySelfApproval = mr({ id: 4, labels: ['qa_approved'] })
    const noApprovalsYet = mr({ id: 5 })

    vi.mocked(client.fetchAssigneeMergeRequests).mockResolvedValue([
      fullyReady,
      approvedButNoQa,
      qaApprovedButOneReview,
      onlySelfApproval,
      noApprovalsYet
    ])

    const twoApprovals = {
      approved_by: [{ user: { username: 'reviewer-a' } }, { user: { username: 'reviewer-b' } }]
    }
    vi.mocked(client.fetchMergeRequestApprovals).mockImplementation(
      async (_url, _token, _projectId, iid) => {
        const approvalsByIid: Record<number, { approved_by: { user: { username: string } }[] }> = {
          1: twoApprovals,
          2: twoApprovals,
          3: { approved_by: [{ user: { username: 'reviewer-a' } }] },
          4: { approved_by: [{ user: { username: CURRENT_USER } }] },
          5: { approved_by: [] }
        }
        return approvalsByIid[iid]
      }
    )

    const result = await fetchMergeRequestsUpdate()

    expect(result.readyToMerge.map((m) => m.id)).toEqual([1])
    // Everything else lands in "awaiting review" instead of disappearing —
    // including the MR with zero approvals so far.
    expect(result.awaitingReview.map((m) => m.id).sort()).toEqual([2, 3, 4, 5])

    // The badge must distinguish how many approvals are actually still
    // missing (1 vs. 2), not just "some are missing" — a 0-approval MR and a
    // 1-approval MR are not in the same state.
    const byId = new Map(result.awaitingReview.map((m) => [m.id, m]))
    expect(byId.get(2)?.approvalsRemaining).toBe(0) // 2 approvals, just missing qa_approved
    expect(byId.get(3)?.approvalsRemaining).toBe(1) // 1 approval so far
    expect(byId.get(4)?.approvalsRemaining).toBe(2) // only a self-approval, doesn't count
    expect(byId.get(5)?.approvalsRemaining).toBe(2) // no approvals at all
  })

  it('keeps an assignee MR in "awaiting review" instead of dropping it when the approvals fetch fails', async () => {
    vi.mocked(client.fetchAssigneeMergeRequests).mockResolvedValue([mr({ id: 1 })])
    vi.mocked(client.fetchMergeRequestApprovals).mockRejectedValue(new Error('network error'))

    const result = await fetchMergeRequestsUpdate()

    expect(result.awaitingReview.map((m) => m.id)).toEqual([1])
    expect(result.readyToMerge).toEqual([])
  })

  it('includes MRs with an unresolved review thread in "New Comments", regardless of local seen-state', async () => {
    const unresolvedThread = mr({ id: 1 })
    const resolvedThread = mr({ id: 2 })

    vi.mocked(client.fetchReviewerMergeRequests).mockResolvedValue([
      unresolvedThread,
      resolvedThread
    ])

    vi.mocked(client.fetchMergeRequestDiscussions).mockImplementation(
      async (_url, _token, _projectId, iid) => {
        const discussionsByIid: Record<number, GitLabDiscussion[]> = {
          1: [discussionOf(note({ id: 10, resolvable: true, resolved: false }))],
          2: [discussionOf(note({ id: 20, resolvable: true, resolved: true }))]
        }
        return discussionsByIid[iid] ?? []
      }
    )

    // Even if the app previously recorded a "last seen" id well past the
    // thread's note, an *unresolved* review thread must still show — GitLab's
    // resolved status wins over local seen-tracking, not the other way
    // around. This is what actually fixes the bug: resolving in GitLab
    // itself (not clicking through this app) must clear the resolved MR too.
    vi.mocked(storage.getLastSeenNoteId).mockResolvedValue(999)

    const result = await fetchMergeRequestsUpdate()

    expect(result.newComments.map((m) => m.id)).toEqual([1])
  })

  it('falls back to local seen-tracking for plain (non-resolvable) comments, skipping system notes and own notes', async () => {
    const freshPlainComment = mr({ id: 1 })
    const alreadySeenPlainComment = mr({ id: 2 })
    const onlySystemNotes = mr({ id: 3 })
    const onlyOwnComment = mr({ id: 4 })

    vi.mocked(client.fetchReviewerMergeRequests).mockResolvedValue([
      freshPlainComment,
      alreadySeenPlainComment,
      onlySystemNotes,
      onlyOwnComment
    ])

    vi.mocked(client.fetchMergeRequestDiscussions).mockImplementation(
      async (_url, _token, _projectId, iid) => {
        const discussionsByIid: Record<number, GitLabDiscussion[]> = {
          1: [discussionOf(note({ id: 30 }))],
          2: [discussionOf(note({ id: 40 }))],
          3: [discussionOf(note({ id: 50, system: true }))],
          4: [discussionOf(note({ id: 60, author: { username: CURRENT_USER } }))]
        }
        return discussionsByIid[iid] ?? []
      }
    )

    vi.mocked(storage.getLastSeenNoteId).mockImplementation(async (mergeRequestId: number) =>
      mergeRequestId === 2 ? 40 : undefined
    )

    const result = await fetchMergeRequestsUpdate()

    expect(result.newComments.map((m) => m.id)).toEqual([1])
  })
})

describe('isNoteNewerThanLastSeen', () => {
  it('treats any note as new when nothing has been seen yet', () => {
    expect(isNoteNewerThanLastSeen(10, undefined)).toBe(true)
  })

  it('is true only when the note id is strictly greater than the last seen one', () => {
    expect(isNoteNewerThanLastSeen(11, 10)).toBe(true)
    expect(isNoteNewerThanLastSeen(10, 10)).toBe(false)
    expect(isNoteNewerThanLastSeen(9, 10)).toBe(false)
  })
})

describe('getActionableMergeRequests / countActionableMergeRequests', () => {
  function summary(overrides: Partial<MergeRequestSummary> & { id: number }): MergeRequestSummary {
    return {
      iid: overrides.id,
      projectId: 10,
      title: `MR ${overrides.id}`,
      webUrl: `https://gitlab.example.com/group/project/-/merge_requests/${overrides.id}`,
      projectPath: 'group/project',
      authorUsername: 'author-user',
      updatedAt: '2026-01-01T00:00:00Z',
      hasNewComment: false,
      qaPending: false,
      qaApproved: false,
      approvalsRemaining: 0,
      hasConflicts: false,
      ...overrides
    }
  }

  it('dedupes MRs shared across lists and excludes "awaiting review" MRs (waiting on others, not on the user)', () => {
    const sharedBetweenReviewAndComments = summary({ id: 1 })
    const result: MergeRequestsResult = {
      reviewRequested: [sharedBetweenReviewAndComments],
      newComments: [sharedBetweenReviewAndComments, summary({ id: 2 })],
      approved: [],
      readyToMerge: [summary({ id: 3 })],
      awaitingReview: [summary({ id: 4 })]
    }

    expect(countActionableMergeRequests(result)).toBe(3)
    expect(
      getActionableMergeRequests(result)
        .map((m) => m.id)
        .sort()
    ).toEqual([1, 2, 3])
  })
})
