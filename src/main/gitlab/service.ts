import {
  fetchApprovedByMeMergeRequests,
  fetchAuthenticatedUsername,
  fetchAuthorMergeRequests,
  fetchRecentNotes,
  fetchReviewerMergeRequests,
  type GitLabMergeRequest
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

function toSummary(mr: GitLabMergeRequest, hasNewComment: boolean): MergeRequestSummary {
  return {
    id: mr.id,
    iid: mr.iid,
    projectId: mr.project_id,
    title: mr.title,
    webUrl: mr.web_url,
    projectPath: projectPathFromMr(mr),
    authorUsername: mr.author.username,
    updatedAt: mr.updated_at,
    hasNewComment
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

  const [reviewerMrs, authorMrs, approvedMrs] = await Promise.all([
    fetchReviewerMergeRequests(instanceUrl, token, username),
    fetchAuthorMergeRequests(instanceUrl, token, username),
    fetchApprovedByMeMergeRequests(instanceUrl, token, username)
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
  const candidateMrs = dedupeById([reviewerMrs, authorMrs]).filter(
    (mr) => !approvedIds.has(mr.id)
  )

  const newCommentsResults = await Promise.all(
    candidateMrs.map(async (mr) => {
      // The entire per-MR check is wrapped so that one MR's notes failing to
      // load, or having unexpected shape (e.g. a null `author`), just
      // excludes that MR from `newComments` this cycle instead of rejecting
      // the whole `Promise.all` and sinking the batch (including the
      // already-fetched `reviewRequested` list).
      try {
        const recentNotes = await fetchRecentNotes(instanceUrl, token, mr.project_id, mr.iid)

        // Scan newest-first for the first real human comment, skipping over
        // any system notes (pushes, label changes, approvals, etc.) that may
        // sit above it. If none is found within this page, treat it as no
        // new comment rather than paging back further.
        const latestHumanNote = recentNotes.find(
          (note) => !note.system && note.author?.username !== username
        )
        if (!latestHumanNote) return null

        latestNoteCache.set(mr.id, {
          projectId: mr.project_id,
          iid: mr.iid,
          latestNoteId: latestHumanNote.id
        })

        const lastSeenNoteId = await getLastSeenNoteId(mr.id)
        if (!isNoteNewerThanLastSeen(latestHumanNote.id, lastSeenNoteId)) return null

        return toSummary(mr, true)
      } catch (error) {
        console.warn(`gitlab: failed to check notes for MR ${mr.id}`, error)
        return null
      }
    })
  )

  const newComments = newCommentsResults.filter(
    (summary): summary is MergeRequestSummary => summary !== null
  )

  return { reviewRequested, newComments, approved }
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
