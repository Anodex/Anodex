import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AnodexLogo } from './AnodexLogo'
import { Icon } from './Icon'
import styles from './ErrorBoundary.module.css'

interface Props {
  children: ReactNode
  /**
   * Short section name ("Chat", "File Tree", "Settings", ...). When set, the
   * boundary renders a small inline fallback scoped to just this section
   * instead of the full-page one, and offers a "Try again" that re-renders
   * only this subtree — the rest of the app (e.g. a generation running in
   * another section) keeps working untouched. Omit for the app-root boundary,
   * where there's no narrower scope left to retry into.
   */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * Crash isolation boundary. Used both as the single app-root safety net (no
 * `label`) and nested around individual sections (sidebar, chat, each
 * workspace-dock panel, settings) so a bug in one doesn't take the rest of
 * the window down with it — the failure shows as a small in-place warning in
 * just that section instead of a blank/frozen app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const prefix = this.props.label ? `[${this.props.label}]` : '[App]'
    console.error(`${prefix} Uncaught UI error:`, error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.label) {
      return (
        <div className={styles.sectionContainer}>
          <Icon name="alert" size={16} className={styles.sectionIcon} />
          <div className={styles.sectionText}>
            <span className={styles.sectionTitle}>{this.props.label} hit an error</span>
            <span className={styles.sectionMessage}>{error.message}</span>
          </div>
          <button type="button" className={styles.sectionButton} onClick={this.handleRetry}>
            Try again
          </button>
        </div>
      )
    }

    return (
      <div className={styles.container}>
        <div className={styles.card}>
          <AnodexLogo size={48} />
          <h1 className={styles.title}>Something went wrong</h1>
          <p className={styles.message}>
            Anodex hit an unexpected error. Reloading usually fixes it.
          </p>
          <pre className={styles.detail}>{error.message}</pre>
          <button className={styles.button} onClick={this.handleReload}>
            Reload Anodex
          </button>
        </div>
      </div>
    )
  }
}
