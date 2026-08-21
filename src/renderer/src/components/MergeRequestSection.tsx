import type { MergeRequestSummary } from '../../../main/gitlab/types'
import { MergeRequestRow } from './MergeRequestRow'

/** Groups MRs from the same project together, without splitting the section
 *  into per-project sub-lists — just a stable sort by `projectPath`. */
function sortByProject(items: MergeRequestSummary[]): MergeRequestSummary[] {
  return [...items].sort((a, b) => a.projectPath.localeCompare(b.projectPath))
}

export function MergeRequestSection({
  title,
  items,
  showQaApprovedBadge = false
}: {
  title: string
  items: MergeRequestSummary[]
  showQaApprovedBadge?: boolean
}): React.JSX.Element {
  return (
    <section className="mr-section">
      <h2 style={{ marginLeft: '5px' }}>{title}</h2>
      {items.length === 0 ? (
        <p className="empty-text">Nothing here.</p>
      ) : (
        <ul className="mr-list">
          {sortByProject(items).map((mr) => (
            <MergeRequestRow key={mr.id} mr={mr} showQaApprovedBadge={showQaApprovedBadge} />
          ))}
        </ul>
      )}
    </section>
  )
}
