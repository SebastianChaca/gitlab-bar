// Thin GitLab REST (v4) client. Plain `fetch` only — Node 22 provides it
// globally, no HTTP dependency needed. Runs exclusively in the main process;
// the token never leaves this module's callers (also main-process only).

interface GitLabUser {
  username: string
}

export interface GitLabMergeRequest {
  id: number
  iid: number
  project_id: number
  title: string
  web_url: string
  author: { username: string }
  updated_at: string
  references?: { full?: string }
  labels?: string[]
  has_conflicts?: boolean
}

export interface GitLabApprovals {
  approved_by: { user: { username: string } }[]
}

export interface GitLabNote {
  id: number
  system: boolean
  // Nullable: GitLab omits/nulls this for notes from deleted users or some
  // service accounts, so callers must not assume it's always present.
  author: { username: string } | null
  // Only diff/review-thread comments are resolvable — plain top-level MR
  // comments always come back with `resolvable: false` and never carry a
  // meaningful `resolved` value.
  resolvable: boolean
  resolved: boolean
}

export interface GitLabDiscussion {
  id: string
  individual_note: boolean
  notes: GitLabNote[]
}

export class GitLabApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'GitLabApiError'
  }
}

function apiBase(instanceUrl: string): string {
  return `${instanceUrl.replace(/\/+$/, '')}/api/v4`
}

async function gitlabFetch<T>(instanceUrl: string, token: string, path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase(instanceUrl)}${path}`, {
      headers: { 'PRIVATE-TOKEN': token }
    })
  } catch {
    throw new GitLabApiError('Network error while contacting GitLab.')
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new GitLabApiError('Invalid or expired GitLab token.', 401)
    }
    throw new GitLabApiError(`GitLab API request failed (${response.status}).`, response.status)
  }

  return (await response.json()) as T
}

export async function fetchAuthenticatedUsername(
  instanceUrl: string,
  token: string
): Promise<string> {
  const user = await gitlabFetch<GitLabUser>(instanceUrl, token, '/user')
  return user.username
}

/** Merge requests open, where `username` is requested as reviewer. */
export async function fetchReviewerMergeRequests(
  instanceUrl: string,
  token: string,
  username: string
): Promise<GitLabMergeRequest[]> {
  const query = new URLSearchParams({
    reviewer_username: username,
    state: 'opened',
    scope: 'all',
    per_page: '100',
    with_merge_status_recheck: 'true'
  })
  return gitlabFetch<GitLabMergeRequest[]>(instanceUrl, token, `/merge_requests?${query}`)
}

/** Merge requests open, authored by `username`. */
export async function fetchAuthorMergeRequests(
  instanceUrl: string,
  token: string,
  username: string
): Promise<GitLabMergeRequest[]> {
  const query = new URLSearchParams({
    author_username: username,
    state: 'opened',
    scope: 'all',
    per_page: '100',
    with_merge_status_recheck: 'true'
  })
  return gitlabFetch<GitLabMergeRequest[]>(instanceUrl, token, `/merge_requests?${query}`)
}

/** Merge requests open, where `username` is assignee. */
export async function fetchAssigneeMergeRequests(
  instanceUrl: string,
  token: string,
  username: string
): Promise<GitLabMergeRequest[]> {
  const query = new URLSearchParams({
    assignee_username: username,
    state: 'opened',
    scope: 'all',
    per_page: '100',
    with_merge_status_recheck: 'true'
  })
  return gitlabFetch<GitLabMergeRequest[]>(instanceUrl, token, `/merge_requests?${query}`)
}

/** Merge requests open, approved by `username`. */
export async function fetchApprovedByMeMergeRequests(
  instanceUrl: string,
  token: string,
  username: string
): Promise<GitLabMergeRequest[]> {
  const query = new URLSearchParams({
    'approved_by_usernames[]': username,
    state: 'opened',
    scope: 'all',
    per_page: '100',
    with_merge_status_recheck: 'true'
  })
  return gitlabFetch<GitLabMergeRequest[]>(instanceUrl, token, `/merge_requests?${query}`)
}

/** Approval state of a single merge request, including who has approved it. */
export async function fetchMergeRequestApprovals(
  instanceUrl: string,
  token: string,
  projectId: number,
  iid: number
): Promise<GitLabApprovals> {
  return gitlabFetch<GitLabApprovals>(
    instanceUrl,
    token,
    `/projects/${projectId}/merge_requests/${iid}/approvals`
  )
}

/**
 * All discussion threads on a merge request, each with its notes and their
 * `resolvable`/`resolved` state. Unlike the flat `/notes` endpoint, this is
 * the only way to know whether a review comment's thread has actually been
 * resolved in GitLab.
 */
export async function fetchMergeRequestDiscussions(
  instanceUrl: string,
  token: string,
  projectId: number,
  iid: number,
  perPage = 100
): Promise<GitLabDiscussion[]> {
  const query = new URLSearchParams({ per_page: String(perPage) })
  return gitlabFetch<GitLabDiscussion[]>(
    instanceUrl,
    token,
    `/projects/${projectId}/merge_requests/${iid}/discussions?${query}`
  )
}
