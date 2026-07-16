import type { ExportCriticalThinkingPdfRequest } from '@shared/criticalThinking.types'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function criticalThinkingPdfFilename(question: string): string {
  const slug = question
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .toLowerCase()
  return `${slug || 'critical-thinking-report'}.pdf`
}

/** Build the isolated, script-free document Chromium prints to PDF. */
export function buildCriticalThinkingPdfDocument(
  request: ExportCriticalThinkingPdfRequest
): string {
  const question = escapeHtml(request.question.trim())
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${question} - Critical Thinking</title>
  <style>
    @page { size: A4; margin: 17mm 16mm 19mm; }
    * { box-sizing: border-box; }
    html { color: #172033; background: #fff; font-family: Inter, Aptos, "Segoe UI", Arial, sans-serif; }
    body { margin: 0; font-size: 10.5pt; line-height: 1.62; }
    .pdf-brand { margin-bottom: 7mm; padding-bottom: 4mm; border-bottom: 1px solid #dce2ec; }
    .pdf-brand-label { margin: 0 0 1.5mm; color: #5e55c7; font-size: 8pt; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
    .pdf-question { margin: 0; color: #59657a; font-size: 9.5pt; line-height: 1.45; }
    [data-critical-thinking-report] { overflow-wrap: anywhere; }
    h1, h2, h3, h4 { color: #111827; line-height: 1.24; break-after: avoid; }
    h1 { margin: 0 0 5mm; font-size: 22pt; }
    h2 { margin: 8mm 0 3mm; padding-bottom: 2mm; font-size: 16pt; border-bottom: 1px solid #dce2ec; }
    h3 { margin: 6mm 0 2mm; font-size: 12.5pt; }
    h4 { margin: 4mm 0 2mm; font-size: 10.5pt; }
    p { margin: 0 0 3.5mm; }
    ul, ol { margin: 0 0 4mm; padding-left: 6mm; }
    li { margin-bottom: 1mm; }
    a { color: #4f46b8; text-decoration: underline; text-underline-offset: 1px; }
    code { font-family: Consolas, "Cascadia Mono", monospace; font-size: 8.8pt; }
    :not(pre) > code { padding: 0 .8mm; background: #f2f4f8; border: 1px solid #dce2ec; border-radius: 2px; }
    pre { margin: 0 0 4mm; padding: 4mm; overflow-wrap: anywhere; white-space: pre-wrap; background: #f5f7fa; border: 1px solid #dce2ec; border-radius: 5px; }
    blockquote { margin: 0 0 4mm; padding: 3mm 4mm; color: #59657a; background: #f5f7fa; border-left: 3px solid #7067d8; }
    table { width: 100%; margin: 0 0 5mm; border-collapse: collapse; font-size: 9pt; }
    th, td { padding: 2.2mm 2.8mm; text-align: left; vertical-align: top; border: 1px solid #dce2ec; }
    th { color: #172033; font-weight: 650; background: #f2f4f8; }
    tr { break-inside: avoid; }
    [data-critical-thinking-chart] { margin: 5mm 0 6mm; padding: 4mm; color: #172033; background: #fafbfe; border: 1px solid #dce2ec; border-radius: 6px; break-inside: avoid; }
    [data-chart-title] { margin: 0 0 2mm; font-size: 12pt; }
    [data-critical-thinking-chart] svg { display: block; width: 100%; height: auto; max-height: 112mm; color: #59657a; }
    [data-critical-thinking-chart] svg text { font-family: Inter, Aptos, "Segoe UI", Arial, sans-serif; }
    [data-chart-caption] { margin: 2mm 0 0; color: #667085; font-size: 8.5pt; line-height: 1.4; }
  </style>
</head>
<body>
  <header class="pdf-brand">
    <p class="pdf-brand-label">Anodex / Critical Thinking</p>
    <p class="pdf-question">${question}</p>
  </header>
  ${request.reportHtml}
</body>
</html>`
}
