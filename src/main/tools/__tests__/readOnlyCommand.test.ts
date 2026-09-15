import { describe, expect, it } from 'vitest'
import { isReadOnlyCommand } from '../readOnlyCommand'

describe('isReadOnlyCommand', () => {
  it('recognises the looking a build does', () => {
    for (const command of [
      'Get-ChildItem',
      'Get-ChildItem -Recurse -Filter *.html | Select-Object Name, Length | Format-Table',
      'Get-Content utils.js -TotalCount 40',
      'Select-String -Path *.js -Pattern "export"',
      'dir /s /b *.css',
      'ls -la',
      'cat index.html | head -n 20',
      'grep -rn "gallery" .',
      'rg -n modal',
      'git status',
      'git diff --stat',
      'git log --oneline -5',
      'node --check blog.js',
      'node --version',
      'find . -name "*.js"',
      'tree /f'
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true)
    }
  })

  it('does not recognise anything that can change or run something', () => {
    for (const command of [
      'node tests.js',
      'npm test',
      'Remove-Item notes.txt',
      'Get-ChildItem | Remove-Item',
      'Get-Content a.txt > b.txt',
      'echo hi >> notes.txt',
      'dir; del notes.txt',
      'ls && rm -r dist',
      'cat a | tee b',
      'git commit -m "wip"',
      'git checkout main',
      'git diff --output=patch.txt',
      'git -c alias.status=!rm status',
      'find . -name "*.tmp" -delete',
      'find . -exec rm {} ;',
      'sort -o out.txt in.txt',
      // Script blocks and subexpressions run code.
      "Get-ChildItem | Select-Object Name, @{n='Lines';e={(Get-Content $_.Name).Count}}",
      'Get-ChildItem | Where-Object { $_.Length -gt 0 }',
      'Get-Item $(Remove-Item x)',
      'Get-ChildItem (Remove-Item x)',
      'echo `whoami`',
      'powershell -c "Get-ChildItem"',
      '',
      '   '
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false)
    }
  })
})
