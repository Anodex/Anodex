// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils/dom'
import { useAnchoredPosition, type Anchor } from '../useAnchoredPosition'

/**
 * jsdom lays nothing out, so a floating layer measures 0×0 unless it is told
 * otherwise. These stubs stand in for a menu of a known size.
 */
function stubMenuSize(width: number, height: number): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => width
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => height
  })
}

function setWindowSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  document.documentElement.style.setProperty('--titlebar-height', '38px')
}

function Menu({ anchor }: { anchor: Anchor | null }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const style = useAnchoredPosition(anchor, ref)
  return (
    <div ref={ref} data-testid="menu" style={style}>
      menu
    </div>
  )
}

afterEach(() => {
  // @ts-expect-error — removing the stub restores jsdom's own zero-size getter.
  delete HTMLElement.prototype.offsetWidth
  // @ts-expect-error — as above.
  delete HTMLElement.prototype.offsetHeight
})

describe('useAnchoredPosition', () => {
  it('opens below a trigger with room under it', () => {
    setWindowSize(1000, 800)
    stubMenuSize(210, 180)
    render(<Menu anchor={{ top: 100, bottom: 120, left: 40, right: 250 }} />)
    const menu = screen.getByTestId('menu')
    expect(menu.style.top).toBe('124px')
    expect(menu.style.visibility).toBe('visible')
  })

  it('flips above a trigger at the bottom of the window', () => {
    setWindowSize(1000, 800)
    stubMenuSize(210, 180)
    render(<Menu anchor={{ top: 700, bottom: 720, left: 40, right: 250 }} />)
    expect(screen.getByTestId('menu').style.top).toBe('516px')
  })

  it('measures the layer instead of assuming a size, so a taller menu still fits', () => {
    setWindowSize(1000, 800)
    stubMenuSize(210, 520)
    render(<Menu anchor={{ top: 700, bottom: 720, left: 40, right: 250 }} />)
    const menu = screen.getByTestId('menu')
    expect(Number.parseInt(menu.style.top, 10) + 520).toBeLessThanOrEqual(800 - 8)
  })

  it('re-places the layer when the anchor moves', () => {
    setWindowSize(1000, 800)
    stubMenuSize(210, 180)

    function Movable(): JSX.Element {
      const [top, setTop] = useState(100)
      return (
        <>
          <button type="button" onClick={() => setTop(700)}>
            move
          </button>
          <Menu anchor={{ top, bottom: top + 20, left: 40, right: 250 }} />
        </>
      )
    }

    render(<Movable />)
    expect(screen.getByTestId('menu').style.top).toBe('124px')
    fireEvent.click(screen.getByRole('button', { name: 'move' }))
    expect(screen.getByTestId('menu').style.top).toBe('516px')
  })

  it('hides the layer until it has been measured', () => {
    setWindowSize(1000, 800)
    stubMenuSize(210, 180)
    render(<Menu anchor={null} />)
    expect(screen.getByTestId('menu').style.visibility).toBe('hidden')
  })
})
