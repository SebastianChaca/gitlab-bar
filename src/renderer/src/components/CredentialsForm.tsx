import { useState } from 'react'

const GITLAB_INSTANCE_URL = 'https://gitlab.com'

export function CredentialsForm({ onSaved }: { onSaved: () => void }): React.JSX.Element {
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
