import { useEffect, useState } from 'react'

/**
 * Tracks a CSS media query from React.
 *
 * Exists for layout decisions that can't be made in CSS alone — the Email
 * page's assistant rail has to *unmount* on a narrow window rather than be
 * hidden with `display: none`, because it hosts the tool-approval card and a
 * confirmation the user cannot see is worse than one that isn't there.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const list = window.matchMedia(query)
    // Re-read on subscribe: the window can be resized between the initial
    // state above and this effect running.
    setMatches(list.matches)
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}
