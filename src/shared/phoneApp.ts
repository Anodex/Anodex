/**
 * Where the Android app is downloaded from.
 *
 * It is not on the Play Store, so without this a new user has nowhere obvious to
 * look. `anodex.apk` is a copy of the installer every phone release carries under
 * a name that never changes (`tools/release_apk.py` in anodex-mobile uploads it),
 * which is what lets `latest/download/` always mean the newest app — and lets a
 * printed or remembered QR keep working across releases.
 */
export const PHONE_APP_DOWNLOAD_URL =
  'https://github.com/Anodex/anodex-mobile/releases/latest/download/anodex.apk'

/** The release page itself, for reading what the latest version changed. */
export const PHONE_APP_RELEASES_URL = 'https://github.com/Anodex/anodex-mobile/releases/latest'
