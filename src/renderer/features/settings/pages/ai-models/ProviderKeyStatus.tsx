import { useCallback, useEffect, useState } from 'react'
import { anodex } from '../../../../lib/anodex'
import { Button } from '../../../../components/ui/Button'
import { Spinner } from '../../../../components/ui/Spinner'
import styles from './AiModelsSettings.module.css'

interface VerifyResult {
  /** The exact key text this result belongs to, so an edited-but-unsaved key shows as unverified. */
  key: string
  status: 'valid' | 'invalid'
  message?: string
}

/**
 * "Test connection" control shown next to a cloud provider's API key field —
 * makes a cheap, metadata-only call (no tokens spent) to confirm the key and
 * configured model actually work, and shows a green/red status pill.
 *
 * Verifies once automatically when a saved key is present (so returning to
 * Settings shows status without a click), and again whenever the user clicks
 * "Test connection". Editing the key after a test invalidates that result —
 * shown as "Unverified" — rather than silently re-testing on every keystroke.
 */
export function ProviderKeyStatus({
  provider,
  apiKey,
  model
}: {
  provider: 'anthropic' | 'openai'
  apiKey: string
  model: string
}): JSX.Element | null {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<VerifyResult | null>(null)

  const runTest = useCallback(
    (key: string) => {
      setChecking(true)
      void anodex.provider
        .verifyKey({ provider, apiKey: key, model })
        .then((response) => {
          setResult(
            response.ok
              ? { key, status: 'valid' }
              : { key, status: 'invalid', message: response.error.message }
          )
        })
        .finally(() => setChecking(false))
    },
    [provider, model]
  )

  useEffect(() => {
    if (apiKey.trim()) runTest(apiKey)
    // Intentionally once per mount, not on every keystroke — see the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!apiKey.trim()) return null

  const stale = result?.key !== apiKey
  const label = checking ? 'Checking' : stale ? 'Unverified' : result?.status === 'valid' ? 'Connected' : 'Invalid key'
  const tone = checking ? 'Loading' : stale ? 'Unloaded' : result?.status === 'valid' ? 'Loaded' : 'Error'

  return (
    <div className={styles.keyStatusRow}>
      <span className={`${styles.statusPill} ${styles[`status${tone}`]}`}>
        {checking ? <Spinner size={11} /> : <span className={styles.statusDot} />}
        {label}
      </span>
      <Button variant="ghost" size="sm" disabled={checking} onClick={() => runTest(apiKey)}>
        Test connection
      </Button>
      {!checking && !stale && result?.status === 'invalid' && result.message && (
        <span className={styles.errorText}>{result.message}</span>
      )}
    </div>
  )
}
