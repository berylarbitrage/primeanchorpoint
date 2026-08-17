import path from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
import { disposeIpc, registerIpc, setWindow } from './ipc'

const isDev = process.env.NODE_ENV === 'development'
const DEV_URL = 'http://localhost:5173'

let mainWindow: BrowserWindow | null = null
let ipcReady = false

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0e1116',
    title: 'SMS Translator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Never let the renderer navigate away or spawn windows; external links go to
  // the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(DEV_URL)) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  if (isDev) {
    void win.loadURL(DEV_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    mainWindow = createWindow()
    registerIpc(mainWindow)
    ipcReady = true

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
        if (ipcReady) setWindow(mainWindow)
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    disposeIpc()
  })
}
