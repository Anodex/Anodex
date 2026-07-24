export const IMAGE_ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const

export function changeImageZoom(current: number, direction: -1 | 1): number {
  const next =
    direction > 0
      ? IMAGE_ZOOM_LEVELS.find((level) => level > current)
      : [...IMAGE_ZOOM_LEVELS].reverse().find((level) => level < current)
  return next ?? current
}
