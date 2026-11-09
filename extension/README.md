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
