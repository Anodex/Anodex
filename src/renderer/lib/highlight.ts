import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import xml from 'highlight.js/lib/languages/xml'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import sql from 'highlight.js/lib/languages/sql'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import csharp from 'highlight.js/lib/languages/csharp'
import cpp from 'highlight.js/lib/languages/cpp'
import php from 'highlight.js/lib/languages/php'
import ruby from 'highlight.js/lib/languages/ruby'
import powershell from 'highlight.js/lib/languages/powershell'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import ini from 'highlight.js/lib/languages/ini'
import diff from 'highlight.js/lib/languages/diff'
import graphql from 'highlight.js/lib/languages/graphql'

/**
 * `highlight.js` core with a curated set of registered languages, rather than
 * the full ~190-language bundle — keeps the renderer bundle small while
 * covering everything a coding assistant is likely to produce. Add a language
 * here (and its alias below) if the model regularly emits a fence we don't
 * recognize yet.
 */
const LANGUAGES: Record<string, LanguageFn> = {
  typescript,
  javascript,
  xml,
  json,
  python,
  bash,
  css,
  yaml,
  markdown,
  sql,
  go,
  rust,
  java,
  csharp,
  cpp,
  php,
  ruby,
  powershell,
  dockerfile,
  ini,
  diff,
  graphql
}

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language)
}

/** Common fence names that don't match their hljs registration name. */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  cs: 'csharp',
  'c++': 'cpp',
  c: 'cpp',
  rb: 'ruby',
  ps1: 'powershell',
  toml: 'ini',
  dockerfile: 'dockerfile',
  docker: 'dockerfile'
}

function resolveLanguage(language: string | undefined): string | null {
  if (!language) return null
  const normalized = language.toLowerCase()
  const resolved = ALIASES[normalized] ?? normalized
  return hljs.getLanguage(resolved) ? resolved : null
}

export interface HighlightResult {
  html: string
  /** The language actually used, which may differ from the requested fence tag. */
  language: string | null
}

/**
 * Highlight a code block to HTML, escaping unrecognized content instead of
 * throwing. `highlight.js` always HTML-escapes the source text before
 * wrapping it in `<span>` tokens, so the returned markup is safe to render
 * with `dangerouslySetInnerHTML` even though the source is model-generated.
 */
export function highlightCode(code: string, language?: string): HighlightResult {
  const resolved = resolveLanguage(language)
  if (resolved) {
    try {
      const result = hljs.highlight(code, { language: resolved, ignoreIllegals: true })
      return { html: result.value, language: resolved }
    } catch {
      // Fall through to auto-detect/escape below.
    }
  }

  try {
    const auto = hljs.highlightAuto(code, Object.keys(LANGUAGES))
    if (auto.language) return { html: auto.value, language: auto.language }
  } catch {
    // Fall through to escape below.
  }

  return { html: escapeHtml(code), language: null }
}

/** Best-effort language hint for `highlightCode`, from a file's extension. */
export function languageForFileName(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return undefined
  return fileName.slice(dot + 1).toLowerCase()
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
