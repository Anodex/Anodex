import { useAnodexBridge } from './hooks/useAnodexBridge'
import { useInterfaceSounds } from './hooks/useInterfaceSounds'
import { AppShell } from './components/AppShell'
import { StartupOverlay } from './features/startup/StartupOverlay'
import { UpdateNotice } from './features/updates/UpdateNotice'
import { WelcomeFlow } from './features/welcome/WelcomeFlow'

/**
 * Application root: initialise the IPC bridge, then render the shell. On a fresh
 * install the welcome covers the shell until it is finished. The
 * startup overlay sits above both — the real UI renders and hydrates
 * underneath it from the first frame, and the overlay dismisses itself once
 * `startupStore` reports readiness.
 */
export function App(): JSX.Element {
  useAnodexBridge()
  useInterfaceSounds()
  return (
    <>
      <AppShell />
      <WelcomeFlow />
      <UpdateNotice />
      <StartupOverlay />
    </>
  )
}
