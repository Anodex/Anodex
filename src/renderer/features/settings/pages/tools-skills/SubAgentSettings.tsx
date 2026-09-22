import type { JSX } from 'react'
import { agentRunProviderOptions } from '@shared/agentRunProviders'
import { MAX_SUB_AGENTS, maxSubAgentsFor, subAgentProviderFor } from '@shared/subAgents'
import type { AppSettings, SettingsPatch } from '@shared/settings.types'
import { SettingRow } from '../../SettingRow'
import { SelectControl, ToggleControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'

/**
 * Sub-agents, as their own section.
 *
 * It earns the space because the settings interact in ways nobody would
 * guess: whether delegation does anything at all depends on the engine's
 * parallel-job count, and on where the sub-agents themselves run. A lone
 * toggle in a list of unrelated switches cannot say that, and a user who
 * turns it on and sees no change deserves better than silence.
 *
 * The section states the real ceiling for the current configuration rather
 * than describing the rule and leaving the arithmetic to the reader.
 */
export function SubAgentSettings({
  settings,
  update
}: {
  settings: AppSettings
  update: (patch: SettingsPatch) => Promise<unknown>
}): JSX.Element {
  const configured = agentRunProviderOptions(settings.provider)
  const childProviders = settings.agents.subAgentProviders
  const parallelJobs = settings.model.parallelJobs ?? 1

  // What a *local* run could start right now. The cloud answer is always the
  // product maximum, so the local one is the number worth surfacing.
  const localCeiling = maxSubAgentsFor('local', parallelJobs, childProviders)

  const inherit = { value: '', label: 'Same as the run' }
  const options = [inherit, ...configured]

  /** Replace the provider at one position, trimming trailing inherits. */
  const setSlot = (index: number, value: string): void => {
    const next = [...childProviders]
    while (next.length <= index) next.push('')
    next[index] = value
    // A trailing run of "same as the run" is the same as not configuring
    // those slots at all, and storing it would make the list look
    // deliberately shorter than it is.
    while (next.length > 0 && next[next.length - 1] === '') next.pop()
    void update({ agents: { subAgentProviders: next.filter((entry) => entry !== '') } })
  }

  return (
    <section className={pageStyles.section}>
      <h2 className={pageStyles.sectionTitle}>Sub-agents</h2>
      <p className={pageStyles.sectionDesc}>
        A goal-directed run in the Agent workbench can split its work across smaller agents that
        report back. They appear under the run that sent them, share its budget rather than adding
        to it, and can never use a tool it did not have.
      </p>

      <SettingRow
        label="Let a run use sub-agents"
        description={
          settings.agents.subAgentsEnabled
            ? localCeiling > 0
              ? `On. A local run can start up to ${localCeiling}; a cloud run up to ${MAX_SUB_AGENTS}.`
              : 'On, but a local run cannot start any. The local engine runs one generation at a ' +
                'time and the run itself occupies that slot, so its sub-agents would wait for a ' +
                'slot it cannot release. Give the sub-agents a cloud provider below, or raise ' +
                'Parallel jobs in AI models.'
            : 'Off. Every run does all of its own work in one sequence.'
        }
        control={
          <ToggleControl
            checked={settings.agents.subAgentsEnabled}
            ariaLabel="Let an agent run delegate work to sub-agents"
            onChange={(value) => void update({ agents: { subAgentsEnabled: value } })}
          />
        }
      />

      {settings.agents.subAgentsEnabled && (
        <>
          <p className={pageStyles.sectionDesc}>
            <strong>One sub-agent on a cloud provider measured best.</strong> On a bug-hunt
            benchmark it found every planted defect in the same wall-clock as using no sub-agents at
            all, for a few thousand metered tokens. Two and three found no more and cost four to
            seven times as much, because each one re-reads the whole workspace. Start with one.
          </p>
          <p className={pageStyles.sectionDesc}>
            Where each sub-agent runs. Leaving these as “same as the run” keeps them on whatever the
            run itself uses. Putting them on cloud providers is what lets a local run delegate at
            all — those calls do not queue behind the local model — and giving them{' '}
            <em>different</em> providers is the more interesting reason: models disagree, and a
            review is exactly the task where that is worth paying for.
          </p>
          {Array.from({ length: MAX_SUB_AGENTS }, (_, index) => {
            const chosen = childProviders[index] ?? ''
            const effective = subAgentProviderFor(index, childProviders, 'the run')
            return (
              <SettingRow
                key={index}
                label={`Sub-agent ${index + 1}`}
                description={
                  chosen
                    ? `Runs on ${configured.find((option) => option.value === chosen)?.label ?? chosen}.`
                    : childProviders.length > 0
                      ? `Not set, so it wraps around to ${effective}.`
                      : 'Runs wherever the parent run does.'
                }
                control={
                  <SelectControl
                    value={chosen}
                    options={options}
                    onChange={(value) => setSlot(index, value)}
                  />
                }
              />
            )
          })}
        </>
      )}
    </section>
  )
}
