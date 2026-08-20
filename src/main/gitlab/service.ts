import {
  fetchApprovedByMeMergeRequests,
  fetchAssigneeMergeRequests,
  fetchAuthenticatedUsername,
  fetchAuthorMergeRequests,
  fetchMergeRequestApprovals,
  fetchMergeRequestDiscussions,
  fetchReviewerMergeRequests,
  type GitLabMergeRequest,
  type GitLabNote
} from './client'
import {
  getCachedUsername,
  getLastSeenNoteId,
  loadCredentials,
  setCachedUsername,
  setLastSeenNoteId
} from './storage'
import type { MergeRequestSummary, MergeRequestsResult } from './types'

/**
 * In-memory cache of the latest known note per merge request, refreshed on
 * every poll. `markSeen` reads from here rather than re-hitting the API, so
 * clicking a row is instant and doesn't cost an extra request.
 */
const latestNoteCache = new Map<number, { projectId: number; iid: number; latestNoteId: number }>()

function projectPathFromMr(mr: GitLabMergeRequest): string {
  const full = mr.references?.full
  if (full) {
    // e.g. "my-group/my-project!123" -> "my-group/my-project"
    const withoutSuffix = full.replace(/!\d+$/, '')
    if (withoutSuffix) return withoutSuffix
  }
  // Fallback: derive from the web URL if `references` was ever absent.
  const match = mr.web_url.match(/^https?:\/\/[^/]+\/(.+)\/-\/merge_requests\/\d+$/)
  return match ? match[1] : ''
}

function toSummary(
  mr: GitLabMergeRequest,
  hasNewComment: boolean,
  approvalsRemaining = 0
): MergeRequestSummary {
  return {
    id: mr.id,
    iid: mr.iid,
    projectId: mr.project_id,
    title: mr.title,
    webUrl: mr.web_url,
    projectPath: projectPathFromMr(mr),
    authorUsername: mr.author.username,
    updatedAt: mr.updated_at,
    hasNewComment,
    qaPending: mr.labels?.includes('qa_pending') ?? false,
    qaApproved: mr.labels?.includes('qa_approved') ?? false,
    approvalsRemaining,
    hasConflicts: mr.has_conflicts ?? false
  }
}

/**
 * A note is "new" relative to what the user last acknowledged when either
 * nothing has been acknowledged yet (`lastSeenNoteId` is `undefined`) or the
 * fetched note id is strictly greater than the last-seen one. GitLab note
 * ids are global, monotonically increasing integers, so a plain numeric
 * comparison is safe — no per-MR sequence to worry about.
 */
export function isNoteNewerThanLastSeen(
  latestNoteId: number,
  lastSeenNoteId: number | undefined
): boolean {
  return lastSeenNoteId === undefined || latestNoteId > lastSeenNoteId
}

async function resolveUsername(instanceUrl: string, token: string): Promise<string> {
  const cached = await getCachedUsername()
  if (cached) return cached

  const username = await fetchAuthenticatedUsername(instanceUrl, token)
  await setCachedUsername(username)
  return username
}

function dedupeById(mrs: GitLabMergeRequest[][]): GitLabMergeRequest[] {
  const byId = new Map<number, GitLabMergeRequest>()
  for (const list of mrs) {
    for (const mr of list) {
      byId.set(mr.id, mr)
    }
  }
  return [...byId.values()]
}

