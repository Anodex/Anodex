import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import sharp from 'sharp'

const ROOT = resolve(import.meta.dirname, '..')
const ART_DIR = resolve(ROOT, 'build', 'installer')
const BACKGROUND = resolve(ART_DIR, 'installer-soul.png')
const APP_ICON = resolve(ROOT, 'src', 'renderer', 'assets', 'app-icon.png')
const COMET_FRAMES = 24

async function writeBmp(image, output) {
  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const rowBytes = info.width * 3
  const stride = Math.ceil(rowBytes / 4) * 4
  const pixelBytes = stride * info.height
  const header = Buffer.alloc(54)

  header.write('BM')
  header.writeUInt32LE(54 + pixelBytes, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(info.width, 18)
  header.writeInt32LE(info.height, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(pixelBytes, 34)
  header.writeInt32LE(2835, 38)
  header.writeInt32LE(2835, 42)

  const pixels = Buffer.alloc(pixelBytes)
  for (let y = 0; y < info.height; y += 1) {
    const sourceRow = info.height - 1 - y
    for (let x = 0; x < info.width; x += 1) {
      const source = (sourceRow * info.width + x) * 3
      const target = y * stride + x * 3
      pixels[target] = data[source + 2]
      pixels[target + 1] = data[source + 1]
      pixels[target + 2] = data[source]
    }
  }

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, Buffer.concat([header, pixels]))
}

async function createArtwork({ width, height, iconSize, iconTop, output }) {
  const artwork = sharp(BACKGROUND).resize(width, height, { fit: 'cover', position: 'centre' })
  if (iconSize > 0) {
    const icon = await sharp(APP_ICON).resize(iconSize, iconSize).png().toBuffer()
    artwork.composite([{ input: icon, left: Math.round((width - iconSize) / 2), top: iconTop }])
  }

  await writeBmp(artwork, output)
}

async function createCometFrame(index) {
  const size = 64
  const angle = (index / COMET_FRAMES) * 360
  const icon = await sharp(APP_ICON).resize(38, 38).png().toBuffer()
  const comet = Buffer.from(`
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="comet" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#38bdf8" />
          <stop offset="0.55" stop-color="#5978ff" />
          <stop offset="1" stop-color="#9a65ff" />
        </linearGradient>
        <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g transform="rotate(${angle} ${size / 2} ${size / 2})">
        <circle cx="${size / 2}" cy="${size / 2}" r="26" fill="none" stroke="#1f2b50" stroke-width="1" />
        <path d="M ${size / 2} 6 A 26 26 0 0 1 57 25" fill="none" stroke="url(#comet)" stroke-linecap="round" stroke-width="2.5" filter="url(#glow)" />
        <circle cx="${size / 2}" cy="6" r="3" fill="#8b5cf6" filter="url(#glow)" />
      </g>
    </svg>
  `)
  const frame = sharp({
    create: { width: size, height: size, channels: 3, background: '#0a1024' }
  }).composite([
    { input: comet, top: 0, left: 0 },
    { input: icon, top: 13, left: 13 }
  ])

  await writeBmp(frame, resolve(ART_DIR, `installer-comet-${String(index).padStart(2, '0')}.bmp`))
}

await createArtwork({
  width: 164,
  height: 314,
  iconSize: 88,
  iconTop: 22,
  output: resolve(ART_DIR, 'installer-sidebar.bmp')
})
await createArtwork({
  width: 150,
  height: 57,
  iconSize: 42,
  iconTop: 8,
  output: resolve(ART_DIR, 'installer-header.bmp')
})
await createArtwork({
  width: 490,
  height: 314,
  iconSize: 0,
  iconTop: 0,
  output: resolve(ART_DIR, 'installer-page.bmp')
})
await Promise.all(Array.from({ length: COMET_FRAMES }, (_, index) => createCometFrame(index)))
