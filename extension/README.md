# ShipPic Chrome Extension — Development install

This companion extension links the Vercel ShipPic page to your logged-in Google Chat session.

## Install

1. Download the repository ZIP from GitHub and extract it.
2. In Chrome, open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository's `extension` folder.
5. Open https://shippic-mail-automation.vercel.app/ and reload it.
6. Sign in to Google Chat and ensure you can access the SHIP PIC3 group.

## Notes

- The extension uses your current browser login. It never asks for or stores your password.
- It searches for the exact waybill and attempts to fetch the shipment image in its related message container.
- Google Chat's web UI changes; this initial version may require selector tuning after testing with the actual group.
- This is a developer-mode extension for initial testing, not a published Chrome Web Store extension.
