/**
 * What `electron` resolves to under Vitest (see `vitest.config.mjs`).
 *
 * Unit tests run in plain Node, where the `electron` npm package is not the
 * Electron API: it exports the path of the Electron binary, so `app`, `ipcMain`
 * and the rest import as `undefined`. Tests that need them mock `electron`
 * themselves, and those mocks still apply to this module.
 *
 * Resolving the real package was not free, though. When its binary is missing,
 * Electron 43's `index.js` downloads and unpacks one at import time. A test file
 * that reaches `electron` through ordinary source imports (the vision service
 * reaches it through the file tools and the project memory store) then started a
 * download, and the test workers that did so at once raced to unpack into the
 * same folder: "uk.pak: File exists", then "Electron failed to install
 * correctly", and a whole test file failed to load. It struck a different file
 * each time, on whichever runner's install had gone wrong.
 *
 * This is the path string with no download behind it, so a test sees what it
 * always saw and never touches the network.
 */
const electronBinaryPath = ''

export default electronBinaryPath
