import { describe, expect, it } from 'vitest'
import { isTextFile } from '../textFileExtensions'

describe('isTextFile across ecosystems', () => {
  // Anything this returns false for is silently invisible to search_files and
  // is never indexed, so a whole language can look like an empty project.
  it.each([
    'App.swift',
    'main.dart',
    'init.lua',
    'Service.scala',
    'app.ex',
    'worker.exs',
    'core.clj',
    'Main.hs',
    'parser.ml',
    'Program.fs',
    'model.jl',
    'server.nim',
    'build.zig',
    'analysis.r',
    'legacy.f90',
    'View.mm',
    'Handler.groovy',
    'build.gradle',
    'build.sbt',
    'script.pl',
    'main.tcl',
    'Form.vb',
    'unit.pas'
  ])('treats %s as text', (name) => {
    expect(isTextFile(name)).toBe(true)
  })

  it.each([
    'main.tf',
    'vars.tfvars',
    'cluster.hcl',
    'user.proto',
    'schema.graphql',
    'query.gql',
    'CMakeLists.cmake',
    'rules.mk',
    'setup.bat',
    'run.cmd',
    'profile.zsh',
    'config.fish',
    'app.cfg',
    'nginx.conf',
    'app.properties',
    'data.tsv',
    'log.ndjson',
    'guide.rst',
    'notes.adoc',
    'paper.tex',
    'default.nix',
    'BUILD.bzl'
  ])('treats %s as text', (name) => {
    expect(isTextFile(name)).toBe(true)
  })

  // Extensionless files that are unmistakably source. The regex requires a dot,
  // so every one of these was invisible.
  it.each([
    'Makefile',
    'Dockerfile',
    'Gemfile',
    'Rakefile',
    'Procfile',
    'Jenkinsfile',
    'Vagrantfile',
    '.gitignore',
    '.dockerignore',
    '.gitattributes',
    '.editorconfig',
    'LICENSE',
    'README'
  ])('treats %s as text', (name) => {
    expect(isTextFile(name)).toBe(true)
  })

  it('still works on a full path, not just a bare name', () => {
    expect(isTextFile('src/deep/nested/App.swift')).toBe(true)
    expect(isTextFile('C:\\Users\\me\\project\\Makefile')).toBe(true)
  })

  it.each(['logo.png', 'clip.mp4', 'font.woff2', 'app.exe', 'lib.so', 'photo.jpeg', 'archive.zip'])(
    'does not treat %s as text',
    (name) => {
      expect(isTextFile(name)).toBe(false)
    }
  )

  it('keeps the languages it already handled', () => {
    for (const name of [
      'a.py',
      'b.go',
      'c.rs',
      'd.java',
      'e.cpp',
      'f.cs',
      'g.php',
      'h.sh',
      'i.ts'
    ]) {
      expect(isTextFile(name)).toBe(true)
    }
  })
})
