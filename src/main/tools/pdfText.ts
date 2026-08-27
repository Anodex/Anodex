/**
 * Reading a PDF's text layer.
 *
 * Shared by email attachments and web research: both need the same parser with
 * the same hardening, and the alternative was for `web_fetch` to keep dropping
 * every PDF it was handed. Measured on a live research run, that discarded the
 * MIT, Harvard and Stanford sources it had found -- the scholarly class the
 * source ranker rates highest -- while keeping the marketing blogs alongside
 * them, because those happened to be HTML.
 */

/** How many pages are worth walking before a character cap makes the rest moot. */
export const DEFAULT_MAX_PDF_PAGES = 50

export interface PdfTextLimits {
  maxPages?: number
  maxChars?: number
}

/**
 * Extract a PDF's text layer with pdf.js.
 *
 * Loaded through a dynamic `import()` because the package is ESM-only and the
 * main process is CommonJS -- the same arrangement `node-llama-cpp` uses. The
 * worker is disabled and `isEvalSupported` turned off: this runs in the main
 * process against a file that arrived from a stranger, by email or over the
 * open web, so it gets the most restricted parser configuration pdf.js offers.
 *
 * Throws when the document has no text layer, which for a PDF means a scan.
 */
export async function extractPdfText(
  data: Uint8Array,
  { maxPages = DEFAULT_MAX_PDF_PAGES, maxChars = Number.POSITIVE_INFINITY }: PdfTextLimits = {}
): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const document = await pdfjs.getDocument({
    // Copied because pdf.js takes ownership of the buffer it is handed and
    // detaches it; the caller still needs its own bytes afterwards.
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false
  }).promise

  try {
    const pages: string[] = []
    const pageCount = Math.min(document.numPages, maxPages)
    let length = 0
    for (let pageNumber = 1; pageNumber <= pageCount && length < maxChars; pageNumber++) {
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim()
        if (text) {
          pages.push(text)
          length += text.length
        }
      } finally {
        page.cleanup()
      }
    }

    if (pages.length === 0) {
      throw new Error(
        'That PDF has no text layer — it is most likely a scan. It would need OCR to read.'
      )
    }

    // Blank line between pages so paragraph-splitting downstream sees a break
    // at the page boundary rather than running two pages into one passage.
    return pages.join('\n\n')
  } finally {
    await document.destroy()
  }
}
