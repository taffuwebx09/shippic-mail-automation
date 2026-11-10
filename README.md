# ShipPic Mail Automation

React + Vite website and companion Chrome extension for shipment photo lookup in Google Chat.

## Goal workflow

1. Enter a waybill number.
2. The extension opens or activates the configured SHIP PIC3 group.
3. It searches the exact waybill.
4. It tries to locate the related shipment photo and display it on the website.

The private Chat group cannot be accessed by the Vercel page alone. Install the extension from `extension/`; see [extension/README.md](extension/README.md).

## Website

```bash
npm install
npm run dev
npm run build
```

## Vercel

Framework preset: Vite. Build command: `npm run build`. Output directory: `dist`.

## Roadmap

- Verify matching behavior with the actual SHIP PIC3 DOM.
- Reliably associate separate adjacent image messages to waybill messages.
- Add Excel shipment details, email body, embedded photo, and signature.

## Google OAuth and image attachments

The extension uses the office account's Google Chat access. The OAuth consent configuration must include:
- `https://www.googleapis.com/auth/chat.spaces.readonly`
- `https://www.googleapis.com/auth/chat.messages.readonly`
- `https://www.googleapis.com/auth/drive.readonly` (only needed when the matching Chat attachment is a Google Drive file)

Enable the Google Chat API and, for Drive-backed attachments, the Google Drive API in the same Cloud project. After changing OAuth scopes, re-load the extension and authorize again with the office account. Drive access is subject to the office account's file permissions and Workspace administrator policies.

## Fast lookup behavior

After the first successful lookup, the extension caches the SHIP PIC3 space resource name locally. Searches reuse the cached space to avoid re-listing all spaces. Google Chat's full search result is reused without an extra message-get request, and following messages are fetched in small pages (25) so nearby photo attachments can be found quickly. Actual response time depends on Google, office network latency, and image size.

## Shipment photo preview

ShipPic collects up to two downloadable image attachments for the first valid waybill timeline match. If the waybill message has multiple photos, the first two are displayed; if there are more than two, the rest are ignored. If the photo is in a following message, ShipPic continues in timeline order but stops at the next different waybill. Existing single-image responses remain compatible.


CI validation branch for the two-photo preview change.
