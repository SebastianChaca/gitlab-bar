// Shared types for the GitLab integration. Kept dependency-free so they can
// be safely imported from main, preload, and renderer code.

/** Minimal shape of a GitLab merge request, as surfaced to the renderer. */
export interface MergeRequestSummary {
  id: number
  iid: number
  projectId: number
  title: string
  webUrl: string
  projectPath: string
  authorUsername: string
  updatedAt: string
  /** Present only for MRs in the "new comments" list. */
  hasNewComment: boolean
  /** Whether the MR carries the `qa_pending` GitLab label. */
  qaPending: boolean
  /** Whether the MR carries the `qa_approved` GitLab label. */
  qaApproved: boolean
  /** Meaningful only for MRs the user is assigned to: how many more non-self approvals it still needs (0, 1, or 2). */
  approvalsRemaining: number
  /** Whether GitLab reports merge conflicts (`has_conflicts`). Computed for every MR, shown wherever it's true. */
  hasConflicts: boolean
}

export interface MergeRequestsResult {
  reviewRequested: MergeRequestSummary[]
  newComments: MergeRequestSummary[]
  approved: MergeRequestSummary[]
  /** MRs the user is assigned to, fully approved (2+ non-self approvals) AND qa_approved. */
  readyToMerge: MergeRequestSummary[]
  /** MRs the user is assigned to that aren't in `readyToMerge` yet — includes ones with zero approvals so far. */
  awaitingReview: MergeRequestSummary[]
}

export interface GitLabCredentialsInput {
  instanceUrl: string
  token: string
}

/** Pushed from main to renderer whenever a poll cycle finishes (success or failure). */
export interface MergeRequestsUpdatePayload {
  status: 'ok' | 'error'
  data?: MergeRequestsResult
  error?: string
  fetchedAt: string
}
