import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { rm } from 'node:fs/promises'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type { ModelLoadOptions } from '@shared/model.types'
import type { RecommendedModel } from '@shared/recommendedModels'
import { llamaService } from '../llama/LlamaService'
import { clearLoadRecovery, getLoadRecovery } from '../llama/loadSentinel'
import { describeModel, isVisionProjectorFileName, scanModels } from '../llama/modelScanner'
import { cancelDownload, downloadModel } from '../llama/modelDownloader'
import { searchHuggingFaceModels, fetchTopModels } from '../models/huggingFaceCatalog'
import { modelReliabilityStore } from '../models/ModelReliabilityStore'
import { settingsStore } from '../settings/SettingsStore'
import { sendToWindow } from '../broadcast'
import { getHardware } from './system.handlers'

/** IPC handlers for discovering, adding, and (un)loading local models. */
export function registerModelHandlers(): void {
  ipcMain.handle(IpcChannel.Models.list, () => {
    try {
      return ok(scanModels())
    } catch (error) {
      return err('models.scan-failed', 'Could not read local models.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Models.add, async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: OpenDialogOptions = {
        title: 'Add a local model',
        properties: ['openFile'],
        filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
      }
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)

      if (picked.canceled || picked.filePaths.length === 0) return ok(null)

      const path = picked.filePaths[0]
      const info = describeModel(path)
      if (!info) return err('models.invalid-file', 'That file could not be read as a model.')

      const settings = settingsStore.get()
      if (!settings.addedModelPaths.includes(path)) {
        settingsStore.update({ addedModelPaths: [...settings.addedModelPaths, path] })
      }
      return ok(info)
    } catch (error) {
      return err('models.add-failed', 'Could not add the model.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Models.addVisionProjector, async (event, modelPath: string) => {
    try {
      const model = describeModel(modelPath)
      if (!model) return err('models.not-found', 'The selected model file no longer exists.')

      const win = BrowserWindow.fromWebContents(event.sender)
      const options: OpenDialogOptions = {
        title: `Add vision projector for ${model.name}`,
        properties: ['openFile'],
        filters: [{ name: 'llama.cpp vision projectors', extensions: ['gguf'] }]
      }
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (picked.canceled || picked.filePaths.length === 0) return ok(null)

      const projectorPath = picked.filePaths[0]
      if (!isVisionProjectorFileName(projectorPath)) {
        return err(
          'models.invalid-projector',
          'That GGUF does not look like a vision projector. Choose the matching mmproj file.'
        )
      }

      const settings = settingsStore.get()
      settingsStore.update({
        visionProjectorPaths: {
          ...settings.visionProjectorPaths,
          [modelPath]: projectorPath
        }
      })
      return ok(describeModel(modelPath))
    } catch (error) {
      return err(
        'models.projector-add-failed',
        'Could not add the vision projector.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Models.load, async (_event, options: ModelLoadOptions) => {
    try {
      const info = describeModel(options.path)
      if (!info) return err('models.not-found', 'The selected model file no longer exists.')
      const state = await llamaService.loadModel(
        { ...options, visionProjectorPath: info.visionProjectorPath },
        info
      )
      settingsStore.update({ lastModelPath: options.path })
      return ok(state)
    } catch (error) {
      return err('models.load-failed', 'Failed to load the model.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Models.unload, async () => {
    try {
      return ok(await llamaService.unload())
    } catch (error) {
      return err('models.unload-failed', 'Failed to unload the model.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Models.delete, async (_event, path: string) => {
    try {
      if (llamaService.getState().model?.path === path) {
        await llamaService.unload()
      }
      await rm(path, { force: true })

      const settings = settingsStore.get()
      if (
        settings.addedModelPaths.includes(path) ||
        settings.lastModelPath === path ||
        settings.visionProjectorPaths[path]
      ) {
        // `null` is the removal sentinel: patches are deep-merged, so passing a
        // copy with the key deleted (or `lastModelPath: undefined`) would leave
        // the stale entries in place forever.
        settingsStore.update({
          addedModelPaths: settings.addedModelPaths.filter((p) => p !== path),
          lastModelPath: settings.lastModelPath === path ? null : settings.lastModelPath,
          visionProjectorPaths: { [path]: null }
        })
      }
      return ok(null)
    } catch (error) {
      return err('models.delete-failed', 'Could not delete the model file.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Models.getState, () => llamaService.getState())

  ipcMain.handle(IpcChannel.Models.download, async (event, model: RecommendedModel) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const downloaded = await downloadModel(
        model,
        settingsStore.get().modelsDirectory,
        (progress) => {
          if (win) sendToWindow(win, IpcChannel.Models.downloadProgress, progress)
        }
      )
      if (downloaded.visionProjectorPath) {
        const settings = settingsStore.get()
        settingsStore.update({
          visionProjectorPaths: {
            ...settings.visionProjectorPaths,
            [downloaded.modelPath]: downloaded.visionProjectorPath
          }
        })
      }
      const info = describeModel(downloaded.modelPath)
      if (!info) {
        return err('models.download-invalid', 'Downloaded file could not be read as a model.')
      }
      return ok(info)
    } catch (error) {
      return err('models.download-failed', 'Failed to download the model.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Models.cancelDownload, (_event, modelId: string) => {
    cancelDownload(modelId)
  })

  ipcMain.handle(IpcChannel.Models.getReliability, () => {
    try {
      return ok(modelReliabilityStore.getAll())
    } catch (error) {
      return err(
        'models.reliability-failed',
        'Could not read model reliability data.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Models.recommendSettings, async (_event, path: string) => {
    try {
      const hardware = await getHardware()
      const recommendation = await llamaService.recommendSettingsForFile(path, {
        ramBytes: hardware.ramBytes,
        vramBytes: hardware.vramBytes,
        unified: hardware.unifiedMemory
      })
      return ok(recommendation)
    } catch (error) {
      return err(
        'models.recommend-failed',
        'Could not analyze this model file.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Models.discover, (_event, query: string) =>
    searchHuggingFaceModels(query)
  )

  ipcMain.handle(IpcChannel.Models.fetchTopModels, () => fetchTopModels())

  // Reads an in-memory value captured at startup, so unlike its neighbours
  // there is nothing here that can fail — no Result wrapper, same as getState.
  ipcMain.handle(IpcChannel.Models.getLoadRecovery, () => getLoadRecovery())

  ipcMain.handle(IpcChannel.Models.dismissLoadRecovery, () => clearLoadRecovery())
}
