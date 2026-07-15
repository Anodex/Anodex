import { useState } from 'react'
import { MAX_ASSISTANT_STYLE_CHARS } from '@shared/settings.types'
import { renderAssistantStyleSection } from '@shared/prompts'
import { ASSISTANT_STYLE_PRESETS } from '../../assistantStylePresets'
import { Button } from '../../../../components/ui/Button'
import { SettingRow } from '../../SettingRow'
import { SelectControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'
import styles from './AssistantStyleSection.module.css'

interface AssistantStyleSectionProps {
  value: string
  update: (value: string) => void
}

export function AssistantStyleSection({ value, update }: AssistantStyleSectionProps): JSX.Element {
  const [showPreview, setShowPreview] = useState(false)
  const [copied, setCopied] = useState(false)

  return (
    <section className={pageStyles.section}>
      <h2 className={pageStyles.sectionTitle}>Assistant preferences</h2>
      <p className={pageStyles.sectionDesc}>
        Global voice and tone guidance used in every conversation, ahead of project instructions.
      </p>
      <SettingRow
        label="Quick start"
        description="Choose a starting point, then edit it below."
        control={
          <SelectControl
            value=""
            options={[
              { label: 'Choose a preset…', value: '' },
              ...ASSISTANT_STYLE_PRESETS.map((preset) => ({
                label: preset.label,
                value: preset.label
              }))
            ]}
            onChange={(label) => {
              const preset = ASSISTANT_STYLE_PRESETS.find((item) => item.label === label)
              if (preset) update(preset.text)
            }}
          />
        }
      />
      <textarea
        className={styles.textarea}
        value={value}
        rows={4}
        maxLength={MAX_ASSISTANT_STYLE_CHARS}
        placeholder="e.g. Be direct and terse. Explain tradeoffs before making a choice."
        onChange={(event) => update(event.target.value.slice(0, MAX_ASSISTANT_STYLE_CHARS))}
      />
      <div className={styles.meta}>
        <span className={styles.counter}>
          {value.length} / {MAX_ASSISTANT_STYLE_CHARS}
        </span>
        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview((current) => !current)}
            disabled={!value.trim()}
          >
            {showPreview ? 'Hide preview' : 'Preview'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!value}
            onClick={() => {
              void navigator.clipboard.writeText(value).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="ghost" size="sm" disabled={!value} onClick={() => update('')}>
            Reset
          </Button>
        </div>
      </div>
      {showPreview && value.trim() && (
        <pre className={styles.preview}>{renderAssistantStyleSection(value.trim())}</pre>
      )}
    </section>
  )
}
