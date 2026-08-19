import { contextBridge, ipcRenderer } from 'electron'
import type {
  GitLabCredentialsInput,
  MergeRequestsResult,
  MergeRequestsUpdatePayload
} from '../main/gitlab/types'

// Secure IPC bridge for the GitLab integration. All GitLab API calls and
// token handling happen in the main process — this surface only relays
// requests/results, it never touches the raw token itself.
const api = {
  hasCredentials: (): Promise<boolean> => ipcRenderer.invoke('gitlab:has-credentials'),

  saveCredentials: (input: GitLabCredentialsInput): Promise<void> =>
    ipcRenderer.invoke('gitlab:save-credentials', input),

  getMergeRequests: (): Promise<MergeRequestsResult> =>
    ipcRenderer.invoke('gitlab:get-merge-requests'),

  markMergeRequestSeen: (mergeRequestId: number): Promise<void> =>
    ipcRenderer.invoke('gitlab:mark-merge-request-seen', mergeRequestId),

  openMergeRequest: (url: string): Promise<void> =>
    ipcRenderer.invoke('gitlab:open-merge-request', url),

  /** Subscribes to periodic poll results pushed from main. Returns an unsubscribe function. */
  onMergeRequestsUpdate: (
    callback: (payload: MergeRequestsUpdatePayload) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: MergeRequestsUpdatePayload
    ): void => callback(payload)
    // Intentionally hardcoded rather than importing `MERGE_REQUESTS_UPDATE_CHANNEL`
    // from `main/gitlab/ipc.ts`: that module transitively imports storage.ts/
    // client.ts, which use Node builtins (`fs`, `path`) and Electron main-only
    // APIs (`app`, `safeStorage`). Bundling that into this now-sandboxed
    // preload script (see `sandbox: true` in main/index.ts) is an avoidable
    // risk for reusing one string constant. Keep this in sync manually.
    ipcRenderer.on('gitlab:merge-requests-update', listener)
    return () => ipcRenderer.removeListener('gitlab:merge-requests-update', listener)
  },

  /** Subscribes to the tray "Log out" event. Returns an unsubscribe function. */
  onLoggedOut: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    // Same hardcoding rationale as `onMergeRequestsUpdate` above: avoid
    // pulling main/gitlab/ipc.ts (and its Node/Electron-main-only transitive
    // deps) into this sandboxed preload script just to reuse one string.
    ipcRenderer.on('gitlab:logged-out', listener)
    return () => ipcRenderer.removeListener('gitlab:logged-out', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts) - fallback path, not expected to run since
  // contextIsolation is always enabled in this app.
  window.api = api
}

export type GitLabBarApi = typeof api
