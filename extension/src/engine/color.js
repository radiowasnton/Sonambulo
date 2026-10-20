/*!
 * Sonámbulo — colour model of the Styles engine.
 *
 * Every colour found in a CSS value is converted through HSL with two rule sets:
 *   background: light surfaces become dark, saturation is capped, pale yellows turn neutral;
 *   foreground: text and strokes are lifted to a readable lightness.
 * Pure white maps to true black (OLED) or a soft near-black.
 *
 * A high-contrast scheme can then be applied on top, still at colour level: inversion, grayscale,
 * a contrast curve and the original coloured tints. Because only CSS colours change, images are never touched.
 *
 * The converter works on CSS value strings (shorthands, gradients, shadows, var() fallbacks).
 *
 * Copyright 2026 radiowasnton
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
  'use strict';

  const SKIP_IDENTS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', 'auto']);
  const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);
  const MODERN_FUNCTIONS = new Set(['hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark']);
  const HEX = /^[0-9a-f]+$/i;

  /* ---------- colour math ---------- */

  /** Near-greys become exact greys so that tinted whites do not turn into tinted blacks. */
  function snapToGrey(rgb) {
    const low = Math.min(...rgb);
    const high = Math.max(...rgb);
    if (high - low > Math.round(8 + (4 * (255 - low)) / 255)) return rgb;
    const grey = low + Math.round((high - low) / 2);
    return [grey, grey, grey];
  }

  function rgbToHsl(input) {
    const [r, g, b] = snapToGrey(input).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (delta !== 0) {
      if (max === r) h = 60 * ((((g - b) / delta) % 6 + 6) % 6);
      else if (max === g) h = 60 * ((b - r) / delta + 2);
      else h = 60 * ((r - g) / delta + 4);
      s = delta / (1 - Math.abs(2 * l - 1));
    }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  }

  function hslToRgb([h, s, l]) {
    const sat = s / 100;
    const light = l / 100;
    const chroma = (1 - Math.abs(2 * light - 1)) * sat;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = chroma * (1 - Math.abs((hp % 2) - 1));
    const m = light - chroma / 2;
    const [r, g, b] = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][Math.min(5, Math.floor(hp))];
    return [r, g, b].map((v) => Math.round((v + m) * 255));
  }

  /** Colour matrices of the original high-contrast tints (rows: R, G, B over r, g, b). */
  const TINTS = {
    yellow: [[0.3, 0.5, 0.2], [0.3, 0.5, 0.2], [0, 0, 0]],
    cyan: [[0, 0.6, 0.4], [0, 0.6, 0.4], [0.2, 0.8, 1]],
    green: [[0, 0.6, 0], [0.2, 0.8, 0.2], [0, 0.2, 0]],
  };
  const GRAY_PRESETS = ['gray', 'invertGray'];
  const INVERT_PRESETS = ['invert', 'invertGray', 'yellow', 'cyan', 'green'];

  /**
   * @param {object} options
   * @param {boolean} [options.oled]   true black instead of a soft near-black
   * @param {boolean} [options.dark]   convert to a dark theme; false keeps the page's own colours
   * @param {{preset: string, level: number}|null} [options.scheme] high-contrast scheme applied afterwards
   * @param {(token: string) => number[]|null} [options.resolve] resolver for named and modern colours
   */
  function createConverter({ oled = true, dark = true, scheme = null, resolve = () => null } = {}) {
    const darkBackground = oled ? [0, 0, 0] : [240, 8, 12];

    function background([h, s, l]) {
      if (h === 0 && s === 0 && l === 100) return darkBackground;
      if (s > 60) s = 60;
      if (l > 90) s = 0;
      if (l > 60) l = 100 - l + 10;
      if (h > 40 && h <= 60 && s < 40) [h, s, l] = [44, 0, 14];
      if (h > 40 && h <= 60 && s > 40 && l < 70) [h, s, l] = [44, 100, 20]; // saturated yellows go to dark amber
      if (h > 90 && h <= 100 && s > 50 && l <= 55) [h, s, l] = [139, 61, 20]; // lime greens go to dark green
      return [h, s, l];
    }

    function foreground([h, s, l]) {
      return [h, Math.min(s, 60), Math.max(l, 75)];
    }

    const identity = (hsl) => hsl;
    // 'raw' skips the dark conversion: it is used for colours that are already final (the engine's own defaults).
    const transform = { bg: dark ? background : identity, fg: dark ? foreground : identity, raw: identity };

    const steepness = 4 + (scheme?.level ?? 60) * 0.1;
    const sigmoid = (x) => 1 / (1 + Math.exp(-steepness * (x - 0.5)));
    const curve = (x) => (sigmoid(x) - sigmoid(0)) / (sigmoid(1) - sigmoid(0));

    /** The high-contrast scheme, in the order of the original filter: grayscale, inversion, curve, tint. */
    function applyScheme([h, s, l]) {
      if (!scheme) return [h, s, l];
      if (GRAY_PRESETS.includes(scheme.preset)) s = 0;
      if (INVERT_PRESETS.includes(scheme.preset)) l = 100 - l;
      l = Math.round(curve(l / 100) * 100);
      const tint = TINTS[scheme.preset];
      if (!tint) return [h, s, l];
      const rgb = hslToRgb([h, s, l]).map((v) => v / 255);
      return rgbToHsl(tint.map(([r, g, b]) => Math.min(255, Math.round(255 * (r * rgb[0] + g * rgb[1] + b * rgb[2])))));
    }

    function toHsla(rgba, kind) {
      return { hsl: applyScheme(transform[kind](rgbToHsl(rgba))), alpha: rgba[3] };
    }

    const format = ({ hsl: [h, s, l], alpha }, alphaText) => `hsl(${h} ${s}% ${l}%${alphaText ?? (alpha < 1 ? ` / ${+alpha.toFixed(3)}` : '')})`;

    /* ---------- token readers ---------- */

    function readBalanced(text, open) {
      let depth = 0;
      for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '"' || c === "'") i = skipString(text, i);
        else if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return i;
      }
      return -1;
    }

    function skipString(text, start) {
      const quote = text[start];
      for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === quote) return i;
      }
      return text.length - 1;
    }

    function parseHex(token) {
      const hex = token.slice(1);
      if (!HEX.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
      const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
      const [r, g, b, a = 255] = full.match(/../g).map((p) => parseInt(p, 16));
      return [r, g, b, a / 255];
    }

    function parseChannel(text, scale) {
      const t = text.trim();
      return t.endsWith('%') ? (parseFloat(t) / 100) * scale : parseFloat(t);
    }

    /** rgb()/hsl() in legacy and modern syntax. The alpha is returned as source text so var() alphas survive. */
    function parseFunction(name, args) {
      const [colorPart, alphaPart] = args.includes('/') ? args.split('/') : [args, null];
      const parts = colorPart.trim().split(/[\s,]+/).filter(Boolean);
      let alphaText = alphaPart?.trim() ?? null;
      if (!alphaText && parts.length === 4) alphaText = parts.pop();
      if (parts.length !== 3 || parts.some((p) => p.includes('var('))) return null;
      let rgb;
      if (name.startsWith('rgb')) rgb = parts.map((p) => Math.min(255, Math.max(0, Math.round(parseChannel(p, 255)))));
      else rgb = hslToRgb([parseFloat(parts[0]), parseChannel(parts[1], 100), parseChannel(parts[2], 100)]);
      if (rgb.some(Number.isNaN)) return null;
      const alpha = alphaText === null ? 1 : Number.isFinite(Number(alphaText)) ? Number(alphaText) : alphaText.endsWith('%') ? parseFloat(alphaText) / 100 : 1;
      return { rgb, alphaText: alphaText !== null && !Number.isFinite(Number(alphaText)) && !alphaText.endsWith('%') ? alphaText : null, alpha };
    }

    /* ---------- value conversion ---------- */

    const cache = new Map();

    /**
     * Converts every colour of a CSS value and rewrites var() so colour variables have a
     * background variant (`--x-sn-bg`) next to the foreground one.
     * @param {string} value
     * @param {'bg'|'fg'} kind
     * @param {(url: string) => string} [absolutize] makes relative url() references absolute
     */
    function convertValue(value, kind, absolutize) {
      const key = `${kind}|${value}`;
      if (!absolutize && cache.has(key)) return cache.get(key);

      let out = '';
      let i = 0;
      while (i < value.length) {
        const c = value[i];

        if (c === '"' || c === "'") {
          const end = skipString(value, i);
          out += value.slice(i, end + 1);
          i = end + 1;
        } else if (c === '#') {
          let end = i + 1;
          while (end < value.length && /[0-9a-f]/i.test(value[end])) end++;
          const rgba = parseHex(value.slice(i, end));
          out += rgba ? format(toHsla(rgba, kind)) : value.slice(i, end);
          i = end;
        } else if (/[a-z_-]/i.test(c) && (i === 0 || !/[\w-]/.test(value[i - 1]))) {
          let end = i;
          while (end < value.length && /[\w-]/.test(value[end])) end++;
          const ident = value.slice(i, end).toLowerCase();

          if (value[end] === '(') {
            const close = readBalanced(value, end);
            if (close === -1) {
              out += value.slice(i);
              break;
            }
            const inner = value.slice(end + 1, close);
            if (ident === 'url') {
              const raw = inner.trim().replace(/^["']|["']$/g, '');
              out += absolutize && !/^(data:|#|[a-z]+:)/i.test(raw) ? `url("${absolutize(raw)}")` : value.slice(i, close + 1);
            } else if (ident === 'var') {
              out += rewriteVar(inner, kind, absolutize);
            } else if (COLOR_FUNCTIONS.has(ident)) {
              const parsed = parseFunction(ident, inner);
              if (parsed) out += format(toHsla([...parsed.rgb, parsed.alpha], kind), parsed.alphaText ? ` / ${parsed.alphaText}` : undefined);
              else if (inner.includes('var(')) out += `${value.slice(i, end + 1)}${convertValue(inner, kind, absolutize)})`; // rgb(var(--x) / .5): the variable carries the colour
              else out += value.slice(i, close + 1);
            } else if (MODERN_FUNCTIONS.has(ident) && !inner.includes('var(')) {
              const rgba = resolve(value.slice(i, close + 1));
              out += rgba ? format(toHsla(rgba, kind)) : value.slice(i, close + 1);
            } else {
              // gradients, calc(), filters…: keep the function and convert what is inside.
              out += `${value.slice(i, end + 1)}${convertValue(inner, kind, absolutize)})`;
            }
            i = close + 1;
          } else {
            const rgba = SKIP_IDENTS.has(ident) ? null : resolve(ident);
            out += rgba ? format(toHsla(rgba, kind)) : value.slice(i, end);
            i = end;
          }
        } else {
          out += c;
          i++;
        }
      }

      if (!absolutize) cache.set(key, out);
      return out;
    }

    /** var(--x, fallback) → background: var(--x-sn-bg, var(--x, fallback')) · foreground: var(--x, fallback') */
    function rewriteVar(inner, kind, absolutize) {
      const comma = inner.indexOf(',');
      const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
      const fallback = comma === -1 ? null : convertValue(inner.slice(comma + 1).trim(), kind, absolutize);
      const plain = `var(${name}${fallback === null ? '' : `, ${fallback}`})`;
      return kind === 'bg' ? `var(${name}-sn-bg, ${plain})` : plain;
    }

    /** `255 255 255` or `255, 255, 255` custom-property values (used as rgb(var(--x))). */
    function convertTriplet(value, kind) {
      const match = value.trim().match(/^(\d{1,3})(\s*,\s*|\s+)(\d{1,3})\2(\d{1,3})$/);
      if (!match) return null;
      const rgb = [match[1], match[3], match[4]].map(Number);
      if (rgb.some((n) => n > 255)) return null;
      return hslToRgb(transform[kind](rgbToHsl(rgb))).join(match[2]);
    }

    /** Lightness (0-100) a final colour ends up with once the scheme is applied; used to pick color-scheme. */
    const lightness = (hex) => toHsla(parseHex(hex), 'raw').hsl[2];

    return { convertValue, convertTriplet, lightness };
  }

  globalThis.SN = Object.freeze({ ...globalThis.SN, color: Object.freeze({ createConverter, rgbToHsl, hslToRgb }) });
})();
