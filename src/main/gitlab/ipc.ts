import { BrowserWindow, ipcMain, Notification, shell, Tray } from 'electron'
import {
  clearLatestNoteCache,
  countActionableMergeRequests,
  fetchMergeRequestsUpdate,
  getActionableMergeRequests,
  markMergeRequestSeen
} from './service'
import { clearCredentials, hasCredentials, loadCredentials, saveCredentials } from './storage'
import type {
  GitLabCredentialsInput,
  MergeRequestsResult,
  MergeRequestsUpdatePayload
} from './types'

const POLL_INTERVAL_MS = 60 * 1000
export const MERGE_REQUESTS_UPDATE_CHANNEL = 'gitlab:merge-requests-update'
export const LOGGED_OUT_CHANNEL = 'gitlab:logged-out'

let pollTimer: ReturnType<typeof setInterval> | null = null

/**
 * Ids of MRs that were actionable as of the previous poll — `null` until the
 * first poll of this run completes. Used to notify only on genuinely new
 * arrivals, and to not fire a burst of notifications for everything that was
 * already pending when the app (re)started or the user logged back in.
 */
let previousActionableIds: Set<number> | null = null

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

/**
 * `url` comes from server-supplied MR data (`webUrl`), so it's untrusted
 * input. Only allow http(s) URLs whose origin matches the configured GitLab
 * instance — never blindly hand it to the OS shell. Shared by the
 * "open merge request" IPC handler and notification-click handling below.
 */
async function openMergeRequestUrl(url: string): Promise<void> {
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
}

/**
 * Fires a native notification for MRs that became actionable since the last
 * poll. A single new MR gets its title in the notification body; several at
 * once are collapsed into one summary notification instead of a burst.
 */
function notifyNewlyActionable(data: MergeRequestsResult): void {
  if (!Notification.isSupported()) return

  const actionable = getActionableMergeRequests(data)
  const currentIds = new Set(actionable.map((mr) => mr.id))

  if (previousActionableIds) {
    const newItems = actionable.filter((mr) => !previousActionableIds!.has(mr.id))

    if (newItems.length === 1) {
      const [mr] = newItems
      const notification = new Notification({ title: 'GitLab Bar', body: mr.title })
      notification.on('click', () => void openMergeRequestUrl(mr.webUrl))
      notification.show()
    } else if (newItems.length > 1) {
      new Notification({
        title: 'GitLab Bar',
        body: `${newItems.length} merge requests need your attention.`
      }).show()
    }
  }

  previousActionableIds = currentIds
}

/** macOS-only: shows the actionable count as text next to the tray icon. */
function updateTrayTitle(tray: Tray | null, data: MergeRequestsResult): void {
  if (!tray || process.platform !== 'darwin') return
  const count = countActionableMergeRequests(data)
  tray.setTitle(count > 0 ? String(count) : '')
}

async function pushUpdate(
  getWindow: () => BrowserWindow | null,
  getTray: () => Tray | null
): Promise<void> {
  const payload = await buildUpdatePayload()

  if (payload.status === 'ok' && payload.data) {
    updateTrayTitle(getTray(), payload.data)
    notifyNewlyActionable(payload.data)
  }

  const window = getWindow()
  if (!window || window.isDestroyed()) return
  window.webContents.send(MERGE_REQUESTS_UPDATE_CHANNEL, payload)
}

/** Registers all `gitlab:*` IPC handlers. Call once, before the window loads. */
export function registerGitLabIpcHandlers(
  getWindow: () => BrowserWindow | null,
  getTray: () => Tray | null
): void {
  ipcMain.handle('gitlab:has-credentials', () => hasCredentials())

  ipcMain.handle('gitlab:save-credentials', async (_event, input: GitLabCredentialsInput) => {
    await saveCredentials(input.instanceUrl, input.token)
    // Restart polling (a prior log-out may have stopped it) and refresh right
    // away so the UI doesn't have to wait for the next poll tick.
    startGitLabPolling(getWindow, getTray)
  })

  ipcMain.handle('gitlab:get-merge-requests', () => fetchMergeRequestsUpdate())

  ipcMain.handle('gitlab:mark-merge-request-seen', (_event, mergeRequestId: number) =>
    markMergeRequestSeen(mergeRequestId)
  )

  ipcMain.handle('gitlab:open-merge-request', (_event, url: string) => openMergeRequestUrl(url))
}

/** Starts polling GitLab: once immediately, then on a fixed interval. */
export function startGitLabPolling(
  getWindow: () => BrowserWindow | null,
  getTray: () => Tray | null
): void {
  void pushUpdate(getWindow, getTray)

  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    void pushUpdate(getWindow, getTray)
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
 * in-memory "latest note" and "previously actionable" caches, stops the
 * background poll loop, resets the tray title, and tells the renderer to
 * fall back to the credentials form.
 */
export async function logOutOfGitLab(
  getWindow: () => BrowserWindow | null,
  getTray: () => Tray | null
): Promise<void> {
  await clearCredentials()
  clearLatestNoteCache()
  stopGitLabPolling()
  previousActionableIds = null
  if (process.platform === 'darwin') getTray()?.setTitle('')

  const window = getWindow()
  if (!window || window.isDestroyed()) return
  window.webContents.send(LOGGED_OUT_CHANNEL)
}
