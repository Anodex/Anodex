import { afterEach, describe, expect, it } from 'vitest'
import {
  abortAllGenerations,
  hasInflightGeneration,
  registerGeneration,
  releaseGeneration
} from '../../chat/inflightGenerations'

/**
 * The guard on switching the active project.
 *
 * There is one active project and it is global state — `ProjectStore.setActive`
 * writes `settings.workspace.root`. Switching mid-generation pulls the workspace
 * out from under a live turn, which is breakage rather than a surprise.
 *
 * It matters most for a switch that came from a phone (§10.1), because then
 * nobody is watching the machine it happens on: the person at the desk sees a
 * turn fail for no reason they can observe.
 */
describe('in-flight generation guard', () => {
  afterEach(() => abortAllGenerations())

  it('reports nothing running when nothing is', () => {
    expect(hasInflightGeneration()).toBe(false)
  })

  it('reports a generation while one is registered', () => {
    const controller = new AbortController()
    registerGeneration('conversation-1', controller)

    expect(hasInflightGeneration()).toBe(true)
  })

  it('clears once the generation is released', () => {
    const controller = new AbortController()
    registerGeneration('conversation-1', controller)
    releaseGeneration('conversation-1', controller)

    expect(hasInflightGeneration()).toBe(false)
  })

  it('stays true while any one of several is still running', () => {
    // A phone and the desktop can each be mid-turn. Either is reason enough to
    // refuse a switch.
    const first = new AbortController()
    const second = new AbortController()
    registerGeneration('from-desktop', first)
    registerGeneration('from-phone', second)

    releaseGeneration('from-desktop', first)
    expect(hasInflightGeneration()).toBe(true)

    releaseGeneration('from-phone', second)
    expect(hasInflightGeneration()).toBe(false)
  })

  it('a superseded controller does not release the slot it no longer owns', () => {
    // An overlapping send replaces the registration. The older controller calling
    // release must not clear the newer generation's slot, or a switch would be
    // allowed straight through a live turn.
    const first = new AbortController()
    const second = new AbortController()
    registerGeneration('same-conversation', first)
    registerGeneration('same-conversation', second)

    releaseGeneration('same-conversation', first)

    expect(hasInflightGeneration()).toBe(true)
  })
})