export async function fetchMergeRequestsUpdate(): Promise<MergeRequestsResult> {
  const credentials = await loadCredentials()
  if (!credentials) {
    throw new Error('No GitLab credentials configured yet.')
  }
  const { instanceUrl, token } = credentials

  const username = await resolveUsername(instanceUrl, token)

  const [reviewerMrs, authorMrs, approvedMrs, assigneeMrs] = await Promise.all([
    fetchReviewerMergeRequests(instanceUrl, token, username),
    fetchAuthorMergeRequests(instanceUrl, token, username),
    fetchApprovedByMeMergeRequests(instanceUrl, token, username),
    fetchAssigneeMergeRequests(instanceUrl, token, username)
  ])

  // MRs already approved by the user are surfaced in the "approved" list
  // instead, so they must not also linger in "to review". Dedupe by `id`
  // (globally unique) rather than `iid` (only unique within a project).
  const approvedIds = new Set(approvedMrs.map((mr) => mr.id))
  const reviewRequested = reviewerMrs
    .filter((mr) => !approvedIds.has(mr.id))
    .map((mr) => toSummary(mr, false))

  // "Approved" is a plain reference list of open MRs the user has already
  // approved — no comment-diffing/"seen" logic applies to it.
  const approved = approvedMrs.map((mr) => toSummary(mr, false))

  // "New comments" candidates: everything the user is either reviewing or
  // authoring, deduped by MR id (a user could be both on the same MR).
  // Already-approved MRs are excluded here too, for the same reason as
  // `reviewRequested` above — they belong in "approved" only.
  const candidateMrs = dedupeById([reviewerMrs, authorMrs]).filter((mr) => !approvedIds.has(mr.id))

  const newCommentsResults = await Promise.all(
    candidateMrs.map(async (mr) => {
      // The entire per-MR check is wrapped so that one MR's discussions
      // failing to load, or having unexpected shape (e.g. a null `author`),
      // just excludes that MR from `newComments` this cycle instead of
      // rejecting the whole `Promise.all` and sinking the batch (including
      // the already-fetched `reviewRequested` list).
      try {
        const discussions = await fetchMergeRequestDiscussions(
          instanceUrl,
          token,
          mr.project_id,
          mr.iid
        )

        const actionableNotes = discussions
          .flatMap((discussion) => discussion.notes)
          .filter((note) => !note.system && note.author?.username !== username)

        // GitLab is the source of truth for review threads: a resolvable
        // note (a diff/review comment) only counts while its thread is
        // still unresolved — resolving it in GitLab itself (any client)
        // clears it here too, no local "seen" tracking needed.
        const hasUnresolvedThread = actionableNotes.some(
          (note) => note.resolvable && !note.resolved
        )

        // Plain top-level comments are never resolvable, so GitLab has no
        // "done with this" signal for them — fall back to the local
        // last-seen-id tracking (cleared by clicking the row in the app).
        const latestNonResolvable = actionableNotes
          .filter((note) => !note.resolvable)
          .sort((a: GitLabNote, b: GitLabNote) => b.id - a.id)[0]

        if (latestNonResolvable) {
          latestNoteCache.set(mr.id, {
            projectId: mr.project_id,
            iid: mr.iid,
            latestNoteId: latestNonResolvable.id
          })
        }

        if (hasUnresolvedThread) return toSummary(mr, true)
        if (!latestNonResolvable) return null

        const lastSeenNoteId = await getLastSeenNoteId(mr.id)
        if (!isNoteNewerThanLastSeen(latestNonResolvable.id, lastSeenNoteId)) return null

        return toSummary(mr, true)
      } catch (error) {
        console.warn(`gitlab: failed to check discussions for MR ${mr.id}`, error)
        return null
      }
    })
  )

  const newComments = newCommentsResults.filter(
    (summary): summary is MergeRequestSummary => summary !== null
  )

  // Every MR the user is assigned to is split into two buckets: fully ready
  // to merge, or everything else. Unlike `newComments` above, an MR here is
  // never dropped on a per-MR failure (approvals fetch erroring, zero
  // approvals so far, etc.) — it just falls back to "awaiting review" instead
  // of vanishing from the app entirely. An MR assigned today with no
  // approvals and no comments yet must still be visible somewhere.
  const REQUIRED_APPROVALS = 2
  const assigneeResults = await Promise.all(
    assigneeMrs.map(async (mr) => {
      let othersApprovedCount = 0
      try {
        const approvals = await fetchMergeRequestApprovals(
          instanceUrl,
          token,
          mr.project_id,
          mr.iid
        )
        othersApprovedCount = approvals.approved_by.filter(
          (entry) => entry.user.username !== username
        ).length
      } catch (error) {
        console.warn(`gitlab: failed to check approvals for MR ${mr.id}`, error)
      }

      const approvalsRemaining = Math.max(REQUIRED_APPROVALS - othersApprovedCount, 0)
      const summary = toSummary(mr, false, approvalsRemaining)
      // Ready to merge requires BOTH signals: code review fully approved
      // *and* QA has signed off (the `qa_approved` label). Either one alone
      // just means the MR moves to (or stays in) "awaiting review".
      const isReadyToMerge = approvalsRemaining === 0 && summary.qaApproved
      return { summary, isReadyToMerge }
    })
  )

  const readyToMerge: MergeRequestSummary[] = []
  const awaitingReview: MergeRequestSummary[] = []
  for (const { summary, isReadyToMerge } of assigneeResults) {
    ;(isReadyToMerge ? readyToMerge : awaitingReview).push(summary)
  }

  return { reviewRequested, newComments, approved, readyToMerge, awaitingReview }
}

/**
 * Marks a merge request's latest known comment as seen, persisting it so the
 * "new comments" badge doesn't reappear until an actually newer note arrives.
 * No-ops if we have no cached note info for this MR (e.g. it wasn't part of
 * the last poll result).
 */
export async function markMergeRequestSeen(mergeRequestId: number): Promise<void> {
  const cached = latestNoteCache.get(mergeRequestId)
  if (!cached) return
  await setLastSeenNoteId(mergeRequestId, cached.latestNoteId)
}

/**
 * Clears the in-memory "latest note" cache. Used on log-out so a previously
 * connected account's cached MR bookkeeping can't leak into a newly
 * connected one — MR ids aren't guaranteed unique across different GitLab
 * instances.
 */
export function clearLatestNoteCache(): void {
  latestNoteCache.clear()
}

/**
 * MRs that need the user's attention right now: awaiting their review, with
 * an unread comment, or their own MR that's already fully approved and ready
 * to merge. Deliberately excludes `awaitingReview` — those are the user's
 * own MRs waiting on *other people* to act, not on the user. Deduped by id,
 * since the same MR can land in more than one of the source lists (e.g. a
 * reviewer MR that also picked up a new comment).
 */
export function getActionableMergeRequests(result: MergeRequestsResult): MergeRequestSummary[] {
  const byId = new Map<number, MergeRequestSummary>()
  for (const mr of [...result.reviewRequested, ...result.newComments, ...result.readyToMerge]) {
    byId.set(mr.id, mr)
  }
  return [...byId.values()]
}

export function countActionableMergeRequests(result: MergeRequestsResult): number {
  return getActionableMergeRequests(result).length
}
