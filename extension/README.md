# ShipPic Chrome Extension — Development install

This companion extension links the Vercel ShipPic page to your signed-in Google Chat session.

## Install

1. Download the repository ZIP from GitHub and extract it.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository's `extension` folder.
5. Open https://shippic-mail-automation.vercel.app/ and reload it.
6. Sign in to Google Chat and ensure you can access the SHIP PIC3 group.

## Notes

- Uses your current browser login; it never asks for or stores your password.
- Searches the exact waybill and tries to fetch the photo in its related message container.
- Google Chat's UI is dynamic; selectors may need adjustment after live testing.
- This is a developer-mode extension, not a Chrome Web Store release.

## Required APIs and OAuth scopes

Enable Google Chat API in the Cloud project. For photos attached as Google Drive files, also enable Google Drive API and add the `drive.readonly` scope to the OAuth consent screen's Data Access section. The office account must have permission to open the file. After changing scopes, remove/reload the extension and complete Google authorization again.

## Performance

The extension caches the SHIP PIC3 space resource name in Chrome local extension storage after the first successful lookup, reuses full search results, and requests following messages in 25-message pages. Search time still depends on Google Chat response latency and photo download size.

## Multiple photos per waybill

The extension returns up to two downloadable image attachments for a valid waybill match. It can collect both attachments from one Chat message or from adjacent messages before the next different waybill. Additional images are ignored, and the response retains the original `imageDataUrl` field for compatibility alongside the new `imageDataUrls` array.
