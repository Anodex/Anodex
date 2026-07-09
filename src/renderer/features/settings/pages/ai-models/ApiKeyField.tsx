import { useCallback, useEffect, useState } from 'react'
import { anodex } from '../../../../lib/anodex'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { TextControl } from '../../controls'
import styles from './AiModelsSettings.module.css'

interface VerifyResult {
  /** The exact key text this result belongs to, so an edited-but-unsaved key shows as unverified. */
  key: string
  status: 'valid' | 'invalid'
  message?: string
}

type Tone = 'idle' | 'checking' | 'valid' | 'invalid'

const TONE_CLASS: Record<Tone, string> = {
  idle: 'statusUnloaded',
  checking: 'statusLoading',
  valid: 'statusLoaded',
  invalid: 'statusError'
}

/**
 * A password field for a cloud provider's API key, with a status dot on the
 * left showing whether it's actually working and an icon button on the right
 * to (re)test it — makes a cheap, metadata-only call, no tokens spent.
 *
 * Verifies once automatically when a saved key is present (so returning to
 * Settings shows status without a click), and again on demand. Editing the
 * key after a test invalidates that result — shown as "Unverified" — rather
 * than silently re-testing on every keystroke.
 */
export function ApiKeyField({
  provider,
  value,
  model,
  placeholder,
  onChange
}: {
  provider: 'anthropic' | 'openai'
  value: string
  model: string
  placeholder: string
  onChange: (value: string) => void
}): JSX.Element {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<VerifyResult | null>(null)

  const runTest = useCallback(
    (key: string) => {
      if (!key.trim()) return
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
    if (value.trim()) runTest(value)
    // Intentionally once per mount, not on every keystroke — see the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasKey = value.trim().length > 0
  const stale = result?.key !== value
  const tone: Tone = !hasKey
    ? 'idle'
    : checking
      ? 'checking'
      : !stale && result
        ? result.status
        : 'idle'
  const dotTitle = !hasKey
    ? 'No API key entered'
    : checking
      ? 'Checking…'
      : stale
        ? 'Unverified — click Test connection to check'
        : result?.status === 'valid'
          ? 'Connected'
          : (result?.message ?? 'Invalid key')

  return (
    <div className={styles.keyField}>
      <Button
        variant="ghost"
        size="sm"
        iconLeft={<Icon name="refresh" size={14} />}
        loading={checking}
        disabled={!hasKey}
        onClick={() => runTest(value)}
        title="Test connection"
        aria-label="Test connection"
      />
      <span className={`${styles.statusDot} ${styles[TONE_CLASS[tone]]}`} title={dotTitle} />
      <TextControl type="password" value={value} placeholder={placeholder} onChange={onChange} />
    </div>
  )
}
