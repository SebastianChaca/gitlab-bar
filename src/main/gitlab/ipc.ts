import { BrowserWindow, ipcMain, shell } from 'electron'
import { clearLatestNoteCache, fetchMergeRequestsUpdate, markMergeRequestSeen } from './service'
import { clearCredentials, hasCredentials, loadCredentials, saveCredentials } from './storage'
import type { GitLabCredentialsInput, MergeRequestsUpdatePayload } from './types'

const POLL_INTERVAL_MS = 60 * 1000
export const MERGE_REQUESTS_UPDATE_CHANNEL = 'gitlab:merge-requests-update'
export const LOGGED_OUT_CHANNEL = 'gitlab:logged-out'

let pollTimer: ReturnType<typeof setInterval> | null = null

async function buildUpdatePayload(): Promise<MergeRequestsUpdatePayload> {
  try {
    const data = await fetchMergeRequestsUpdate()
    return { status: 'ok', data, fetchedAt: new Date().toISOString() }
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error fetching merge requests.',
      fetchedAt: new Date().toISOString()
    }
  }
}

async function pushUpdate(getWindow: () => BrowserWindow | null): Promise<void> {
  const payload = await buildUpdatePayload()
  const window = getWindow()
  if (!window || window.isDestroyed()) return
  window.webContents.send(MERGE_REQUESTS_UPDATE_CHANNEL, payload)
}

/** Registers all `gitlab:*` IPC handlers. Call once, before the window loads. */
export function registerGitLabIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('gitlab:has-credentials', () => hasCredentials())

  ipcMain.handle('gitlab:save-credentials', async (_event, input: GitLabCredentialsInput) => {
    await saveCredentials(input.instanceUrl, input.token)
    // Restart polling (a prior log-out may have stopped it) and refresh right
    // away so the UI doesn't have to wait for the next poll tick.
    startGitLabPolling(getWindow)
  })

  ipcMain.handle('gitlab:get-merge-requests', () => fetchMergeRequestsUpdate())

  ipcMain.handle('gitlab:mark-merge-request-seen', (_event, mergeRequestId: number) =>
    markMergeRequestSeen(mergeRequestId)
  )

  ipcMain.handle('gitlab:open-merge-request', async (_event, url: string) => {
    // `url` comes from server-supplied MR data (`webUrl`), so it's untrusted
    // input. Only allow http(s) URLs whose origin matches the configured
    // GitLab instance — never blindly hand it to the OS shell.
    const credentials = await loadCredentials()
    if (!credentials) {
      console.warn('gitlab: refusing to open MR URL, no credentials configured:', url)
      return
    }

    let target: URL
    let instance: URL
    try {
      target = new URL(url)
      instance = new URL(credentials.instanceUrl)
    } catch {
      console.warn('gitlab: refusing to open malformed MR URL:', url)
      return
    }

    const isHttp = target.protocol === 'http:' || target.protocol === 'https:'
    if (!isHttp || target.origin !== instance.origin) {
      console.warn('gitlab: refusing to open MR URL with untrusted origin:', url)
      return
    }

    await shell.openExternal(url)
  })
}

/** Starts polling GitLab: once immediately, then on a fixed interval. */
export function startGitLabPolling(getWindow: () => BrowserWindow | null): void {
  void pushUpdate(getWindow)

  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    void pushUpdate(getWindow)
  }, POLL_INTERVAL_MS)
}

/**
 * Stops the background poll loop. Used on log-out so a stale poll tick can't
 * push a spurious "error" payload (no credentials configured) a few minutes
 * later, which would otherwise overwrite the "needs credentials" view.
 */
function stopGitLabPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/**
 * Full log-out: clears on-disk credentials + MR-seen state, clears the
 * in-memory "latest note" cache, stops the background poll loop, and tells
 * the renderer to fall back to the credentials form.
 */
export async function logOutOfGitLab(getWindow: () => BrowserWindow | null): Promise<void> {
  await clearCredentials()
  clearLatestNoteCache()
  stopGitLabPolling()

  const window = getWindow()
  if (!window || window.isDestroyed()) return
  window.webContents.send(LOGGED_OUT_CHANNEL)
}
