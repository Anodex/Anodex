import { useAnodexBridge } from './hooks/useAnodexBridge'
import { useInterfaceSounds } from './hooks/useInterfaceSounds'
import { AppShell } from './components/AppShell'
import { StartupOverlay } from './features/startup/StartupOverlay'

/**
 * Application root: initialise the IPC bridge, then render the shell. The
 * startup overlay sits above the shell — the real UI renders and hydrates
 * underneath it from the first frame, and the overlay dismisses itself once
 * `startupStore` reports readiness.
 */
export function App(): JSX.Element {
  useAnodexBridge()
  useInterfaceSounds()
  return (
    <>
      <AppShell />
      <StartupOverlay />
    </>
  )
}
