import { useAnodexBridge } from './hooks/useAnodexBridge'
import { AppShell } from './components/AppShell'

/** Application root: initialise the IPC bridge, then render the shell. */
export function App(): JSX.Element {
  useAnodexBridge()
  return <AppShell />
}
