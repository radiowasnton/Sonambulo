<div align="center">

<img src="extension/assets/brand/logo.svg" alt="" width="96" height="96">

# Sonámbulo

**Night, more alive than ever.** Dark mode, filters and high contrast for every website.

[Español](README.es.md)

</div>

## Features

- **Per website:** Dark · OLED · Filtered · Normal, plus High contrast. Every choice, OLED included, is remembered per site (and for its subdomains) and can be changed from the Websites page.
- **High contrast** Seven schemes with its exact filters: Increased, Grayscale, Inverted color, Inverted grayscale, and Yellow / Cyan / Green on black. Intensity 60 % is the original strength. A switch decides how they relate to the mode: **on** (default) applies the scheme to what the mode is showing, so "Inverted color" over OLED inverts the OLED look; **off** shows the scheme alone, exactly like the original extension. With the Styles engine the scheme is applied to the CSS colors, so images are never touched; with Render it is a filter.
- **Dark** has two engines, switchable per site:
  - **Styles** *(default)* recolors the page's CSS. Images, video and content are never touched.
  - **Render** inverts the rendered page with a GPU filter. Works on almost anything, but can alter images.
  OLED is the same dark with pure black backgrounds; Dark uses a soft gray.
- **Filtered** keeps the original colors and softens brightness, contrast, saturation and blue light.
- **Solid background** (per site, Dark and OLED): flattens the backgrounds of `html` and `body`, images and gradients included, to the mode's color. Use it when a page only gets slightly darker.
- The Render engine detects websites that are already dark and leaves them alone.
- 170 per-site fixes for the Styles engine.
- Every website keeps its complete configuration (mode, engine, high-contrast scheme and intensity, adjustments) and the gear on the Websites page edits all of it.
- Follow the system theme, a daily schedule, keyboard shortcuts, backup and restore.
- Imports backups made with Sonámbulo 1.x.
- 51 languages, including right-to-left layouts.
- No analytics and no remote code. The only network requests are for the stylesheets of the page you are on, which the Styles engine needs to recolor them. Nothing is sent anywhere.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+Shift+D` | Toggle dark / normal on the current site |
| `Alt+Shift+M` | Cycle Dark → Filtered → Normal |
| `Alt+Shift+H` | Toggle high contrast on the current site |
| `Alt+Shift+O` | Pause / resume Sonámbulo |

Change them in `chrome://extensions/shortcuts` (Chrome) or *Manage Extension Shortcuts* (Firefox).

## Develop

Requires Node 20+. There are no runtime dependencies and no bundler: the code in `extension/` is exactly what ships.

```sh
npm test            # unit tests for the core
npm run check       # every locale has every message
npm run build       # dist/sonambulo-<version>-chrome.zip and -firefox.zip
```

Load `extension/` as an unpacked extension in Chrome, or `dist/firefox/manifest.json` through `about:debugging` in Firefox.

```
extension/
├─ manifest.json
├─ _locales/<code>/messages.json
├─ assets/
│  ├─ brand/     logo and toolbar icons
│  └─ glyphs/    interface icons (SVG, recolored with CSS masks)
└─ src/
   ├─ core.js        data model, per-site resolution, storage, backups
   ├─ content.js     orchestrates the engines, filters and high contrast
   ├─ engine/
   │  ├─ color.js    HSL colour rules of the Styles engine
   │  └─ styles.js   the Styles engine
   ├─ background.js  shortcuts and toolbar state
   ├─ i18n.js        translations for the pages
   ├─ ui.css
   ├─ popup/
   └─ options/
└─ data/site-fixes/  CSS patches for individual websites (Styles engine)
```

### The Styles engine

For every stylesheet the engine builds a sibling *override* sheet that repeats each rule with converted colors, placed right after the original so the cascade is preserved. Colors go through HSL: light backgrounds are flipped, text is lifted to a readable lightness, white becomes black (OLED) or a soft near-black. CSS variables get a background variant (`--x-sn-bg`). It handles `<style>`/`<link>`, cross-origin sheets (fetched by the background), `@import`, `@media`, `@layer`, `@keyframes`, adopted sheets, open Shadow DOM and inline styles, and `stop()` restores the page exactly.

Heavy web apps are handled with care: the engine converts large style sheets in chunks, appends only the new rules when a page keeps inserting them, and switches itself to a *light profile* (style sheets only, no following of inline styles) on Office on the web and whenever a page changes its DOM at a very high rate.

### The Render engine

For the top frame, `<html>` receives one filter chain: dark base (`invert + hue-rotate + contrast`), then brightness / contrast / saturation, then an inline SVG filter for the blue-light and high-contrast presets. Images, video, canvas and large background images receive the exact inverse of the dark base, so they look natural. Child frames only protect their own media.

## License

[Apache License 2.0](LICENSE). Free to use, modify and redistribute; any redistribution or derivative work must keep the [NOTICE](NOTICE) and credit **radiowasnton** as the original author.
