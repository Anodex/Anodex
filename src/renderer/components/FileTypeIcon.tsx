import { detectLang, isImageFile, IMAGE_COLOR, LANG_COLORS, LANG_ICONS } from '../lib/fileTypeIcons'
import { Icon } from './Icon'

/**
 * A file's language/format logo colored with its real brand color. Image files
 * (which have no per-format brand mark) get a shared image glyph in a distinct
 * color, and everything else falls back to the generic file glyph (in the
 * surrounding text color) — an honest fallback rather than guessing at a brand.
 */
export function FileTypeIcon({
  fileName,
  size = 14
}: {
  fileName: string
  size?: number
}): JSX.Element {
  if (isImageFile(fileName)) {
    return <Icon name="image" size={size} style={{ color: IMAGE_COLOR }} />
  }

  const lang = detectLang(fileName)
  if (!lang) return <Icon name="file" size={size} />

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={LANG_COLORS[lang]} aria-hidden="true">
      <path d={LANG_ICONS[lang]} />
    </svg>
  )
}
