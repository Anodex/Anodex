/// <reference types="vite/client" />

import type { AnodexApi } from '@shared/ipc'

declare global {
  interface Window {
    /** The typed bridge to the main process, injected by the preload script. */
    anodex: AnodexApi
  }
}

// CSS Module typings are provided by `vite/client` (referenced above).
