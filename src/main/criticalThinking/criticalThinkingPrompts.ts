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

export function buildCriticalThinkingResearchPrompt(question: string, plan: Plan): string {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')
  return `You are running Anodex Critical Thinking: an independent, evidence-first investigation.

Question:
${question}

Approved research plan — follow it and use update_plan_step as work advances:
${steps}

Research requirements:
- Use web_search repeatedly with focused, varied queries; do not rely on a single result page.
- Open promising sources with fetch_url and prefer primary, official, recent, and directly relevant evidence.
- Cross-check important claims across independent sources. Surface disagreements, weak evidence, and uncertainty.
- Treat snippets as leads, not proof. Base material claims on pages you actually inspect whenever possible.
- Do not ask follow-up questions. Make reasonable assumptions and state any that materially affect the answer.
- Keep narration before the deliverable minimal. Finish with one self-contained, useful report.

Report requirements:
- Use a descriptive title, a short executive summary, organized findings, and a clear conclusion or recommendation.
- Cite claims inline with clickable Markdown links in the form [Source title](https://example.com/page).
- When a quantitative comparison materially improves understanding, include an evidence-backed bar, line, or pie chart using a fenced chart block with strict JSON in this shape:
  \`\`\`chart
  {"type":"bar","title":"Descriptive title","labels":["A","B"],"datasets":[{"label":"Series","values":[12,18]}],"unit":"%","source":"[Source title](https://example.com/data)","note":"Optional context"}
  \`\`\`
- Use 2 to 12 labels and no more than 4 datasets. Pie charts require exactly one dataset, at most 8 labels, and non-negative values. Every chart value must be traceable to the cited source. Do not add a chart when the data is sparse, incomparable, or uncertain.
- Include a final "Sources" section listing the most important sources, plus a short "Limits and open questions" section.
- Never invent a source, quotation, statistic, date, or URL.`
}
