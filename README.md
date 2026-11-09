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
