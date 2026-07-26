/**
 * The frame shares an origin only so its React owner can read the rendered
 * height. It still cannot execute scripts: `allow-scripts` is absent from the
 * sandbox and the generated CSP also declares `script-src 'none'`.
 */
export const EMAIL_FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox'

export function buildFrameDocument(
  html: string,
  options: { dark: boolean; showRemote: boolean }
): string {
  // `img-src` widens to remote hosts only after an explicit opt-in, and script
  // sources stay disallowed either way. `default-src 'none'` means anything not
  // named here — fetches, frames, fonts, media — is refused outright.
  const imgSrc = options.showRemote ? 'data: https: http:' : 'data:'
  const csp = [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "script-src 'none'"
  ].join('; ')

  const restoreRemote = options.showRemote
    ? `<style>img[data-remote-src]{visibility:visible}</style>`
    : ''

  const body = options.showRemote ? html.replace(/\sdata-remote-src=/gi, ' src=') : html

  const foreground = options.dark ? '#e8ebf0' : '#1a1d23'
  const muted = options.dark ? '#9aa3b2' : '#5b6472'
  const link = options.dark ? '#7aa7ff' : '#2f6fed'

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body {
    margin: 0;
    padding: 0;
    height: auto !important;
    min-height: 0 !important;
    background: transparent;
    color: ${foreground};
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
    overflow: hidden !important;
  }
  /* Email HTML is written for fixed-width desktop clients and will otherwise
     force horizontal scrolling inside the panel. */
  img, table, video { max-width: 100% !important; height: auto; }
  table { border-collapse: collapse; }
  a { color: ${link}; }
  blockquote {
    margin: 0 0 0 8px;
    padding-left: 12px;
    border-left: 2px solid ${muted};
    color: ${muted};
  }
  pre { white-space: pre-wrap; }
  /* A blocked remote image would otherwise show a broken-image glyph. */
  img[data-remote-src] { visibility: hidden; }
</style>
${restoreRemote}
</head>
<body>${body}</body>
</html>`
}
