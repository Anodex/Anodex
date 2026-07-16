import { app, BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ExportCriticalThinkingPdfRequest,
  ExportCriticalThinkingPdfResult
} from '@shared/criticalThinking.types'
import { err, ok, toErrorMessage } from '@shared/result'
import {
  buildCriticalThinkingPdfDocument,
  criticalThinkingPdfFilename
} from './criticalThinkingPdfDocument'

const MAX_REPORT_HTML_LENGTH = 5_000_000

function validateRequest(request: ExportCriticalThinkingPdfRequest): string | null {
  if (!request || typeof request.question !== 'string' || !request.question.trim()) {
    return 'The report question is missing.'
  }
  if (typeof request.reportHtml !== 'string' || !request.reportHtml.trim()) {
    return 'The report content is missing.'
  }
  if (request.reportHtml.length > MAX_REPORT_HTML_LENGTH) {
    return 'The rendered report is too large to export.'
  }
  return null
}

export async function exportCriticalThinkingPdf(
  parent: BrowserWindow | null,
  request: ExportCriticalThinkingPdfRequest
): Promise<ExportCriticalThinkingPdfResult> {
  const invalid = validateRequest(request)
  if (invalid) return err('critical-thinking.invalid-pdf-request', invalid)

  let printWindow: BrowserWindow | null = null

  try {
    const options = {
      title: 'Export Critical Thinking report',
      defaultPath: join(app.getPath('documents'), criticalThinkingPdfFilename(request.question)),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }]
    }
    const selection = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (selection.canceled || !selection.filePath) return ok(null)

    const filePath = selection.filePath.toLowerCase().endsWith('.pdf')
      ? selection.filePath
      : `${selection.filePath}.pdf`
    printWindow = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: false
      }
    })
    const html = buildCriticalThinkingPdfDocument(request)
    await printWindow.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
    const pdf = await printWindow.webContents.printToPDF({
      pageSize: 'A4',
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#7b8495;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    })
    await writeFile(filePath, pdf)
    return ok(filePath)
  } catch (error) {
    return err(
      'critical-thinking.pdf-export-failed',
      'Could not create the PDF report.',
      toErrorMessage(error)
    )
  } finally {
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy()
  }
}
