import { describe, expect, it } from 'vitest'
import { SKIP_DIRS, isSkippedDirectory } from '../skipDirectories'

describe('SKIP_DIRS across language ecosystems', () => {
  // The list began as a JavaScript list, and every walk in the app uses it. In a
  // Python project that meant `__pycache__` and a checked-in virtualenv were
  // walked, searched and shown to the model as if they were the user's work.
  it.each([
    ['__pycache__', 'Python bytecode'],
    ['.venv', 'Python virtualenv'],
    ['venv', 'Python virtualenv'],
    ['.pytest_cache', 'pytest'],
    ['.mypy_cache', 'mypy'],
    ['.ruff_cache', 'ruff'],
    ['.tox', 'tox'],
    ['target', 'Cargo and Maven build output'],
    ['vendor', 'Go and PHP vendored dependencies'],
    ['.gradle', 'Gradle'],
    ['obj', '.NET intermediate output'],
    ['Pods', 'CocoaPods']
  ])('skips %s (%s)', (name) => {
    expect(SKIP_DIRS.has(name)).toBe(true)
    expect(isSkippedDirectory(name, name)).toBe(true)
  })

  // A skip list hides code, so the risky names stay out of it. `bin` is a
  // build directory in .NET and a directory of hand-written scripts almost
  // everywhere else, and there is no way to tell which from the name alone.
  it.each(['bin', 'src', 'lib', 'app', 'test', 'tests', 'env', 'assets', 'public'])(
    'does not skip %s',
    (name) => {
      expect(SKIP_DIRS.has(name)).toBe(false)
    }
  )
})
