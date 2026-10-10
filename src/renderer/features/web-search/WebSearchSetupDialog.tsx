import { useEffect, useRef, useState } from 'react'
import { Overlay } from '../../components/ui/Overlay'
import { Icon } from '../../components/Icon'
import { anodex } from '../../lib/anodex'
import { useSettingsStore } from '../../stores/settingsStore'
import { WEB_SEARCH_SERVICES, type WebSearchService } from './webSearchServices'
import styles from './WebSearchSetupDialog.module.css'

/**
 * Web search, set up where it was found missing.
 *
 * Search needs a service and, for most, a key — so out of the box chat could
 * not search and Critical Thinking could not start, and the way forward was a
 * dropdown on the Tools page with a one-line hint. This walks it: pick a
 * service, open its sign-up page, paste the key into a masked box, and Anodex
 * runs one real search with it before anything is saved, so a wrong key is
 * reported here rather than in the middle of a run later.
 */
export function WebSearchSetupDialog({
  onClose,
  onSaved
}: {
  onClose: () => void
  /** After the settings are saved; the caller decides what happens next. */
  onSaved?: () => void
}): JSX.Element {
  const current = useSettingsStore((s) => s.settings?.webSearch)
  const update = useSettingsStore((s) => s.update)
  const [serviceId, setServiceId] = useState<WebSearchService['id']>(() => {
    const saved = WEB_SEARCH_SERVICES.find((service) => service.id === current?.provider)
    return saved?.id ?? WEB_SEARCH_SERVICES[0].id
  })
  const service =
    WEB_SEARCH_SERVICES.find((item) => item.id === serviceId) ?? WEB_SEARCH_SERVICES[0]
  const [value, setValue] = useState('')
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'testing' } | { kind: 'failed'; message: string } | { kind: 'done' }
  >({ kind: 'idle' })
  const inputRef = useRef<HTMLInputElement>(null)

  // A different service needs a different thing pasted.
  useEffect(() => {
    setValue(service.needs === 'url' ? (current?.baseUrl ?? '') : '')
    setState({ kind: 'idle' })
    inputRef.current?.focus()
    // Only on a change of service: the saved values are read once per choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId])

  const entered = value.trim()
  const canTest = entered.length > 0 && state.kind !== 'testing' && state.kind !== 'done'

  const testAndSave = async (): Promise<void> => {
    if (!canTest) return
    setState({ kind: 'testing' })
    const config = {
      provider: service.id,
      apiKey: service.needs === 'key' ? entered : '',
      baseUrl: service.needs === 'url' ? entered : (current?.baseUrl ?? ''),
      searchEngineId: current?.searchEngineId ?? ''
    }
    const result = await anodex.webSearch.test(config)
    if (!result.ok) {
      setState({ kind: 'failed', message: result.error.message })
      return
    }
    await update({
      webSearch: { provider: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl }
    })
    setState({ kind: 'done' })
    onSaved?.()
  }

  return (
    <Overlay onClose={onClose} ariaLabel="Set up web search" cardClassName={styles.modal}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void testAndSave()
        }}
      >
        <div className={styles.header}>
          <span className={styles.badge}>
            <Icon name="web" size={16} />
          </span>
          <div>
            <div className={styles.title}>Set up web search</div>
            <p className={styles.subtitle}>
              Anodex searches through a service you choose. Its key stays on this computer,
              encrypted.
            </p>
          </div>
        </div>

        <fieldset className={styles.services}>
          <legend className={styles.step}>1. Choose a service</legend>
          {WEB_SEARCH_SERVICES.map((item) => (
            <label
              key={item.id}
              className={`${styles.service} ${item.id === serviceId ? styles.serviceActive : ''}`}
            >
              <input
                type="radio"
                name="web-search-service"
                value={item.id}
                checked={item.id === serviceId}
                onChange={() => setServiceId(item.id)}
              />
              <span className={styles.serviceText}>
                <span className={styles.serviceName}>
                  {item.name}
                  {item.recommended && <span className={styles.recommended}>Recommended</span>}
                </span>
                <span className={styles.serviceCost}>{item.cost}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className={styles.body}>
          <div className={styles.step}>2. {service.needs === 'key' ? 'Get a key' : 'Run it'}</div>
          <a className={styles.getLink} href={service.getUrl} target="_blank" rel="noreferrer">
            {service.getLabel}
            <Icon name="external-link" size={12} />
          </a>

          <label className={styles.step} htmlFor="web-search-value">
            3. {service.needs === 'key' ? 'Paste the key' : 'Its address'}
          </label>
          <input
            ref={inputRef}
            id="web-search-value"
            className={styles.input}
            type={service.needs === 'key' ? 'password' : 'url'}
            autoComplete="off"
            spellCheck={false}
            placeholder={service.placeholder}
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              if (state.kind === 'failed') setState({ kind: 'idle' })
            }}
          />
          {state.kind === 'failed' && (
            <p className={styles.error} role="alert">
              {state.message}
            </p>
          )}
          {state.kind === 'done' && (
            <p className={styles.success} role="status">
              <Icon name="check" size={14} />
              Web search is ready. Chats and Critical Thinking can use it now.
            </p>
          )}
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onClose}>
            {state.kind === 'done' ? 'Done' : 'Cancel'}
          </button>
          {state.kind !== 'done' && (
            <button type="submit" className={styles.confirm} disabled={!canTest}>
              {state.kind === 'testing' ? 'Testing…' : 'Test and save'}
            </button>
          )}
        </div>
      </form>
    </Overlay>
  )
}
