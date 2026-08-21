import type { MergeRequestSummary } from '../../../main/gitlab/types'
import { CheckCircleIcon, ClockIcon, ConflictIcon } from './icons'

/** "my-group/my-subgroup/my-project" -> "my-project" — the project name is
 *  what tells you at a glance which codebase an MR belongs to; the group
 *  path in front is rarely needed and eats space in a 280px popup. The full
 *  path is still available via the `title` tooltip on hover. */
function projectName(projectPath: string): string {
  const segments = projectPath.split('/')
  return segments[segments.length - 1] || projectPath
}

export function MergeRequestRow({
  mr,
  showQaApprovedBadge = false
}: {
  mr: MergeRequestSummary
  /** `qaApproved` is computed for every MR (same as `qaPending`), but we only
   *  want the green badge in "Awaiting Review" — showing it in "To Review" or
   *  "New Comments" too would be noise unrelated to why that MR is there. */
  showQaApprovedBadge?: boolean
}): React.JSX.Element {
  async function handleClick(): Promise<void> {
    await window.api.openMergeRequest(mr.webUrl)
    if (mr.hasNewComment) {
      await window.api.markMergeRequestSeen(mr.id)
    }
  }

  return (
    <li className="mr-row" onClick={handleClick}>
      <div className="mr-row-text">
        <span className="mr-title">{mr.title}</span>
        <div className="mr-row-meta">
          <span className="mr-project" title={mr.projectPath}>
            {projectName(mr.projectPath)}
          </span>
          {mr.hasConflicts && (
            <span
              className="mr-badge mr-badge-danger mr-badge-icon"
              data-tooltip="Merge conflicts"
              aria-label="Merge conflicts"
            >
              <ConflictIcon />
            </span>
          )}
          {mr.qaPending && (
            <span
              className="mr-badge mr-badge-icon"
              data-tooltip="QA pending"
              aria-label="QA pending"
            >
              <ClockIcon />
            </span>
          )}
          {showQaApprovedBadge && mr.qaApproved && (
            <span
              className="mr-badge mr-badge-success mr-badge-icon"
              data-tooltip="QA approved"
              aria-label="QA approved"
            >
              <ClockIcon />
            </span>
          )}
          {mr.approvalsRemaining > 0 && (
            <span
              className="mr-badge mr-badge-info mr-badge-icon"
              data-tooltip={`${mr.approvalsRemaining} approval${mr.approvalsRemaining > 1 ? 's' : ''} needed`}
              aria-label={`Needs ${mr.approvalsRemaining} more approval${mr.approvalsRemaining > 1 ? 's' : ''}`}
            >
              <CheckCircleIcon />
              {mr.approvalsRemaining}
            </span>
          )}
        </div>
      </div>
    </li>
  )
}
