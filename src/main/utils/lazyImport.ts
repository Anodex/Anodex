/** A module loaded on first use, and the same promise every time after. */
export interface LazyModule<T> {
  (): Promise<T>
  /** The module if it has finished loading, for a check that cannot wait. */
  loaded(): T | undefined
}

/**
 * Load a heavy package the first time something needs it, not at launch.
 *
 * The main process used to require every package any feature might use before
 * the window opened: the email client, the cloud SDKs, MCP, certificate
 * generation for pairing a phone. Measured on its own, that was about 115MB of
 * memory and 0.4s of every start, mostly for features a given launch never
 * touches. Each is now read the first time its feature runs.
 *
 * A failed load is not cached, so a transient failure is retried next time.
 */
export function lazyImport<T>(load: () => Promise<T>): LazyModule<T> {
  let pending: Promise<T> | undefined
  let value: T | undefined
  const get = (() =>
    (pending ??= load().then(
      (module) => (value = module),
      (error: unknown) => {
        pending = undefined
        throw error
      }
    ))) as LazyModule<T>
  get.loaded = () => value
  return get
}
