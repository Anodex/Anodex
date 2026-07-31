const shell = document.querySelector('#shell')
const destination = document.querySelector('#destination')
const installMessage = document.querySelector('#install-message')
const installDetail = document.querySelector('#install-detail')
const errorMessage = document.querySelector('#error-message')
const busyNote = document.querySelector('#busy-note')
const installStages = [...document.querySelectorAll('[data-install-stage]')]
const panels = [...document.querySelectorAll('[data-screen-panel]')]
const installer = window.anodexInstaller

let currentDestination = ''

const stageOrder = ['preparing', 'installing', 'finishing', 'payload-complete', 'ready']
const stageCopy = {
  preparing: {
    message: 'Opening your private, local setup.',
    detail: 'The Anodex installer is starting.'
  },
  installing: {
    message: 'Preparing a place for Anodex.',
    detail: 'The installer has selected your local setup.'
  },
  finishing: {
    message: 'Placing Anodex in your space.',
    detail: 'The application files are installed; setup is finishing safely.'
  },
  'payload-complete': {
    message: 'Verifying your new space.',
    detail: 'Checking that Anodex is ready to open.'
  },
  ready: {
    message: 'Anodex is ready.',
    detail: 'Installation completed successfully.'
  }
}

function showScreen(name) {
  // `shell.dataset.screen` is the state — the CSS selects on it, and the
  // panels below read it. A second copy in a variable was only ever written.
  shell.dataset.screen = name
  panels.forEach((panel) => {
    panel.hidden = panel.dataset.screenPanel !== name
  })
}

function setInstallationStage(stage) {
  const activeIndex = stageOrder.indexOf(stage)
  if (activeIndex === -1) return

  const copy = stageCopy[stage]
  installMessage.textContent = copy.message
  installDetail.textContent = copy.detail

  installStages.forEach((item, index) => {
    const state = index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'pending'
    item.classList.toggle('is-complete', state === 'complete')
    item.classList.toggle('is-active', state === 'active')
    item.classList.toggle('is-pending', state === 'pending')
    item.setAttribute('aria-label', `${item.querySelector('strong').textContent}: ${state}`)

    if (state === 'active') item.setAttribute('aria-current', 'step')
    else item.removeAttribute('aria-current')
  })
}

function setDestination(value) {
  currentDestination = value.trim()
  destination.value = currentDestination
}

function startInstalling() {
  const selectedDestination = destination.value.trim()
  if (!selectedDestination) {
    errorMessage.textContent = 'Choose a local folder for Anodex first.'
    showScreen('error')
    return
  }

  setDestination(selectedDestination)
  busyNote.hidden = true
  setInstallationStage('preparing')
  showScreen('install')

  if (!installer) {
    errorMessage.textContent =
      'The Anodex setup service is unavailable. Please close this window and try again.'
    showScreen('error')
    return
  }

  installer.startInstall(currentDestination).then((result) => {
    if (result.ok) return
    errorMessage.textContent = result.error
    showScreen('error')
  })
}

async function finishInstallation(openApp) {
  if (!openApp) {
    installer?.close()
    return
  }

  if (!installer) {
    errorMessage.textContent =
      'The Anodex setup service is unavailable. Please close this window and try again.'
    showScreen('error')
    return
  }

  const result = await installer.launch(currentDestination)
  if (result.ok) return

  errorMessage.textContent = result.error
  showScreen('error')
}

document.querySelector('#begin').addEventListener('click', () => showScreen('location'))
document.querySelector('#back-to-welcome').addEventListener('click', () => showScreen('welcome'))
document.querySelector('#continue').addEventListener('click', startInstalling)
document.querySelector('#retry').addEventListener('click', startInstalling)
document.querySelector('#error-back').addEventListener('click', () => showScreen('location'))
document.querySelector('#browse').addEventListener('click', async () => {
  if (!installer) {
    errorMessage.textContent =
      'The Anodex setup service is unavailable. Please close this window and try again.'
    showScreen('error')
    return
  }

  const selectedFolder = await installer.chooseLocation()
  if (selectedFolder) setDestination(selectedFolder)
})
document.querySelector('#finish').addEventListener('click', () => {
  const openApp = document.querySelector('#launch-on-finish').checked
  void finishInstallation(openApp)
})
document
  .querySelector('#finish-later')
  .addEventListener('click', () => void finishInstallation(false))
document.querySelector('#minimize').addEventListener('click', () => installer?.minimize())
document.querySelector('#close').addEventListener('click', () => installer?.close())

if (installer) {
  installer.onStatus((status) => {
    if (status.type === 'started') {
      setInstallationStage('preparing')
      return
    }

    if (status.type === 'stage') {
      setInstallationStage(status.stage)
      return
    }

    if (status.type === 'busy') {
      busyNote.hidden = false
      return
    }

    if (status.type === 'complete') {
      currentDestination = status.destination
      setDestination(status.destination)
      setInstallationStage('ready')
      window.setTimeout(() => showScreen('ready'), 420)
      return
    }

    if (status.type === 'error') {
      errorMessage.textContent = status.error
      showScreen('error')
    }
  })

  installer
    .getInfo()
    .then((info) => {
      setDestination(info.defaultInstallLocation)
      document.querySelector('#version').textContent = `v${info.version}`
      document.querySelector('#soul-art').src = info.soulUrl
      ;['#brand-icon', '#orbit-icon', '#install-icon'].forEach((selector) => {
        document.querySelector(selector).src = info.iconUrl
      })
    })
    .catch(() => {
      document.querySelector('#version').textContent = 'setup service unavailable'
    })
} else {
  document.querySelector('#version').textContent = 'setup service unavailable'
}
