export interface LocalOutputBudgetInput {
  contextSize: number
  inputLimitTokens: number
  fixedTokens: number
  requestedMaxTokens: number | undefined
  hasFunctions: boolean
}

export interface LocalOutputBudget {
  requestedMaxTokens: number | undefined
  effectiveMaxTokens: number
  clamped: boolean
}

/**
 * Bound one local generation to space that really exists after the wrapper,
 * system prompt, current request, and active function schemas are rendered.
 *
 * node-llama-cpp counts unfinished function arguments against the native
 * context window, but those pending tokens are not present in `chatHistory`
 * and therefore cannot be removed by a context-shift strategy. Tool-enabled
 * turns use the same quarter-context ceiling as Anodex's model recommendation
 * so a malformed first call cannot consume an entire window before it can be
 * checkpointed. Tool-less replies can use all measured space before the
 * context-shift reserve.
 */
export function resolveLocalOutputBudget(input: LocalOutputBudgetInput): LocalOutputBudget {
  const availableTokens = Math.max(1, input.inputLimitTokens - input.fixedTokens)
  const toolAwareCeiling = input.hasFunctions
    ? Math.max(1, Math.floor(input.contextSize * 0.25))
    : availableTokens
  const safeCeiling = Math.min(availableTokens, toolAwareCeiling)
  const requested = normalizeRequestedMaxTokens(input.requestedMaxTokens)
  const effectiveMaxTokens =
    requested === undefined ? safeCeiling : Math.min(requested, safeCeiling)

  return {
    requestedMaxTokens: requested,
    effectiveMaxTokens,
    clamped: requested === undefined || requested > effectiveMaxTokens
  }
}

function normalizeRequestedMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return Math.max(1, Math.floor(value))
}
