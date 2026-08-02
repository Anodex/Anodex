// Generates platform app icons (build/icon.ico, .icns, .png) from the
// dedicated app-icon artwork (src/renderer/assets/app-icon.png), which already
// has its own faceted rounded-square backdrop baked in. Re-run this whenever
// that source artwork changes — the outputs are checked in under build/ since
// electron-builder reads them directly at package time.
//
// Note: this is deliberately a separate source from title-logo.png (the bare
// glyph used in-app for the title bar/toast) — the OS-level icon needs a
// solid backdrop to stay legible on the taskbar/Start menu, but the in-app
// mark already sits on the app's own dark chrome and doesn't want one.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import png2icons from 'png2icons'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(rootDir, 'src/renderer/assets/app-icon.png')
const glyphSourcePath = join(rootDir, 'src/renderer/assets/title-logo.png')
const buildDir = join(rootDir, 'build')
// Shipped via electron-builder's `extraResources`, unlike build/ — the main
// process needs the bare glyph at runtime for framed secondary windows (see
// `brandGlyphIcon` in src/main/window.ts), which build/ can't provide.
const brandDir = join(rootDir, 'resources/brand')

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const MASTER_SIZE = 1024
const LINUX_ICON_SIZE = 512
const GLYPH_ICON_SIZE = 256

async function main() {
  await mkdir(buildDir, { recursive: true })

  const master = await sharp(sourcePath)
    .resize(MASTER_SIZE, MASTER_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer()

  const icoInputs = await Promise.all(
    ICO_SIZES.map((size) => sharp(master).resize(size, size).png().toBuffer())
  )
  const ico = await pngToIco(icoInputs)
  await writeFile(join(buildDir, 'icon.ico'), ico)
  console.log('wrote build/icon.ico')

  const icns = png2icons.createICNS(master, png2icons.BICUBIC2, 0)
  if (!icns) throw new Error('png2icons failed to generate icon.icns')
  await writeFile(join(buildDir, 'icon.icns'), icns)
  console.log('wrote build/icon.icns')

  const linuxPng = await sharp(master).resize(LINUX_ICON_SIZE, LINUX_ICON_SIZE).png().toBuffer()
  await writeFile(join(buildDir, 'icon.png'), linuxPng)
  console.log('wrote build/icon.png')

  // The bare glyph, for windows Anodex opens with native OS chrome (the HTML
  // preview pop-out). Those sit next to the main window's own title bar, which
  // draws this same mark — the backdropped tile above would read as a
  // different logo there, even though it's the right choice for the taskbar.
  await mkdir(brandDir, { recursive: true })
  const glyph = await sharp(glyphSourcePath)
    .resize(GLYPH_ICON_SIZE, GLYPH_ICON_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer()
  await writeFile(join(brandDir, 'title-logo.png'), glyph)
  console.log('wrote resources/brand/title-logo.png')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
