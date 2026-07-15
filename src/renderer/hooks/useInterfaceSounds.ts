import { useEffect } from 'react'
import { playInterfaceSound, type InterfaceSound } from '../lib/sound'

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'select',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  'input[type="checkbox"]',
  'input[type="radio"]'
].join(',')

function soundForControl(control: HTMLElement): InterfaceSound | null {
  const override = control.dataset.sound
  if (override === 'off') return null
  if (override === 'click' || override === 'toggle' || override === 'navigate') return override

  const role = control.getAttribute('role')
  if (role === 'switch' || control.matches('input[type="checkbox"], input[type="radio"]')) {
    return 'toggle'
  }
  if (
    role === 'tab' ||
    role === 'menuitem' ||
    control.matches('a[href], select, summary') ||
    control.hasAttribute('aria-haspopup')
  ) {
    return 'navigate'
  }
  return 'click'
}

/**
 * Adds consistent audio feedback to native and ARIA controls, including ones
 * rendered later in dialogs and popovers. Set `data-sound="off"` on a control
 * that intentionally needs to remain silent, or name a sound to override the
 * inferred one.
 */
export function useInterfaceSounds(): void {
  useEffect(() => {
    function handleClick(event: MouseEvent): void {
      if (!(event.target instanceof Element)) return
      const control = event.target.closest<HTMLElement>(INTERACTIVE_SELECTOR)
      if (
        !control ||
        control.matches(':disabled') ||
        control.getAttribute('aria-disabled') === 'true'
      ) {
        return
      }

      const sound = soundForControl(control)
      if (sound) playInterfaceSound(sound)
    }

    document.addEventListener('click', handleClick, { capture: true })
    return () => document.removeEventListener('click', handleClick, { capture: true })
  }, [])
}
