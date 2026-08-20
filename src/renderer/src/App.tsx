import { useEffect, useState } from 'react'
import type { MergeRequestsResult } from '../../main/gitlab/types'
import { CredentialsForm } from './components/CredentialsForm'
import { MergeRequestSection } from './components/MergeRequestSection'

type ViewState =
  | { kind: 'checking' }
  | { kind: 'needs-credentials' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: MergeRequestsResult }
  | { kind: 'error'; message: string }

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
