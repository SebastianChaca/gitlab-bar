import { useEffect, useState } from 'react'
import type { MergeRequestSummary, MergeRequestsResult } from '../../main/gitlab/types'

type ViewState =
  | { kind: 'checking' }
  | { kind: 'needs-credentials' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: MergeRequestsResult }
  | { kind: 'error'; message: string }

const GITLAB_INSTANCE_URL = 'https://gitlab.com'

function CredentialsForm({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!token.trim()) return

    setSubmitting(true)
    setError(null)
    try {
      await window.api.saveCredentials({ instanceUrl: GITLAB_INSTANCE_URL, token: token.trim() })
      onSaved()
    } catch (err) {
      const detail = err instanceof Error ? err.message : undefined
      setError(
        detail
          ? `Could not save credentials: ${detail}`
          : 'Could not save credentials. Please try again.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="credentials-form" onSubmit={handleSubmit}>
      <h1>Connect GitLab</h1>
      <label>
        Personal access token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="read_api scope"
          autoFocus
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  )
}

function MergeRequestRow({ mr }: { mr: MergeRequestSummary }): React.JSX.Element {
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
          <span className="mr-project">{mr.projectPath}</span>
          {mr.hasConflicts && (
            <span className="mr-badge mr-badge-danger" title="Has merge conflicts">
              MC
            </span>
          )}
          {mr.qaPending && (
            <span className="mr-badge" title="Carries the qa_pending label">
              QA
            </span>
          )}
          {mr.approvalsRemaining > 0 && (
            <span className="mr-badge mr-badge-info">
              Needs {mr.approvalsRemaining} approval{mr.approvalsRemaining > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
    </li>
  )
}

function MergeRequestSection({
  title,
  items
}: {
  title: string
  items: MergeRequestSummary[]
}): React.JSX.Element {
  return (
    <section className="mr-section">
      <h2 style={{ marginLeft: '5px' }}>{title}</h2>
      {items.length === 0 ? (
        <p className="empty-text">Nothing here.</p>
      ) : (
        <ul className="mr-list">
          {items.map((mr) => (
            <MergeRequestRow key={mr.id} mr={mr} />
          ))}
        </ul>
      )}
    </section>
  )
}

function App(): React.JSX.Element {
  const [view, setView] = useState<ViewState>({ kind: 'checking' })

  useEffect(() => {
    let cancelled = false

    async function bootstrap(): Promise<void> {
      const hasCredentials = await window.api.hasCredentials()
      if (cancelled) return

      if (!hasCredentials) {
        setView({ kind: 'needs-credentials' })
        return
      }

      setView({ kind: 'loading' })
      try {
        const data = await window.api.getMergeRequests()
        if (!cancelled) setView({ kind: 'ready', data })
      } catch (error) {
        if (!cancelled) {
          setView({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Invalid token or network error.'
          })
        }
      }
    }

    void bootstrap()

    const unsubscribe = window.api.onMergeRequestsUpdate((payload) => {
      if (cancelled) return
      if (payload.status === 'ok' && payload.data) {
        setView({ kind: 'ready', data: payload.data })
      } else if (payload.status === 'error') {
        setView({ kind: 'error', message: payload.error ?? 'Invalid token or network error.' })
      }
    })

    const unsubscribeLoggedOut = window.api.onLoggedOut(() => {
      if (cancelled) return
      setView({ kind: 'needs-credentials' })
    })

    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeLoggedOut()
    }
  }, [])

  if (view.kind === 'checking' || view.kind === 'loading') {
    return (
      <div className="app-shell centered">
        <p className="loading-text">Loading…</p>
      </div>
    )
  }

  if (view.kind === 'needs-credentials') {
    return (
      <div className="app-shell centered">
        <CredentialsForm onSaved={() => setView({ kind: 'loading' })} />
      </div>
    )
  }

  if (view.kind === 'error') {
    return (
      <div className="app-shell centered">
        <p className="error-text">{view.message}</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <MergeRequestSection title="To Review" items={view.data.reviewRequested} />
      <MergeRequestSection title="New Comments" items={view.data.newComments} />
      {view.data.approved.length > 0 && (
        <MergeRequestSection title="Approved by me" items={view.data.approved} />
      )}
      {view.data.readyToMerge.length > 0 && (
        <MergeRequestSection title="Ready to Merge" items={view.data.readyToMerge} />
      )}
      {view.data.awaitingReview.length > 0 && (
        <MergeRequestSection title="Awaiting Review" items={view.data.awaitingReview} />
      )}
    </div>
  )
}

export default App
