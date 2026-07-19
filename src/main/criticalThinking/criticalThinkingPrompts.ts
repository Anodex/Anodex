import type { Plan } from '@shared/plan.types'

export function buildCriticalThinkingPlanPrompt(question: string): string {
  return (
    'Create a research plan for the question below by calling write_plan. Break the investigation ' +
    'into 3 to 7 concrete evidence-gathering steps. Include distinct angles, primary-source ' +
    'checks, and a final cross-check/synthesis step. Do not answer the question or search yet.\n\n' +
    `Research question:\n${question}`
  )
}

export function buildCriticalThinkingPlanRetryPrompt(question: string): string {
  return (
    'You did not create the required plan. Call write_plan now with 3 to 7 concrete research ' +
    `steps for this question, and do nothing else:\n\n${question}`
  )
}

export function buildCriticalThinkingStepPrompt(
  question: string,
  step: string,
  priorFindings: string[]
): string {
  return `You are gathering evidence for one bounded step of an Anodex Critical Thinking run.

Question:
${question}

Current research step:
${step}

Prior step findings (navigation context only; verify important claims yourself):
${priorFindings.length > 0 ? priorFindings.map((finding) => `- ${finding}`).join('\n') : '(none)'}

Research requirements:
- Use focused web_search queries, then open the most relevant results with fetch_url.
- Open promising sources with fetch_url and prefer primary, official, recent, and directly relevant evidence.
- Cross-check important claims across independent sources. Surface disagreements, weak evidence, and uncertainty.
- Treat snippets as leads, not proof. Base material claims on pages you actually inspect whenever possible.
- Stay within this one step. Do not write the final report and do not update the plan.
- Finish with a concise finding and a short uncertainty list. Mention exact artifact IDs returned by tools.
- Do not ask follow-up questions.`
}

export function buildCriticalThinkingSynthesisPrompt(
  question: string,
  plan: Plan,
  findings: string[],
  evidencePacket: string
): string {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')
  return `Write the final Anodex Critical Thinking report from the verified evidence packet below.

Question:
${question}

Approved plan:
${steps}

Bounded step findings (navigation context; the evidence packet is authoritative):
${findings.map((finding) => `- ${finding}`).join('\n')}

Verified evidence packet:
${evidencePacket}

Report requirements:
- Use a descriptive title, a short executive summary, organized findings, and a clear conclusion or recommendation.
- Cite every material claim with exact internal markers such as [[S1]] or [[S1:P2]].
- Use only source and passage IDs present in the evidence packet. Never write a raw URL.
- Exact quotations must appear verbatim in a stored passage (Unicode punctuation and whitespace may normalize).
- When a quantitative comparison materially improves understanding, include an evidence-backed bar, line, or pie chart using a fenced chart block with strict JSON in this shape:
  \`\`\`chart
  {"type":"bar","title":"Descriptive title","labels":["A","B"],"datasets":[{"label":"Series","values":[12,18]}],"unit":"%","source":"[[S1:P2]]","note":"Optional context"}
  \`\`\`
- Use 2 to 12 labels and no more than 4 datasets. Pie charts require exactly one dataset, at most 8 labels, and non-negative values. Every chart value must be traceable to the cited source. Do not add a chart when the data is sparse, incomparable, or uncertain.
- Include a final "Sources" section containing only internal citation markers, plus a short "Limits and open questions" section.
- Never invent a source, quotation, statistic, date, or URL.`
}

export function buildCriticalThinkingRepairPrompt(
  draft: string,
  issues: string[],
  evidencePacket: string
): string {
  return `Repair this report so every validation issue is resolved. Preserve supported useful content, remove unsupported claims, use only [[S#]] or [[S#:P#]] citations from the evidence packet, and return only the complete repaired report.

Validation issues:
${issues.map((issue) => `- ${issue}`).join('\n')}

Evidence packet:
${evidencePacket}

Draft report:
${draft}`
}
