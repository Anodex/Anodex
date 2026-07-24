const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/webp': 'webp'
}

export function imageDownloadName(title: string, dataUrl: string): string {
  const mimeType = /^data:([^;,]+)/.exec(dataUrl)?.[1].toLowerCase() ?? 'image/png'
  const extension = IMAGE_EXTENSIONS[mimeType] ?? 'png'
  const cleaned =
    Array.from(title)
      .map((character) =>
        character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character
      )
      .join('')
      .trim() || 'image'
  const withoutExtension = cleaned.replace(/\.[^.]+$/, '')
  return `${withoutExtension}.${extension}`
}

export async function copyImageToClipboard(dataUrl: string): Promise<void> {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}

export function saveImageDownload(dataUrl: string, title: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = imageDownloadName(title, dataUrl)
  link.click()
}
