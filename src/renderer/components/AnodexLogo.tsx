import titleLogo from '../assets/title-logo-256.png'
import appIcon from '../assets/app-icon-256.png'

interface AnodexLogoProps {
  size?: number
  className?: string
  /** 'mark' (default): bare "A" for small/inline spots on the app's own dark
   *  chrome (title bar, toast, avatars). 'icon': the faceted app icon with its
   *  own rounded-square backdrop, for standalone hero/branding moments. */
  variant?: 'mark' | 'icon'
}

/** The Anodex brand logo. */
export function AnodexLogo({
  size = 32,
  className,
  variant = 'mark'
}: AnodexLogoProps): JSX.Element {
  return (
    <img
      src={variant === 'icon' ? appIcon : titleLogo}
      alt="Anodex"
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain' }}
    />
  )
}
