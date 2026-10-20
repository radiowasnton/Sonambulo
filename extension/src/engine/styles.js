/*!
 * Sonámbulo — Styles engine.
 *
 * Recolors the page's CSS instead of filtering its pixels, so images, video and other content are
 * never touched. For every stylesheet it builds a sibling "override" sheet that repeats each rule
 * with converted colours, placed right after the original so the cascade order is preserved.
 * Hover and focus states, @media, @layer, @keyframes and CSS variables keep working.
 *
 * Covered: <style> and <link> sheets, stylesheets from other origins (fetched by the background),
 * @import, constructable (adopted) sheets, open Shadow DOM, inline styles and legacy colour
 * attributes. Everything is reversible: stop() puts the page back exactly as it was.
 *
 * Copyright 2026 radiowasnton
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
  'use strict';

  const { api, color } = globalThis.SN;

  const MARK = 'data-sn'; // marks every node this engine inserts
  const FX_MARK = 'data-sn-fx'; // the filter stylesheet of content.js, which must never be rewritten
  const isOurs = (node) => node.hasAttribute?.(MARK) || node.hasAttribute?.(FX_MARK);
  const ORIGINAL = 'data-sn-orig'; // original value of an inline style that was rewritten
  const NO_STYLE = '\u0000none';
  const TICK_MS = 1000;
  const LATE_TICKS = 4;
  const SLICE = 200; // elements inspected per slice
  const LARGE_SHEET = 1500; // rules above which a sheet is converted in chunks
  const CHUNK = 300;
  const OVERLOAD_SHARE = 0.25; // share of the page's time the engine may use
  const OVERLOAD_RATE = 3000; // DOM mutation records per second
  const OVERLOAD_TICKS = 3;
  const COLORISH = /(background|color|border|fill|stroke|shadow|outline|caret|decoration|column-rule|emphasis|--)/i;
  const SLICE_MS = 8;
  const idle = globalThis.requestIdleCallback ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => SLICE_MS }), 20));
  const MAX_IMPORT_DEPTH = 3;

  /* ---------- properties ---------- */

  const SIDES = ['top', 'right', 'bottom', 'left', 'block', 'inline', 'block-start', 'block-end', 'inline-start', 'inline-end'];
  const BACKGROUND = [
    'background', 'background-color', 'background-image',
    'border', 'border-color', ...SIDES.flatMap((s) => [`border-${s}`, `border-${s}-color`]),
    'box-shadow', 'text-shadow',
  ];
  const FOREGROUND = [
    'color', 'fill', 'stroke', 'caret-color', 'text-decoration', 'text-decoration-color', 'outline', 'outline-color',
    'column-rule', 'column-rule-color', '-webkit-text-fill-color', '-webkit-text-stroke-color', 'text-emphasis-color',
  ];
  const KIND = Object.fromEntries([...BACKGROUND.map((p) => [p, 'bg']), ...FOREGROUND.map((p) => [p, 'fg'])]);
  const PROPERTIES = Object.keys(KIND);
  const NON_COLOR_VARIABLE = /(width|height|ratio|margin|padding|spacing|radius|flex|gap|size|duration|delay|index|opacity|columns|rotate|scale)/i;

  /** Longhands already described by a shorthand that had a value. */
  function covers(shorthand, prop) {
    if (shorthand === 'background') return prop === 'background-color' || prop === 'background-image';
    if (shorthand === 'border') return prop.startsWith('border-');
    if (shorthand === 'border-color') return prop.startsWith('border-') && prop.endsWith('-color');
    if (shorthand.startsWith('border-') && !shorthand.endsWith('-color')) return prop === `${shorthand}-color`;
    if (shorthand === 'outline') return prop === 'outline-color';
    if (shorthand === 'text-decoration') return prop === 'text-decoration-color';
    if (shorthand === 'column-rule') return prop === 'column-rule-color';
    return false;
  }

  const COVERED_BY = new Map(PROPERTIES.map((shorthand) => [shorthand, PROPERTIES.filter((prop) => covers(shorthand, prop))]));

  /* ---------- colour resolution for named and modern colour syntax ---------- */

  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const resolved = new Map();

  function resolveColor(text) {
    if (resolved.has(text)) return resolved.get(text);
    let result = null;
    probe.fillStyle = '#000';
    probe.fillStyle = text;
    const first = probe.fillStyle;
    probe.fillStyle = '#fff';
    probe.fillStyle = text;
    if (first === probe.fillStyle) {
      probe.clearRect(0, 0, 1, 1);
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
      result = [r, g, b, a / 255];
    }
    resolved.set(text, result);
    return result;
  }

  /* ---------- state ---------- */

  let active = false;
  let options = null;
  let converter = null;
  let tickTimer = 0;
  let bootTimer = 0;
  let pendingDownloads = 0;
  let lateTicks = 0;

  const scopes = new Map(); // Document | ShadowRoot → { observer }
  const entries = new Map(); // CSSStyleSheet → { count, node, override, remote }
  const overrides = new Set(); // every constructable override sheet we created
  const applied = new WeakMap(); // element → inline style text we wrote
  const remoteCss = new Map(); // url → text
  const loadListeners = new Map(); // root → capture listener for <link> loads
  const queue = new Set(); // single elements whose attributes changed
  const work = []; // tree walkers over subtrees still to be inspected
  let queued = false;
  let lite = false;
  let overloaded = 0;
  let lastBusy = 0;
  let lastAt = 0;
  let lastMutations = 0;
  const stats = { busyMs: 0, since: 0, mutations: 0, inlineConversions: 0, sheetsConverted: 0 };

  /** Accumulates the time spent in the engine's own work, to measure its cost on heavy pages. */
  const timed = (fn) => (...args) => {
    const start = performance.now();
    try {
      return fn(...args);
    } finally {
      stats.busyMs += performance.now() - start;
    }
  };

  /* ---------- value and rule conversion ---------- */

  function splitDeclarations(text) {
    const parts = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ';' && depth === 0) {
        parts.push(text.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(text.slice(start));
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  /** Converted declarations for one value, or null when nothing changes. */
  function convertProperty(name, value, absolutize) {
    const kind = KIND[name];
    if (!kind || converter.convertValue(value, kind) === value) return null;
    return converter.convertValue(value, kind, absolutize);
  }

  /** `--x` gets a foreground variant and `--x-sn-bg` a background variant; var() uses pick the right one. */
  function convertVariable(name, value, absolutize) {
    if (NON_COLOR_VARIABLE.test(name)) return [];
    const triplet = { fg: converter.convertTriplet(value, 'fg'), bg: converter.convertTriplet(value, 'bg') };
    const fg = triplet.fg ?? converter.convertValue(value, 'fg', absolutize);
    const bg = triplet.bg ?? converter.convertValue(value, 'bg', absolutize);
    const out = [];
    if (fg !== value) out.push([name, fg]);
    if (bg !== value) out.push([`${name}-sn-bg`, bg]);
    return out;
  }

  function convertStyle(style, base) {
    const absolutize = (url) => new URL(url, base).href;
    const declarations = [];
    const covered = new Set();

    for (const name of PROPERTIES) {
      if (covered.has(name)) continue;
      const value = style.getPropertyValue(name).trim();
      if (!value) continue;
      for (const other of COVERED_BY.get(name)) covered.add(other);
      const next = convertProperty(name, value, absolutize);
      if (next !== null) declarations.push(`${name}:${next}${style.getPropertyPriority(name) ? ' !important' : ''}`);
    }
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      if (!name.startsWith('--')) continue;
      for (const [variable, value] of convertVariable(name, style.getPropertyValue(name).trim(), absolutize)) {
        declarations.push(`${variable}:${value}`);
      }
    }
    return declarations.join(';');
  }

  const preludeOf = (rule) => rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
  const isStyleRule = (rule) => rule instanceof CSSStyleRule;

  function ruleToCss(rule, base) {
    if (isStyleRule(rule)) {
      const body = convertStyle(rule.style, base);
      const nested = rule.cssRules?.length ? rulesToCss(rule.cssRules, base) : '';
      return body || nested ? `${rule.selectorText}{${body}${body && nested ? ';' : ''}${nested}}` : '';
    }
    if (rule instanceof CSSImportRule) return importToCss(rule);
    if (rule instanceof CSSKeyframesRule) {
      const frames = [...rule.cssRules].map((frame) => ({ frame, body: convertStyle(frame.style, base) }));
      return frames.some((f) => f.body) ? `${preludeOf(rule)}{${frames.map(({ frame, body }) => (body ? `${frame.keyText}{${body}}` : frame.cssText)).join('')}}` : '';
    }
    if (rule.cssRules && !(rule instanceof CSSFontFaceRule)) {
      const inner = rulesToCss(rule.cssRules, base);
      return inner ? `${preludeOf(rule)}{${inner}}` : '';
    }
    return '';
  }

  function rulesToCss(rules, base) {
    let css = '';
    for (const rule of rules) css += ruleToCss(rule, base);
    return css;
  }

  const yieldToMain = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));

  /** Same as rulesToCss, but gives the page the main thread back every few hundred rules. */
  async function rulesToCssAsync(rules, base) {
    if (rules.length <= LARGE_SHEET) return rulesToCss(rules, base);
    let css = '';
    for (let i = 0; i < rules.length; i++) {
      css += ruleToCss(rules[i], base);
      if (i % CHUNK === CHUNK - 1) await yieldToMain();
      if (!active) break;
    }
    return css;
  }

  function importToCss(rule) {
    let css;
    try {
      css = rulesToCss(rule.styleSheet.cssRules, rule.styleSheet.href ?? rule.href);
    } catch {
      scheduleRemoteImport(rule.href);
      return '';
    }
    const media = rule.media?.mediaText;
    return media && media !== 'all' ? `@media ${media}{${css}}` : css;
  }

  function scheduleRemoteImport(href) {
    // The imported sheet is cross-origin: it is handled as a regular remote sheet by the next scan.
    if (!href || remoteCss.has(href)) return;
    remoteCss.set(href, null);
    fetchRemote(href).then((css) => css && insertLoose(css));
  }

  /* ---------- remote (cross-origin) stylesheets ---------- */

  async function fetchText(url) {
    if (remoteCss.get(url)) return remoteCss.get(url);
    const text = await api.runtime.sendMessage({ t: 'fetchCss', url }).catch(() => null);
    if (typeof text === 'string') remoteCss.set(url, text);
    return typeof text === 'string' ? text : null;
  }

  async function fetchRemote(url, depth = 0) {
    const text = await fetchText(url);
    if (text === null) return null;
    const imports = [];
    const stripped = text.replace(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi, (_, href) => {
      imports.push(new URL(href, url).href);
      return '';
    });
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(stripped);
    } catch {
      return null;
    }
    let css = '';
    if (depth < MAX_IMPORT_DEPTH) for (const href of imports) css += (await fetchRemote(href, depth + 1)) ?? '';
    return css + (await rulesToCssAsync(sheet.cssRules, url));
  }

  /** Overrides that have no source node to sit behind (imports of imports) go at the end of the head. */
  function insertLoose(css) {
    if (!active) return;
    const node = Object.assign(document.createElement('style'), { textContent: css });
    node.setAttribute(MARK, 'loose');
    (document.head ?? document.documentElement).append(node);
  }

  /* ---------- sheets ---------- */

  function countRules(sheet) {
    try {
      return sheet.cssRules.length;
    } catch {
      return -1;
    }
  }

  function overrideNode(sheet, css) {
    const node = Object.assign(document.createElement('style'), { textContent: css });
    node.setAttribute(MARK, 'override');
    const media = sheet.media?.mediaText;
    if (media) node.media = media;
    return node;
  }

  /**
   * Puts the converted CSS in place. A whole rebuild never reuses the previous node or sheet: Chromium can
   * keep applying the rules of a sheet that was modified through insertRule() and then replaced.
   */
  function place(entry, sheet, css, scope) {
    const owner = sheet.ownerNode;
    if (owner) {
      entry.node?.remove();
      entry.node = null;
      if (!css) return;
      entry.node = overrideNode(sheet, css);
      owner.after(entry.node);
      return;
    }
    if (entry.override) {
      overrides.delete(entry.override);
      scope.adoptedStyleSheets = scope.adoptedStyleSheets.filter((other) => other !== entry.override);
    }
    entry.override = new CSSStyleSheet();
    overrides.add(entry.override);
    entry.override.replaceSync(css);
    scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, entry.override];
  }

  /** CSS-in-JS libraries append rules all the time: only the new rules are converted and inserted. */
  function appendRules(entry, sheet, from, to) {
    const target = entry.node ? entry.node.sheet : entry.override;
    if (!target) throw new Error('override not ready');
    const base = sheet.href ?? document.baseURI;
    for (let i = from; i < to; i++) {
      const text = ruleToCss(sheet.cssRules[i], base);
      if (!text) continue;
      target.insertRule(text, target.cssRules.length); // throws when a rule expands to several; the caller rebuilds then
      entry.css += text;
    }
  }

  function processSheet(sheet, scope) {
    const owner = sheet.ownerNode;
    if (!active || (owner && isOurs(owner)) || sheet.disabled || /alternate|preload/.test(owner?.getAttribute?.('rel') ?? '')) return;
    if (sheet.media?.mediaText === 'print') return;

    const count = countRules(sheet);
    const entry = entries.get(sheet);
    if (entry && (entry.working || entry.remote)) return;
    if (entry && entry.count === count) {
      const detached = entry.node && !entry.node.isConnected && owner?.isConnected;
      const dropped = entry.override && !scope.adoptedStyleSheets?.includes(entry.override);
      if (detached || dropped) place(entry, sheet, entry.css, scope);
      return;
    }

    if (count === -1) {
      if (!sheet.href) return;
      const pending = { count, remote: true };
      entries.set(sheet, pending);
      pendingDownloads++;
      fetchRemote(sheet.href).then((css) => css && active && place(pending, sheet, css, scope)).finally(() => {
        pendingDownloads--;
        markReadyIfSettled();
      });
      return;
    }

    if (entry && entry.count > 0 && count > entry.count && (entry.node || entry.override)) {
      try {
        appendRules(entry, sheet, entry.count, count);
        entry.count = count;
        return;
      } catch {
        // fall through: rebuild the whole override
      }
    }

    const next = entry ?? { count };
    next.count = count;
    entries.set(sheet, next);
    stats.sheetsConverted++;
    const base = sheet.href ?? document.baseURI;
    if (count <= LARGE_SHEET) {
      next.css = rulesToCss(sheet.cssRules, base);
      place(next, sheet, next.css, scope);
      return;
    }
    next.working = true;
    pendingDownloads++;
    rulesToCssAsync(sheet.cssRules, base).then((css) => {
      if (!active || entries.get(sheet) !== next) return;
      next.css = css;
      place(next, sheet, css, scope);
    }).catch(() => {}).finally(() => {
      next.working = false;
      pendingDownloads--;
      markReadyIfSettled();
    });
  }

  function scanSheets(root) {
    if (!active) return;
    // Rebuilding an override detaches its old node while this snapshot is still being walked: a sheet without
    // owner is not a document sheet any more and must not be mistaken for an adopted one.
    for (const sheet of [...root.styleSheets]) if (sheet.ownerNode) processSheet(sheet, root);
    for (const sheet of [...(root.adoptedStyleSheets ?? [])]) if (!overrides.has(sheet)) processSheet(sheet, root);
  }

  /* ---------- inline styles and legacy attributes ---------- */

  const TEXT_SVG = new Set(['TEXT', 'TSPAN', 'TEXTPATH']);

  function convertInline(el) {
    const raw = el.getAttribute('style');
    if (raw !== null && applied.get(el) === raw) return; // our own write
    if (raw !== null && !COLORISH.test(raw) && !el.hasAttribute('bgcolor') && !el.hasAttribute('fill') && !el.hasAttribute('stroke')) return; // nothing to recolor

    const declarations = raw === null ? [] : splitDeclarations(raw);
    const out = [];
    let changed = false;

    for (const declaration of declarations) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      const name = declaration.slice(0, colon).trim().toLowerCase();
      let value = declaration.slice(colon + 1).trim();
      const important = /\s*!important$/i.test(value);
      if (important) value = value.replace(/\s*!important$/i, '');
      const flag = important ? ' !important' : '';

      if (name.startsWith('--')) {
        const variants = new Map(convertVariable(name, value));
        out.push(`${name}:${variants.get(name) ?? value}${flag}`);
        if (variants.has(`${name}-sn-bg`)) out.push(`${name}-sn-bg:${variants.get(`${name}-sn-bg`)}`);
        if (variants.size) changed = true;
        continue;
      }
      const next = convertProperty(name, value);
      if (next === null) out.push(declaration);
      else {
        changed = true;
        out.push(`${name}:${next}${flag}`);
      }
    }

    // Presentation attributes (bgcolor, fill, stroke) have the lowest priority, so they are mirrored inline.
    const legacy = [
      ['bgcolor', 'background-color', 'bg'],
      ['fill', 'fill', TEXT_SVG.has(el.nodeName.toUpperCase()) ? 'fg' : 'bg'],
      ['stroke', 'stroke', 'fg'],
    ];
    for (const [attribute, property, kind] of legacy) {
      const value = el.getAttribute(attribute)?.trim();
      if (!value || /^(none|currentcolor|url\()/i.test(value) || out.some((d) => d.startsWith(`${property}:`))) continue;
      const next = converter.convertValue(value, kind);
      if (next !== value) {
        out.push(`${property}:${next}`);
        changed = true;
      }
    }

    if (!changed) return;
    stats.inlineConversions++;
    if (!el.hasAttribute(ORIGINAL) || raw !== applied.get(el)) el.setAttribute(ORIGINAL, raw ?? NO_STYLE);
    const text = out.join(';');
    applied.set(el, text);
    el.setAttribute('style', text);
  }

  const INLINE_SELECTOR = '[style],[bgcolor],[fill],[stroke]';

  function inspect(el) {
    if (el.matches(INLINE_SELECTOR)) convertInline(el);
    if (el.shadowRoot) attachScope(el.shadowRoot);
  }

  function pump() {
    if (queued) return;
    queued = true;
    idle(drain, { timeout: 600 });
  }

  /** Subtrees are walked lazily, a few hundred elements per slice, instead of being expanded up front. */
  function enqueue(node) {
    if (!active || node.nodeType !== Node.ELEMENT_NODE || isOurs(node)) return;
    work.push(document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT));
    pump();
  }

  function enqueueOne(el) {
    if (!active || queue.has(el)) return;
    queue.add(el);
    pump();
  }

  const drain = timed(function drain(deadline) {
    queued = false;
    if (!active) {
      work.length = 0;
      return queue.clear();
    }
    while (deadline.timeRemaining() > 1 && (queue.size || work.length)) {
      for (const el of queue) {
        queue.delete(el);
        if (el.isConnected) inspect(el);
        if (deadline.timeRemaining() <= 1) break;
      }
      const walker = work[work.length - 1];
      if (!walker) continue;
      for (let steps = 0; steps < SLICE; steps++) {
        const el = walker.currentNode;
        if (el.nodeType === Node.ELEMENT_NODE && !isOurs(el) && el.isConnected) inspect(el);
        if (!walker.nextNode()) {
          work.pop();
          break;
        }
      }
    }
    if (queue.size || work.length) pump();
    else markReadyIfSettled();
  });

  /* ---------- scopes: the document and every open shadow root ---------- */

  /** Defaults of the page before any scheme: a dark theme, or the browser's own light one. */
  function palette() {
    return options.dark
      ? { bg: options.oled ? '#000000' : '#1f1f1f', text: '#bfbfbf', link: '#8c8cfa', visited: '#b79cff', border: '#616161', thumb: '#3e4346', track: '#1a1a1a', boot: '#3a3a3a' }
      : { bg: '#ffffff', text: '#000000', link: '#0000ee', visited: '#551a8b', border: '#767676', thumb: '#c1c1c1', track: '#f1f1f1', boot: '#cccccc' };
  }

  /** The palette after the high-contrast scheme, if any. */
  function finalPalette() {
    return Object.fromEntries(Object.entries(palette()).map(([name, value]) => [name, converter.convertValue(value, 'raw')]));
  }

  function baseCss() {
    const c = finalPalette();
    const dark = converter.lightness(palette().bg) < 50;
    const scrollbar = options.scrollbars ? `:where(html){scrollbar-color:${c.thumb} ${c.track}}` : '';
    return [
      // No background on <html>: that way the body's colour still propagates to the whole canvas.
      `:where(html){color-scheme:${dark ? 'dark' : 'light'};color:${c.text}}`,
      `:where(body){background-color:${c.bg}}`,
      `:where(input,select,textarea,button){color:${c.text};background-color:${c.bg};border-color:${c.border}}`,
      `:where(a:link){color:${c.link}}:where(a:visited){color:${c.visited}}`,
      '::selection{background:#338ccc;color:#fff}',
      scrollbar,
      // Solid background: like Sonámbulo 1.x, the backgrounds of html and body become one flat colour, images and gradients included.
      options.solid ? `:root:root{background:${c.bg} !important}:root:root body,:root:root body>.container{background:${c.bg} !important}` : '',
    ].join('');
  }

  const bootCss = () => {
    const c = finalPalette();
    return `html:not([${MARK}-ready]) *:not(img,picture,video,canvas,svg,svg *,iframe,embed,object){background-color:${c.bg} !important;color:${c.text} !important;border-color:${c.boot} !important}`;
  };

  function styleNode(role, css) {
    const node = Object.assign(document.createElement('style'), { textContent: css });
    node.setAttribute(MARK, role);
    return node;
  }

  const onMutations = timed(function onMutations(records) {
    stats.mutations += records.length;
    let sheetsChanged = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        const el = record.target;
        if (el.nodeType !== Node.ELEMENT_NODE || isOurs(el)) continue;
        if (record.attributeName === 'style') {
          const text = el.getAttribute('style');
          if (text === null || applied.get(el) === text || !COLORISH.test(text)) continue; // our own write, or e.g. left/top/transform
        }
        enqueueOne(el);
      } else if (record.type === 'characterData') {
        const parent = record.target.parentNode;
        if (parent?.nodeName === 'STYLE' && !isOurs(parent) && parent.sheet) {
          entries.delete(parent.sheet);
          sheetsChanged = true;
        }
      } else {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE || isOurs(node)) continue;
          if (node.nodeName === 'STYLE' || node.nodeName === 'LINK') sheetsChanged = true;
          if (!lite) enqueue(node);
        }
        if (record.target.nodeName === 'STYLE' && !isOurs(record.target) && record.target.sheet) {
          entries.delete(record.target.sheet);
          sheetsChanged = true;
        }
      }
    }
    if (sheetsChanged) for (const root of scopes.keys()) scanSheets(root);
  });

  const OBSERVE_FULL = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'bgcolor', 'fill', 'stroke'] };
  const OBSERVE_LITE = { childList: true, subtree: true, characterData: true };

  /**
   * Lite mode: style sheets keep being converted, but inline styles and new elements are no longer
   * followed. It is what heavy web apps get, either from the start or when the engine measures that it
   * has been using too much of the page's time.
   */
  function enterLite() {
    if (lite) return;
    lite = true;
    queue.clear();
    work.length = 0;
    for (const [root, { observer }] of scopes) {
      observer.disconnect();
      observer.observe(root, OBSERVE_LITE);
    }
  }

  function attachScope(root) {
    if (scopes.has(root) || !active) return;
    const observer = new MutationObserver(onMutations);
    scopes.set(root, { observer });
    if (root !== document) root.prepend(styleNode('base', baseCss()));
    observer.observe(root, lite ? OBSERVE_LITE : OBSERVE_FULL);
    const onLoad = () => scanSheets(root);
    loadListeners.set(root, onLoad);
    root.addEventListener('load', onLoad, true);
    scanSheets(root);
    if (root === document) enqueue(document.documentElement);
    else for (const child of root.children) enqueue(child);
  }

  /* ---------- lifecycle ---------- */

  function markReadyIfSettled() {
    if (!active || pendingDownloads > 0 || queue.size || work.length || document.readyState === 'loading') return;
    document.documentElement.setAttribute(`${MARK}-ready`, '');
    clearTimeout(bootTimer);
    document.querySelector(`style[${MARK}="boot"]`)?.remove();
  }

  const tick = timed(function tick() {
    // Two signals of a page that is too busy to follow: the share of time the engine itself uses, and the
    // rate of DOM mutations (the cost of delivering them and of restyling after our writes is not in the first).
    const now = performance.now();
    const seconds = Math.max(0.001, (now - lastAt) / 1000);
    const share = (stats.busyMs - lastBusy) / (seconds * 1000);
    const rate = (stats.mutations - lastMutations) / seconds;
    [lastBusy, lastAt, lastMutations] = [stats.busyMs, now, stats.mutations];
    overloaded = share > OVERLOAD_SHARE || rate > OVERLOAD_RATE ? overloaded + 1 : 0;
    if (overloaded >= OVERLOAD_TICKS) enterLite();

    for (const root of scopes.keys()) scanSheets(root);
    for (const [sheet, entry] of entries) {
      if (sheet.ownerNode && !sheet.ownerNode.isConnected) {
        entry.node?.remove();
        entries.delete(sheet);
      }
    }
    if (!document.querySelector(`style[${MARK}="base"]`)) document.documentElement.prepend(styleNode('base', baseCss()));
    // Custom elements attach their shadow roots lazily: keep looking during the first seconds after load.
    if (!lite && document.readyState !== 'loading' && ++lateTicks <= LATE_TICKS) enqueue(document.documentElement);
    markReadyIfSettled();
  });

  /**
   * @param {{oled: boolean, dark: boolean, solid?: boolean, scrollbars: boolean, scheme: ({preset: string, level: number}|null), fixes?: string}} config
   */
  function start(config) {
    const signature = (c) => JSON.stringify([c.oled, c.dark, c.scrollbars, c.scheme, Boolean(c.lite), Boolean(c.solid)]);
    if (active && signature(options) === signature(config)) return;
    stop();
    options = config;
    active = true;
    lateTicks = 0;
    lite = Boolean(config.lite);
    overloaded = 0;
    [lastBusy, lastAt, lastMutations] = [0, performance.now(), 0];
    converter = color.createConverter({ oled: config.oled, dark: config.dark, scheme: config.scheme, resolve: resolveColor });

    const root = document.documentElement;
    root.prepend(styleNode('base', baseCss()));
    if (document.readyState === 'loading') {
      root.append(styleNode('boot', bootCss()));
      bootTimer = setTimeout(() => {
        root.setAttribute(`${MARK}-ready`, '');
        document.querySelector(`style[${MARK}="boot"]`)?.remove();
      }, 2500);
    } else root.setAttribute(`${MARK}-ready`, '');
    if (config.fixes) root.append(styleNode('fix', config.fixes));

    document.addEventListener('DOMContentLoaded', markReadyIfSettled, { once: true });
    stats.busyMs = stats.mutations = stats.inlineConversions = stats.sheetsConverted = 0;
    stats.since = performance.now();
    attachScope(document);
    tickTimer = setInterval(tick, TICK_MS);
  }

  function setFixes(css) {
    if (!active) return;
    options.fixes = css;
    document.querySelector(`style[${MARK}="fix"]`)?.remove();
    if (css) document.documentElement.append(styleNode('fix', css));
  }

  function stop() {
    if (!active) return;
    active = false;
    clearInterval(tickTimer);
    clearTimeout(bootTimer);
    for (const { observer } of scopes.values()) observer.disconnect();
    for (const [root, listener] of loadListeners) root.removeEventListener('load', listener, true);
    loadListeners.clear();
    for (const root of scopes.keys()) {
      if (root.adoptedStyleSheets) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => !overrides.has(sheet));
      if (root !== document) root.querySelectorAll(`[${MARK}]`).forEach((node) => node.remove());
    }
    document.querySelectorAll(`[${MARK}]`).forEach((node) => node.remove());
    document.querySelectorAll(`[${ORIGINAL}]`).forEach((el) => {
      const original = el.getAttribute(ORIGINAL);
      if (original === NO_STYLE) el.removeAttribute('style');
      else el.setAttribute('style', original);
      el.removeAttribute(ORIGINAL);
    });
    document.documentElement.removeAttribute(`${MARK}-ready`);
    scopes.clear();
    entries.clear();
    overrides.clear();
    queue.clear();
    work.length = 0;
    lite = false;
    pendingDownloads = 0;
  }

  globalThis.SN = Object.freeze({ ...globalThis.SN, styles: Object.freeze({ start, stop, setFixes, stats: () => ({ ...stats, lite, windowMs: performance.now() - stats.since }), get running() { return active; } }) });
})();
