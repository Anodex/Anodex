import { Icon, type IconName } from '../../components/Icon'
import styles from './PlaceholderView.module.css'

interface PlaceholderViewProps {
  icon: IconName
  title: string
}

export function PlaceholderView({ icon, title }: PlaceholderViewProps): JSX.Element {
  return (
    <div className={styles.view}>
      <div className={styles.empty}>
        <Icon name={icon} size={32} className={styles.icon} />
        <h1>{title}</h1>
        <p>Coming soon</p>
      </div>
    </div>
  )
}
