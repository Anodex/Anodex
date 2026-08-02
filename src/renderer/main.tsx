import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ToastWindow } from './ToastWindow'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installDemos } from './features/demo'
import './styles/global.css'
import './styles/highlight.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root was not found.')

// The desktop-toast window loads this same bundle with `?mode=toast` (see
// `main/toastWindow.ts`) rather than a second Vite entry point, so it shares
// styling/build config with the main app. Set the background-transparent
// marker synchronously, before the first render, so there's no flash of the
// app's normal opaque background before `ToastWindow` mounts.
const isToast = new URLSearchParams(window.location.search).get('mode') === 'toast'
if (isToast) document.body.dataset.window = 'toast'

// Dev-only: attaches the walkthrough drivers used to record demo video. No-op
// in production builds.
if (!isToast) installDemos()

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>{isToast ? <ToastWindow /> : <App />}</ErrorBoundary>
  </StrictMode>
)
