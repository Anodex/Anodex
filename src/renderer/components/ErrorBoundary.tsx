import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AnodexLogo } from './AnodexLogo'
import styles from './ErrorBoundary.module.css'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Top-level safety net. If any part of the UI throws during render, we show a
 * recoverable fallback instead of a blank window — the app should never look
 * broken to the user.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Uncaught UI error:', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className={styles.container}>
        <div className={styles.card}>
          <AnodexLogo size={48} />
          <h1 className={styles.title}>Something went wrong</h1>
          <p className={styles.message}>
            Anodex hit an unexpected error. Reloading usually fixes it.
          </p>
          <pre className={styles.detail}>{this.state.error.message}</pre>
          <button className={styles.button} onClick={this.handleReload}>
            Reload Anodex
          </button>
        </div>
      </div>
    )
  }
}
