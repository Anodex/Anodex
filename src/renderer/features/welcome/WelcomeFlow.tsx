import { useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUiStore } from '../../stores/uiStore'
import { WelcomeYou } from './WelcomeYou'
import { WelcomeModel } from './WelcomeModel'
import { WelcomePhone } from './WelcomePhone'
import { WelcomeDone } from './WelcomeDone'
import styles from './Welcome.module.css'

export type WelcomeStep = 'you' | 'model' | 'phone' | 'done'

/**
 * The first run: who you are, a model, your phone.
 *
 * Shown once, on a fresh install, above the app and below the startup starfield,
 * which fades to reveal it. Every step can be skipped, and the last one says
 * where to find whatever was skipped. `welcome.completed` is set only when the
 * person leaves it, so quitting halfway brings them back to the start.
 */
export function WelcomeFlow(): JSX.Element | null {
  const completed = useSettingsStore((s) => s.settings?.welcome.completed ?? true)
  if (completed) return null
  return <Welcome />
}

function Welcome(): JSX.Element {
  const update = useSettingsStore((s) => s.update)
  const openSettings = useUiStore((s) => s.openSettings)
  const [step, setStep] = useState<WelcomeStep>('you')
  const [paired, setPaired] = useState(false)

  const finish = (): void => {
    void update({ welcome: { completed: true, nameAsked: true } })
  }

  return (
    <div className={styles.welcome} role="dialog" aria-modal="true" aria-label="Welcome to Anodex">
      <div className={styles.stars} aria-hidden="true" />
      <div className={styles.stage}>
        {step === 'you' && <WelcomeYou onNext={() => setStep('model')} />}
        {step === 'model' && (
          <WelcomeModel
            onBack={() => setStep('you')}
            onNext={() => setStep('phone')}
            onOpenSettings={() => {
              finish()
              openSettings('ai-models')
            }}
          />
        )}
        {step === 'phone' && (
          <WelcomePhone
            paired={paired}
            onPaired={() => setPaired(true)}
            onBack={() => setStep('model')}
            onNext={() => setStep('done')}
          />
        )}
        {step === 'done' && <WelcomeDone paired={paired} onFinish={finish} />}
      </div>
    </div>
  )
}

/** The three dashes at the top of each step. */
export function WelcomeSteps({ at }: { at: 1 | 2 | 3 }): JSX.Element {
  return (
    <div className={styles.steps} aria-label={`Step ${at} of 3`}>
      {[1, 2, 3].map((n) => (
        <i key={n} className={n <= at ? styles.stepOn : undefined} />
      ))}
      <span>You · Model · Phone</span>
    </div>
  )
}
