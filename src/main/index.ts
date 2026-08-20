import { app, BrowserWindow, Menu, Tray, screen, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import trayIcon from '../../resources/trayTemplate.png?asset'
import { logOutOfGitLab, registerGitLabIpcHandlers, startGitLabPolling } from './gitlab/ipc'
import { hasCredentials } from './gitlab/storage'

let tray: Tray | null = null
let popup: BrowserWindow | null = null

const POPUP_WIDTH = 280
const POPUP_HEIGHT = 420

function createPopup(): BrowserWindow {
  const win = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Without this, macOS treats the popup as belonging to whichever Space it
  // was first shown on, and switches the user to that Space every time the
  // tray icon is clicked from elsewhere — instead of showing the popup on
  // the current Space, like other menu bar apps do.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.on('blur', () => {
    win.hide()
  })

  win.webContents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function getPopupPosition(trayInstance: Tray): { x: number; y: number } {
  const trayBounds = trayInstance.getBounds()
  const display = screen.getPrimaryDisplay()
  const { workArea } = display

  // Center the popup horizontally under the tray icon, clamped to the
  // visible work area so it never renders off-screen.
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - POPUP_WIDTH / 2)
  x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - POPUP_WIDTH)

  const y = Math.round(trayBounds.y + trayBounds.height)

  return { x, y }
}

function togglePopup(): void {
  if (!popup || !tray) return

  if (popup.isVisible()) {
    popup.hide()
    return
  }

  const { x, y } = getPopupPosition(tray)
  popup.setPosition(x, y, false)
  popup.show()
  popup.focus()
}

/**
 * Built fresh on every right-click (rather than once and cached) so the
 * "Log out" item's enabled state always reflects credential state at the
 * moment of the click, not whatever it was when the tray was created.
 */
function buildTrayContextMenu(loggedIn: boolean): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Log out',
      enabled: loggedIn,
      click: () => {
        void logOutOfGitLab(
          () => popup,
          () => tray
        )
      }
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ])
}

function createTray(): void {
  const image = nativeImage.createFromPath(trayIcon)
  image.setTemplateImage(true)

  tray = new Tray(image)
  tray.setToolTip('GitLab Bar')

  tray.on('click', () => {
    togglePopup()
  })

  tray.on('right-click', () => {
    void hasCredentials().then((loggedIn) => {
      tray?.popUpContextMenu(buildTrayContextMenu(loggedIn))
    })
  })
}

// Prevent duplicate tray icons if the app is launched a second time (e.g.
// running `npm run dev` while a previous instance is still up) — the second
// launch just hands off to the first instance and quits itself instead of
// spawning a duplicate with its own tray icon.
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    togglePopup()
  })

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  app.whenReady().then(() => {
    // Menu-bar-only app: no Dock icon on macOS.
    if (process.platform === 'darwin') {
      app.dock?.hide()
    }

    electronApp.setAppUserModelId('com.gitlabbar.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    popup = createPopup()
    createTray()

    if (is.dev && process.env['GITLAB_BAR_DEBUG_AUTOSHOW']) {
      const { x, y } = getPopupPosition(tray!)
      popup.setPosition(x, y, false)
      popup.show()
    }

    registerGitLabIpcHandlers(
      () => popup,
      () => tray
    )
    startGitLabPolling(
      () => popup,
      () => tray
    )
  })

  app.on('window-all-closed', () => {
    // Keep the app (and tray icon) alive even with no windows open —
    // this is a menu-bar app, not a normal window-based app.
  })
}
