const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { closeSync, existsSync, openSync, readFileSync, rmSync } = require('node:fs')
const { randomBytes } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join, normalize, isAbsolute } = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')

let mainWindow = null
let installInProgress = false

const INSTALL_STAGES = new Set(['preparing', 'installing', 'finishing', 'payload-complete'])

function defaultInstallLocation() {
  const localAppData = process.env.LOCALAPPDATA || app.getPath('appData')
  return join(localAppData, 'Programs', 'Anodex')
}

function resourceUrl(...segments) {
  return pathToFileURL(join(process.resourcesPath, ...segments)).href
}

function sendInstallStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('installer:status', status)
}

function createStageReporter() {
  let stageFile = ''
  let token = ''

  for (let attempt = 0; attempt < 5; attempt += 1) {
    token = randomBytes(16).toString('hex')
    const candidate = join(tmpdir(), `anodex-installer-stage-${token}.txt`)

    try {
      const handle = openSync(candidate, 'wx')
      closeSync(handle)
      stageFile = candidate
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }

  if (!stageFile) throw new Error('Could not create installer stage telemetry.')

  let lastStage = ''
  let disposed = false

  function publishLatestStage() {
    if (disposed || !existsSync(stageFile)) return

    try {
      const stage = readFileSync(stageFile, 'utf8').trim()
      if (!INSTALL_STAGES.has(stage) || stage === lastStage) return

      lastStage = stage
      sendInstallStatus({ type: 'stage', stage })
    } catch {
      // The NSIS payload can be between opening and replacing the tiny status
      // file. The next poll will pick up the completed write.
    }
  }

  const poll = setInterval(publishLatestStage, 140)

  return {
    token,
    stageFile,
    flush: publishLatestStage,
    dispose() {
      disposed = true
      clearInterval(poll)

      try {
        // This exact, random file was created above solely for this launch's
        // telemetry. The NSIS payload derives it from a validated token.
        rmSync(stageFile, { force: true })
      } catch {
        // Reporting must never interfere with a successful installation.
      }
    }
  }
}

function validateDestination(value) {
  if (typeof value !== 'string') {
    throw new Error('Choose a folder for Anodex first.')
  }

  const destination = normalize(value.trim())
  if (
    !destination ||
    !isAbsolute(destination) ||
    destination.includes('\u0000') ||
    destination.includes('"') ||
    destination.includes('\r') ||
    destination.includes('\n')
  ) {
    throw new Error('Choose a valid local folder for Anodex.')
  }

  return destination
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 620,
    center: true,
    show: false,
    frame: false,
    backgroundColor: '#070a19',
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (!installInProgress) return
    event.preventDefault()
    sendInstallStatus({ type: 'busy' })
  })
  mainWindow.loadFile(join(__dirname, 'index.html'))
}

app.whenReady().then(() => {
  ipcMain.handle('installer:info', () => ({
    version: app.getVersion(),
    defaultInstallLocation: defaultInstallLocation(),
    soulUrl: resourceUrl('art', 'installer-soul.png'),
    iconUrl: resourceUrl('art', 'anodex-icon.png')
  }))

  ipcMain.handle('installer:choose-location', async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where to install Anodex',
      defaultPath: defaultInstallLocation(),
      properties: ['openDirectory', 'createDirectory']
    })
    return selection.canceled ? null : selection.filePaths[0]
  })

  ipcMain.handle('installer:start', (_event, requestedDestination) => {
    if (installInProgress) {
      return { ok: false, error: 'Anodex is already being installed.' }
    }

    let destination
    try {
      destination = validateDestination(requestedDestination)
    } catch (error) {
      return { ok: false, error: error.message }
    }

    const payloadPath = join(process.resourcesPath, 'payload', 'Anodex Setup 0.1.0.exe')
    if (!existsSync(payloadPath)) {
      return { ok: false, error: 'The embedded Anodex installer could not be found.' }
    }

    // /D must be the final NSIS argument. electron-builder's stock multi-user
    // installer understands paths with spaces and retains its normal registry,
    // shortcut, update, and uninstaller behavior.
    let stageReporter
    try {
      stageReporter = createStageReporter()
    } catch {
      // Installation remains safe if the cosmetic stage telemetry cannot be
      // created. The wrapper still waits for the NSIS process to finish.
    }

    const args = ['/S', '/currentuser']
    if (stageReporter) args.push(`--anodex-status-token=${stageReporter.token}`)
    args.push(`/D=${destination}`)

    let child
    try {
      child = spawn(payloadPath, args, {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch (error) {
      stageReporter?.dispose()
      return { ok: false, error: `Anodex could not start: ${error.message}` }
    }

    installInProgress = true
    sendInstallStatus({ type: 'started', destination })

    let didFinish = false
    function finishInstall(status) {
      if (didFinish) return
      didFinish = true
      stageReporter?.flush()
      installInProgress = false
      stageReporter?.dispose()
      sendInstallStatus(status)
    }

    child.once('error', (error) => {
      finishInstall({ type: 'error', error: `Anodex could not start: ${error.message}` })
    })
    child.once('exit', (code) => {
      if (code === 0 && existsSync(join(destination, 'Anodex.exe'))) {
        finishInstall({ type: 'complete', destination })
        return
      }
      finishInstall({
        type: 'error',
        error: 'The setup did not finish. Please try again, or choose a different folder.'
      })
    })

    return { ok: true }
  })

  ipcMain.handle('installer:launch', async (_event, requestedDestination) => {
    let destination
    try {
      destination = validateDestination(requestedDestination)
    } catch (error) {
      return { ok: false, error: error.message }
    }

    const applicationPath = join(destination, 'Anodex.exe')
    if (!existsSync(applicationPath)) {
      return { ok: false, error: 'Anodex is not ready yet. Please finish the installation first.' }
    }

    const launchError = await shell.openPath(applicationPath)
    if (launchError) return { ok: false, error: launchError }

    setTimeout(() => app.quit(), 450)
    return { ok: true }
  })

  ipcMain.on('installer:minimize', () => mainWindow?.minimize())
  ipcMain.on('installer:close', () => mainWindow?.close())

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
