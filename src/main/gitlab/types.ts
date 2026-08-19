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
}

export interface MergeRequestsResult {
  reviewRequested: MergeRequestSummary[]
  newComments: MergeRequestSummary[]
  approved: MergeRequestSummary[]
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
