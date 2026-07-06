import type { AnodexApi } from '@shared/ipc'

/**
 * Typed accessor for the preload bridge.
 *
 * Centralising access here means components import a normal module instead of
 * reaching into `window`, which keeps them clean and makes the dependency easy
 * to mock in tests later.
 */
export const anodex: AnodexApi = window.anodex
