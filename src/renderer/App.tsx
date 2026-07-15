import { useAnodexBridge } from './hooks/useAnodexBridge'
import { useInterfaceSounds } from './hooks/useInterfaceSounds'
import { AppShell } from './components/AppShell'

/** Application root: initialise the IPC bridge, then render the shell. */
export function App(): JSX.Element {
  useAnodexBridge()
  useInterfaceSounds()
  return <AppShell />
}
