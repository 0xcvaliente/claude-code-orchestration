# plugin-assets

Files that `npm run build-plugin` copies into `dist/plugin`, and their sources. This file is not copied.

| File | Copied to | What it is |
|---|---|---|
| `README.md` | `dist/plugin/README.md` | The plugin's own README, read outside this repository, so its links are absolute URLs. |
| `icon.png` | `dist/plugin/icon.png` | The plugin's icon, named by `icon` in `plugin.json`. A square PNG of 512 by 512 pixels. |
| `icon.svg` | not copied | The source of `icon.png`. |

The repository's `LICENSE` is copied into `dist/plugin` and `dist/dashboard` as well.

## Regenerating the icon

The build does not render the SVG (CI has no renderer), so the PNG is committed. After an edit of `icon.svg`, render it again and rebuild:

```bash
rsvg-convert -w 512 -h 512 plugin-assets/icon.svg -o plugin-assets/icon.png
rsvg-convert -w 32 -h 32 plugin-assets/icon.svg -o /tmp/icon-32.png   # look at it: it must still read at 32 pixels
npm run build-plugin
```

Nothing checks that `icon.png` matches `icon.svg`; a test checks only that it is a PNG of 512 by 512 pixels and that `dist/plugin/icon.png` equals it. Keep the drawing original: no third-party logo, no copied glyph, no text.
