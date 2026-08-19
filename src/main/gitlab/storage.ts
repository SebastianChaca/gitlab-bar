import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

interface GitLabConfig {
  instanceUrl: string
  /** Cached after the first successful `GET /user` call, to avoid refetching it every poll. */
  username?: string
}

type MergeRequestNoteState = Record<string, number>

const CREDENTIALS_FILE = 'credentials.enc'
const CONFIG_FILE = 'config.json'
const MR_STATE_FILE = 'mr-state.json'

function credentialsPath(): string {
  return join(app.getPath('userData'), CREDENTIALS_FILE)
}

function configPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE)
}

function mrStatePath(): string {
  return join(app.getPath('userData'), MR_STATE_FILE)
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf-8')
}

export async function hasCredentials(): Promise<boolean> {
  const config = await readJsonFile<GitLabConfig>(configPath())
  if (!config?.instanceUrl) return false

  try {
    await fs.access(credentialsPath())
    return true
  } catch {
    return false
  }
}

export async function saveCredentials(instanceUrl: string, token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is not available on this machine, so the token cannot be stored securely.'
    )
  }

  const encrypted = safeStorage.encryptString(token)
  await fs.writeFile(credentialsPath(), encrypted)

  // Saving new credentials invalidates any previously cached username, and
  // any previously persisted "last seen note" state — MR ids aren't
  // globally unique across GitLab instances/accounts.
  await writeJsonFile(configPath(), { instanceUrl: instanceUrl.replace(/\/+$/, '') })
  await clearMrState()
}

/**
 * Full log-out: deletes the encrypted token file and the instance/username
 * config, and clears all persisted "last seen note" state — resetting the
 * app to the same on-disk state as a fresh install.
 */
export async function clearCredentials(): Promise<void> {
  await Promise.all([
    fs.rm(credentialsPath(), { force: true }),
    fs.rm(configPath(), { force: true })
  ])
  await clearMrState()
}

export async function loadCredentials(): Promise<{ instanceUrl: string; token: string } | null> {
  const config = await readJsonFile<GitLabConfig>(configPath())
  if (!config?.instanceUrl) return null

  let encrypted: Buffer
  try {
    encrypted = await fs.readFile(credentialsPath())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level encryption is not available on this machine to decrypt the token.')
  }

  const token = safeStorage.decryptString(encrypted)
  return { instanceUrl: config.instanceUrl, token }
}

export async function getCachedUsername(): Promise<string | null> {
  const config = await readJsonFile<GitLabConfig>(configPath())
  return config?.username ?? null
}

export async function setCachedUsername(username: string): Promise<void> {
  const config = await readJsonFile<GitLabConfig>(configPath())
  if (!config) return
  await writeJsonFile(configPath(), { ...config, username })
}

async function loadMrState(): Promise<MergeRequestNoteState> {
  return (await readJsonFile<MergeRequestNoteState>(mrStatePath())) ?? {}
}

// Serializes all read-modify-write access to `mr-state.json` so that two
// near-simultaneous calls (e.g. clicking two "new comment" rows in quick
// succession) don't race: without this, both reads could observe the same
// stale base and the second write would silently clobber the first.
// In-process promise-chaining is sufficient here; there's only ever one
// process writing this file.
let mrStateWriteQueue: Promise<void> = Promise.resolve()

function withMrStateWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = mrStateWriteQueue.then(fn, fn)
  mrStateWriteQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/**
 * Returns the last-seen note id for a merge request, or `undefined` if none
 * has been recorded yet (e.g. never opened, or the app's first-ever poll).
 */
export async function getLastSeenNoteId(mergeRequestId: number): Promise<number | undefined> {
  const state = await loadMrState()
  return state[String(mergeRequestId)]
}

export async function setLastSeenNoteId(mergeRequestId: number, noteId: number): Promise<void> {
  await withMrStateWriteLock(async () => {
    const state = await loadMrState()
    state[String(mergeRequestId)] = noteId
    await writeJsonFile(mrStatePath(), state)
  })
}

/**
 * Clears all persisted "last seen note" state. MR ids aren't globally unique
 * across different GitLab instances, so switching instance/account must
 * invalidate this map — otherwise a new instance's MR could reuse an id
 * whose old `lastSeenNoteId` wrongly suppresses a genuinely new comment.
 */
async function clearMrState(): Promise<void> {
  await withMrStateWriteLock(async () => {
    await writeJsonFile(mrStatePath(), {})
  })
}
