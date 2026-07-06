import { useSettingsStore } from '../stores/settingsStore'
import { anodex } from './anodex'

/**
 * Whether a desktop toast would actually be shown right now. Exported
 * separately (not just baked into `notifyDesktop`) so a caller can check
 * this *before* doing extra work to build a nicer toast body — e.g.
 * `chatStore.ts` only bothers asking the model for a short summary when a
 * toast will actually be shown, since that summary is otherwise wasted work.
 */
export function shouldShowDesktopToast(): boolean {
  if (!useSettingsStore.getState().settings?.general.desktopNotifications) return false
  // The whole point of a desktop toast is reaching someone who's stepped
  // away — showing one while they're already looking at the reply would
  // just be noise.
  return !document.hasFocus()
}

/**
 * Desktop toast for the `general.desktopNotifications` setting. Shown via a
 * dedicated, always-on-top `BrowserWindow` the main process fully controls
 * (see `main/toastWindow.ts`) rather than the OS's native `Notification` API
 * — same approach as the Anodex2 sibling project — so it's real HTML/CSS
 * that matches Anodex's own theme instead of generic OS toast chrome.
 */
export function notifyDesktop(title: string, body: string): void {
  if (!shouldShowDesktopToast()) return
  void anodex.toast.show({ title, body })
}
