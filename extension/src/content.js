/*!
 * Sonámbulo — page engine.
 *
 * Two engines can provide the dark base:
 *   Styles  recolors the page's CSS (src/engine/styles.js); content is never touched. Runs in every frame.
 *   Render  filters the rendered page, described below. Works on almost anything but can alter media.
 *
 * Render pipeline applied to <html> (top frame only):
 *   1. dark base    invert + hue-rotate + contrast   (Dark mode, or a tinted high-contrast preset)
 *   2. adjustments  brightness / contrast / saturation
 *   3. #sn-fx       blue-light filter + high-contrast preset (inline SVG filter)
 * Media (images, video, canvas…) receives the exact inverse of step 1 so it keeps its natural look.
 * Child frames only protect their own media, since the top frame's filter already covers their pixels.
 *
 * Copyright 2026 radiowasnton
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
  'use strict';

  const root = document.documentElement;
  if (globalThis.__sonambulo || !(root instanceof HTMLHtmlElement)) return;
  globalThis.__sonambulo = true;

  const { api, hostKey, resolve, wantsDarkBase, hcInverts, modeApplies, msToNextBoundary, styles } = globalThis.SN;

  const ATTR = 'data-sonambulo';
  const MEDIA_ATTR = 'data-sn-media';
  const CANVAS_ATTR = 'data-sn-canvas';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const IS_TOP = window === window.top;
  const MIN_MEDIA_SIZE = 64;
  // Colour matrices of the original high-contrast schemes (rows: R, G, B over the r, g, b input).
  const HC_TINT = {
    yellow: [[0.3, 0.5, 0.2], [0.3, 0.5, 0.2], [0, 0, 0]],
    cyan: [[0, 0.6, 0.4], [0, 0.6, 0.4], [0.2, 0.8, 1]],
    green: [[0, 0.6, 0], [0.2, 0.8, 0.2], [0, 0.2, 0]],
  };
  const LUMINANCE = [[0.2126, 0.7152, 0.0722], [0.2126, 0.7152, 0.0722], [0.2126, 0.7152, 0.0722]];
  const HC_EXPONENT = (level) => 1 + level / 30; // 3.0 at the default intensity, as in the original

  /** Photos and plugins that high-contrast schemes restore to their natural look. */
  const HC_MEDIA = 'img[src*="jpg" i],img[src*="jpeg" i],img[src*="webp" i],img[src*="avif" i],img.rg_i,svg image,embed,object,video';

  /** Elements that must look natural even when the page is inverted. */
  const MEDIA = [
    'img:not([src*=".svg" i]):not([src^="data:image/svg" i])',
    'video', 'canvas', 'embed', 'object', `[${MEDIA_ATTR}]`,
    'iframe[src*="youtube.com"]', 'iframe[src*="youtube-nocookie.com"]', 'iframe[src*="vimeo.com"]',
    'iframe[src*="dailymotion.com"]', 'iframe[src*="twitch.tv"]', 'iframe[src*="spotify.com"]',
  ].join(',');

  const osDark = matchMedia('(prefers-color-scheme: dark)');

  let host = null;
  let store = null;
  let cfg = null;
  let invert = false;
  let fixes; // site-specific CSS for the Styles engine, loaded once per page
  let timer = 0;

  /* ---------- injected nodes ---------- */

  const style = Object.assign(document.createElement('style'), { id: 'sonambulo-style' });
  style.setAttribute('data-sn-fx', ''); // tells the Styles engine not to rewrite this sheet
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  const fx = filterElement('sn-fx');
  const back = filterElement('sn-back'); // restores photos under the high-contrast schemes
  svg.append(fx, back);

  function filterElement(id) {
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.id = id;
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    for (const [name, value] of Object.entries({ x: -50000, y: -50000, width: 100000, height: 100000 })) filter.setAttribute(name, value);
    return filter;
  }

  function primitive(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    parent.append(node);
    return node;
  }

  const matrix = (parent, rows, space) => primitive('feColorMatrix', {
    type: 'matrix',
    values: [...rows.map((row) => [...row, 0, 0]).flat(), 0, 0, 0, 1, 0].join(' '),
    'color-interpolation-filters': space,
  }, parent);

  function transfer(parent, space, funcs) {
    const node = primitive('feComponentTransfer', { 'color-interpolation-filters': space }, parent);
    for (const channel of ['feFuncR', 'feFuncG', 'feFuncB']) primitive(channel, funcs, node);
  }

  /** S-shaped tone curve used when a dark engine already provides the dark base. */
  function curveTable(level) {
    const steepness = 4 + level * 0.1;
    const f = (x) => 1 / (1 + Math.exp(-steepness * (x - 0.5)));
    const [lo, hi] = [f(0), f(1)];
    return Array.from({ length: 17 }, (_, i) => ((f(i / 16) - lo) / (hi - lo)).toFixed(4)).join(' ');
  }

  /**
   * Rebuilds the filters. Blue-light is computed in sRGB; the high-contrast schemes use the linear
   * colour space, exactly like the original extension they come from.
   * @returns {{fx: boolean, back: boolean}} which filters are needed
   */
  function buildFilters(schemeInStyles = false) {
    fx.replaceChildren();
    back.replaceChildren();
    const warmth = modeApplies(cfg) ? cfg.tune.warmth : 0;
    const { preset, level } = cfg.hc;
    const on = cfg.hc.on && !schemeInStyles; // the Styles engine already applied the scheme to the colours

    const addWarmth = () => {
      if (warmth <= 0) return;
      const w = warmth / 100;
      matrix(fx, [[1, 0, 0], [0, 1 - 0.28 * w, 0], [0, 0, 1 - 0.78 * w]], 'sRGB');
    };
    const inverts = hcInverts(cfg); // the scheme inverts whatever the mode is showing
    if (!on) {
      addWarmth();
      return { fx: fx.childElementCount > 0, back: false };
    }

    const exponent = HC_EXPONENT(level);
    const darkBase = wantsDarkBase(cfg); // a dark mode has already darkened the page

    if (preset === 'gray' || preset === 'invertGray') matrix(fx, LUMINANCE, 'linearRGB');
    if (inverts && darkBase) {
      // The original curve 1 - c³ assumes a light page. On a dark one it would turn light text into white
      // on white, so what the mode shows is inverted plainly and given the contrast curve.
      transfer(fx, 'sRGB', { type: 'table', tableValues: '1 0' });
      transfer(fx, 'sRGB', { type: 'table', tableValues: curveTable(level) });
    } else if (inverts) transfer(fx, 'linearRGB', { type: 'gamma', amplitude: -1, exponent, offset: 1 });
    else if (darkBase) transfer(fx, 'sRGB', { type: 'table', tableValues: curveTable(level) }); // gamma would dim light text
    else transfer(fx, 'linearRGB', { type: 'gamma', exponent });
    if (HC_TINT[preset]) matrix(fx, HC_TINT[preset], 'linearRGB');
    addWarmth();

    if (inverts && darkBase) {
      transfer(back, 'sRGB', { type: 'table', tableValues: '1 0' });
    } else if (inverts) {
      transfer(back, 'linearRGB', { type: 'table', tableValues: '1 0' });
      // The original undoes "inverted" schemes a little less (1.7) than the coloured ones (exactly 1/exponent).
      const restore = preset === 'invert' || preset === 'invertGray' ? 1 + 0.35 * (exponent - 1) : 1 / exponent;
      transfer(back, 'linearRGB', { type: 'gamma', exponent: restore });
    } else if (!darkBase) {
      transfer(back, 'linearRGB', { type: 'gamma', exponent: 1 / exponent });
    }
    return { fx: true, back: back.childElementCount > 0 };
  }

  /* ---------- stylesheet ---------- */

  const isOpaque = (color) => !/^rgba\(.*,\s*0\)$|^transparent$/.test(color);

  /**
   * The viewport canvas is painted outside the root element's filter, so <html> needs a real
   * background of its own: the page's (body) colour when it has one, white otherwise.
   * Returns null when the page already paints <html>.
   */
  function readCanvas() {
    // Only a rule whose subject is <html> depends on this attribute, so toggling it invalidates a single element.
    const injected = root.hasAttribute(CANVAS_ATTR);
    root.removeAttribute(CANVAS_ATTR);
    const own = getComputedStyle(root).backgroundColor;
    const body = document.body && getComputedStyle(document.body).backgroundColor;
    if (injected) root.setAttribute(CANVAS_ATTR, '');
    if (isOpaque(own)) return null;
    return body && isOpaque(body) ? body : '#fff';
  }

  let canvas = '#fff';

  function buildCss(useFx, useBack, byStyles) {
    const k = cfg.oled ? 1.06 : 0.88;
    const { brightness, contrast, saturation } = modeApplies(cfg) ? cfg.tune : { brightness: 100, contrast: 100, saturation: 100 };
    const adjustments = [
      brightness !== 100 && `brightness(${brightness / 100})`,
      contrast !== 100 && `contrast(${contrast / 100})`,
      saturation !== 100 && `saturate(${saturation / 100})`,
    ];
    // The mode's adjustments are a final touch: an inverting scheme must see the original whites, and a tone curve would exaggerate a warm tint.
    const adjustLast = cfg.hc.on;
    const chain = [
      invert && `invert(1) hue-rotate(180deg) contrast(${k})`,
      ...(adjustLast ? [] : adjustments),
      useFx && 'url("#sn-fx")',
      ...(adjustLast ? adjustments : []),
    ].filter(Boolean).join(' ');

    hasChain = Boolean(chain);
    const rules = [];
    if (IS_TOP && chain) {
      // min-height: the filter only covers <html>'s own box, so short pages would leave an unfiltered strip.
      rules.push(`html[${ATTR}]{filter:${chain} !important;min-height:100%}`);
      if (canvas) rules.push(`html[${ATTR}][${CANVAS_ATTR}]{background-color:${canvas}}`);
    }
    // Viewport scrollbars are not filtered: they are dark only when the page ends up dark.
    const endsDark = hcInverts(cfg) ? !wantsDarkBase(cfg) : invert;
    if (IS_TOP && cfg.scrollbars && endsDark && chain && !byStyles) {
      rules.push(`html[${ATTR}]{scrollbar-color:#3d3d3d #000}`, `html[${ATTR}] *{scrollbar-color:#c2c2c2 #fff}`);
    }
    const counter = `contrast(${(1 / k).toFixed(3)}) hue-rotate(180deg) invert(1)`;
    if (invert) {
      rules.push(
        `html[${ATTR}] :is(${MEDIA}){filter:${counter} !important}`,
        `html[${ATTR}] :is(${MEDIA}) :is(${MEDIA}){filter:none !important}`,
      );
    }
    if (invert && cfg.solid) {
      // Seen through the inversion, a white flat background becomes the mode's black.
      rules.push(`html[${ATTR}]{background:#fff !important}`, `html[${ATTR}] body,html[${ATTR}] body>.container{background:#fff !important}`);
    }
    if (useBack) {
      // Photos undo the scheme first (it is the last filter of the page) and then the dark base, if any.
      rules.push(
        `html[${ATTR}] :is(${HC_MEDIA}){filter:url("#sn-back")${invert ? ` ${counter}` : ''} !important}`,
        `html[${ATTR}] :is(${HC_MEDIA}) :is(${HC_MEDIA}){filter:none !important}`,
      );
    }
    return rules.join('\n');
  }

  /* ---------- background-image protection ---------- */

  // Elements are walked lazily in small slices, and every slice reads first and writes afterwards:
  // mixing the two would force a layout for each element on large pages.
  const walkers = [];
  let scheduled = false;
  const idle = globalThis.requestIdleCallback ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 40));
  const SLICE = 150;

  function drain(deadline) {
    scheduled = false;
    while (walkers.length && deadline.timeRemaining() > 1) {
      const walker = walkers[walkers.length - 1];
      const withImage = [];
      for (let steps = 0; steps < SLICE; steps++) {
        const el = walker.currentNode;
        if (el.nodeType === Node.ELEMENT_NODE && !el.hasAttribute(MEDIA_ATTR) && getComputedStyle(el).backgroundImage.includes('url(')) withImage.push(el);
        if (!walker.nextNode()) {
          walkers.pop();
          break;
        }
      }
      const large = withImage.filter((el) => {
        const { width, height } = el.getBoundingClientRect();
        return width >= MIN_MEDIA_SIZE && height >= MIN_MEDIA_SIZE;
      });
      for (const el of large) el.setAttribute(MEDIA_ATTR, '');
    }
    if (walkers.length) schedule();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    idle(drain, { timeout: 800 });
  }

  function enqueue(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    walkers.push(document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT));
    schedule();
  }

  const mediaObserver = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(enqueue);
  });

  function watchMedia(on) {
    mediaObserver.disconnect();
    walkers.length = 0;
    if (!on) return;
    mediaObserver.observe(root, { childList: true, subtree: true });
    enqueue(root);
  }

  /* ---------- native dark-page detection (top frame) ---------- */

  const probe = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });

  function luminanceOf(cssColor) {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#fff';
    probe.fillStyle = cssColor;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return a < 150 ? null : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function pageIsDark() {
    const propagated = readCanvas(); // colour the canvas takes when <html> itself is transparent
    const samples = [[0.5, 0.5], [0.12, 0.5], [0.88, 0.3]].map(([x, y]) => {
      for (const el of document.elementsFromPoint(innerWidth * x, innerHeight * y)) {
        const color = el === root && propagated ? propagated : getComputedStyle(el).backgroundColor;
        const lum = luminanceOf(color);
        if (lum !== null) return lum;
      }
      return 1;
    });
    return samples.sort((a, b) => a - b)[1] < 0.35;
  }

  let hasChain = false;
  let needsInspection = false; // only filters and the Render engine need the page's colours
  let inspectTimer = 0;
  function inspectSoon() {
    clearTimeout(inspectTimer);
    inspectTimer = setTimeout(async () => {
      if (!document.body || !cfg?.active || !needsInspection) return;
      const nextCanvas = readCanvas();
      if (nextCanvas !== canvas) {
        canvas = nextCanvas;
        render();
      }
      if (!cfg.detectDark || !wantsDarkBase(cfg) || cfg.engine !== 'render') return;
      const dark = pageIsDark();
      if (dark === Boolean(store.nativeDark[host])) return;
      const nativeDark = { ...store.nativeDark };
      if (dark) nativeDark[host] = true;
      else delete nativeDark[host];
      await api.storage.local.set({ nativeDark });
    }, 800);
  }

  /* ---------- render ---------- */

  function clear() {
    styles.stop();
    root.removeAttribute(ATTR);
    root.removeAttribute(CANVAS_ATTR);
    root.removeAttribute('data-sn-host');
    style.remove();
    svg.remove();
    watchMedia(false);
    document.querySelectorAll(`[${MEDIA_ATTR}]`).forEach((el) => el.removeAttribute(MEDIA_ATTR));
  }

  async function loadFixes() {
    if (fixes !== undefined) return;
    fixes = null;
    fixes = (await api.runtime.sendMessage({ t: 'siteCss', url: location.href }).catch(() => null)) || null;
    if (styles.running) styles.setFixes(fixes);
  }

  function render() {
    if (!cfg.active) return clear();

    const dark = wantsDarkBase(cfg);
    // With the Styles engine a stacked high-contrast scheme is applied to the CSS colours, so images stay untouched.
    const schemeInStyles = cfg.hc.on && modeApplies(cfg) && cfg.engine === 'styles';
    const useStyles = (dark || schemeInStyles) && cfg.engine === 'styles';
    invert = dark && cfg.engine === 'render' && !(cfg.detectDark && store.nativeDark[host]);

    if (useStyles) {
      styles.start({
        oled: cfg.oled,
        dark,
        scrollbars: cfg.scrollbars,
        scheme: schemeInStyles ? { preset: cfg.hc.preset, level: cfg.hc.level } : null,
        lite: cfg.lite,
        solid: cfg.solid && dark,
        fixes,
      });
      root.setAttribute('data-sn-host', host);
      loadFixes();
    } else {
      styles.stop();
      root.removeAttribute('data-sn-host');
    }

    const needed = buildFilters(schemeInStyles);
    const useFx = IS_TOP && needed.fx;
    style.textContent = buildCss(useFx, needed.back, useStyles);

    if (!style.isConnected) root.append(style);
    if ((useFx || needed.back) && !svg.isConnected) root.append(svg);
    if (!useFx && !needed.back) svg.remove();
    root.setAttribute(ATTR, useStyles ? 'styles' : 'render');

    watchMedia(invert);
    needsInspection = IS_TOP && (hasChain || (cfg.detectDark && invert));
    if (needsInspection) {
      if (canvas) root.setAttribute(CANVAS_ATTR, '');
      inspectSoon();
    } else root.removeAttribute(CANVAS_ATTR);
  }

  function refresh() {
    clearTimeout(timer);
    cfg = resolve(store, host, osDark.matches);
    render();
    const wait = msToNextBoundary(store.settings.schedule);
    if (wait !== null) timer = setTimeout(refresh, wait + 500);
  }

  /* ---------- lifecycle ---------- */

  async function reload() {
    store = await globalThis.SN.load();
    refresh();
  }

  async function start() {
    host = IS_TOP ? hostKey(location.href) : await api.runtime.sendMessage({ t: 'topHost' });
    if (!host) return;

    await reload();

    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && ['settings', 'sites', 'nativeDark'].some((key) => key in changes)) reload();
    });
    osDark.addEventListener('change', refresh);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());

    if (IS_TOP) {
      api.runtime.onMessage.addListener((message, _sender, respond) => {
        if (message?.t !== 'state') return false;
        respond({ cfg, host, engine: styles.running ? styles.stats() : null });
        return false;
      });
      document.addEventListener('DOMContentLoaded', inspectSoon);
      addEventListener('load', inspectSoon);
      new MutationObserver(inspectSoon).observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode'] });
    }

    // Some sites rebuild <html> children; put our nodes back if they vanish.
    new MutationObserver(() => {
      if (cfg?.active && !style.isConnected) render();
    }).observe(root, { childList: true });
  }

  start().catch(() => {});
})();
