import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { WorkspaceToolFactory } from './types'
import { runGuardedToolWithPrepare } from './helpers'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { assertPublicDns, assertPublicUrl } from './webTools'
import { downloadFile } from '../llama/modelDownloader'
import { freeBytesAt } from '../utils/diskSpace'
import { formatBytes } from '@shared/format'

/** Hops followed before the download starts; each one is checked like the first. */
const MAX_REDIRECTS = 5
/** Asking where a file lives should not take longer than this. */
const HEAD_TIMEOUT_MS = 15_000
/** How often the running card's progress line is redrawn. */
const PROGRESS_INTERVAL_MS = 500
/** Room left on the disk after the file, so a download never fills it. */
const DISK_HEADROOM_BYTES = 512 * 1024 ** 2

interface PreparedDownload {
  url: string
  target: string
  relative: string
  sizeBytes: number | null
}

/**
 * download_file — fetch a file from the web into the project folder: a
 * server .jar, an installer, a dataset.
 *
 * Says what it is, where it comes from and how big it is before asking, then
 * shows its progress while it runs. Every hop of a redirect is checked against
 * the same public-address rule `fetch_url` uses, so a link cannot bounce a
 * download onto the local network. Interrupted downloads resume, as model
 * downloads do. The file is saved, never run.
 */
export const downloadFileTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Download a file from the web into the project folder (an installer, a server .jar, an archive, a dataset). Shows the size first and resumes if interrupted. Use fetch_url to read a web page instead. The file is saved, not run.',
    params: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) address of the file.' },
        path: {
          type: 'string',
          description:
            "Where to save it, relative to the project folder. Defaults to the file's own name in the project folder."
        }
      },
      required: ['url']
    } as const,
    handler: (args: { url: string; path?: string }) =>
      runGuardedToolWithPrepare<PreparedDownload>(
        ctx,
        {
          name: 'download_file',
          kind: 'write',
          title: `Download ${shortName(args.url)}`,
          args,
          risk: 'sensitive'
        },
        async () => {
          const signal = ctx.signal ?? new AbortController().signal
          const { url, sizeBytes, fileName } = await locate(args.url, signal)
          const target = resolveInWorkspace(ctx.workspaceRoot, args.path?.trim() || fileName)
          const relative = toWorkspaceRelative(ctx.workspaceRoot, target)
          const free = freeBytesAt(dirname(target))
          if (sizeBytes !== null && free !== null && sizeBytes + DISK_HEADROOM_BYTES > free) {
            throw new Error(
              `${fileName} is ${formatBytes(sizeBytes)} and the disk has ${formatBytes(free)} free. Free some space first.`
            )
          }
          const host = new URL(url).hostname
          return {
            confirmDetail: `Download ${fileName}${sizeBytes !== null ? ` (${formatBytes(sizeBytes)})` : ''} from ${host} into ${relative}`,
            data: { url, target, relative, sizeBytes }
          }
        },
        async (download, progress) => {
          let lastReport = 0
          await downloadFile(
            download.url,
            download.target,
            ctx.signal ?? new AbortController().signal,
            (received, total) => {
              const now = Date.now()
              if (now - lastReport < PROGRESS_INTERVAL_MS) return
              lastReport = now
              progress?.(
                total ? `${formatBytes(received)} of ${formatBytes(total)}` : formatBytes(received)
              )
            }
          )
          const size = (await stat(download.target)).size
          return {
            modelResult: `Downloaded ${download.relative} (${formatBytes(size)}) from ${download.url}.`,
            detail: formatBytes(size)
          }
        }
      )
  })

/**
 * Follow redirects one hop at a time, checking each against the public-address
 * rule, and learn the file's size and name. A server that refuses HEAD still
 * gets downloaded; it just cannot say its size in advance.
 */
async function locate(
  raw: string,
  signal: AbortSignal
): Promise<{ url: string; sizeBytes: number | null; fileName: string }> {
  let current = assertPublicUrl(raw.trim())
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicDns(current, signal)
    let response: Response
    try {
      response = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(HEAD_TIMEOUT_MS)])
      })
    } catch {
      return { url: current.toString(), sizeBytes: null, fileName: nameFromUrl(current) }
    }
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      current = assertPublicUrl(new URL(location, current).toString())
      continue
    }
    if (response.status === 404 || response.status === 410) {
      throw new Error(`Nothing is there (HTTP ${response.status}): ${current.toString()}`)
    }
    const length = Number(response.headers.get('content-length'))
    return {
      url: current.toString(),
      sizeBytes: response.ok && Number.isFinite(length) && length > 0 ? length : null,
      fileName:
        nameFromDisposition(response.headers.get('content-disposition')) ?? nameFromUrl(current)
    }
  }
  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`)
}

/** A safe file name from the URL's last path segment. */
function nameFromUrl(url: URL): string {
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
  return safeFileName(last) || 'download'
}

function nameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)
  const plain = /filename="?([^";]+)"?/i.exec(header)
  const raw = star ? decodeURIComponent(star[1].trim()) : plain?.[1].trim()
  return raw ? safeFileName(raw) || null : null
}

/** Strip any path a server put in the name, and characters no file system allows. */
export function safeFileName(name: string): string {
  return (
    [...basename(name.replace(/\\/g, '/'))]
      // Control characters, and the ones Windows refuses in a file name.
      .map((char) => (char.charCodeAt(0) < 32 || '<>:"|?*'.includes(char) ? '_' : char))
      .join('')
      .replace(/^\.+/, '')
      .slice(0, 200)
  )
}

function shortName(url: string): string {
  try {
    return nameFromUrl(new URL(url))
  } catch {
    return 'a file'
  }
}
