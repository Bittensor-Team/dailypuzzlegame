# Brand assets

The logo is not a file in the app — it is inline SVG in the page markup
(`public/index.html`, `public/battle.html`), drawn with stylesheet variables
and two spin animations, plus a separate inline SVG favicon in each `<head>`.
That is why it could not simply be exported; the files here are standalone
copies with the colours made literal and the rotations frozen.

## Sources

| File | What it is |
| --- | --- |
| `logo.svg` | The mark alone, transparent background |
| `icon.svg` | The mark on its own dark ground, rounded, inset — the app-icon form |

Edit these, then re-render with `node scripts/render-brand.js`.

## Exports

| File | Size | Use |
| --- | --- | --- |
| `icon-512.png` | 512×512 | **Slack app icon**, GitHub org avatar |
| `icon-1024.png` | 1024×1024 | High-resolution master |
| `icon-192.png` | 192×192 | PWA / Android home screen |
| `apple-touch-icon.png` | 180×180 | iOS home screen |
| `logo-512.png` | 512×512 | The mark alone, for dark backgrounds |
| `logo-64.png` | 64×64 | Small transparent mark |
| `favicon-32.png` | 32×32 | Browser tab |

## Which one to use

Use an **`icon-*`** file anywhere the image sits on someone else's background —
Slack, GitHub, a phone home screen. The mark is cyan line-work built for a dark
ground; on white it nearly disappears, so the icon brings its own.

Use a **`logo-*`** file only where the background is known to be dark.

## Palette

| | |
| --- | --- |
| Accent (line-work) | `#22e0ff` |
| Ground | `#030711` |
| Bars | `#31ff5a` `#f2ee4a` `#ff2be0` |
