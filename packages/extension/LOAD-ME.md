# Do not load this folder

Chrome needs the folder that contains `manifest.json`, and that is the **build
output**, not this package root. Loading this directory gives you:

> Manifest file is missing or unreadable

## Load this instead

```bash
npm run build:ext
```

then in Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select **`packages/extension/dist`**

The build prints the absolute path when it finishes, ready to paste into
Chrome's folder picker.

## Why the split

`src/` is TypeScript that imports `@seal/shared`, so the extension runs the
exact canonicalization and Ed25519 code the server and the payment rail run. A
second, hand-rolled copy of either would eventually produce signatures that
verify in one place and not another. esbuild bundles it into `dist/` alongside
`public/` (the manifest, HTML and CSS), and that folder is what Chrome loads.

Re-run `npm run build:ext` after changing anything in `src/` or `public/`, then
hit the reload arrow on the extension card in Chrome.
