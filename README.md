# ShipPic Mail Automation

A React + Vite app for collecting shipment evidence images and preparing structured shipment emails.

## Milestone 1 — Image capture

- Paste an image copied from Google Chat with Ctrl + V.
- Preview and remove the captured image.
- Drop an image or choose one from your computer.
- Add a waybill number manually.

This browser app does not automatically read a private Google Chat group. Chat API integration, shipment-to-image association, Excel import, and Gmail compose are later milestones.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Vercel

Import this repository into Vercel. Use the Vite framework preset, build command `npm run build`, and output directory `dist`.

## Roadmap

1. Clipboard image capture and preview.
2. Waybill number and shipment details.
3. Excel import.
4. Email body, FYI section, and signature template.
5. Gmail compose integration with image.
