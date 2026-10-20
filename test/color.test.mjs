// Unit tests for src/engine/color.js — run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const NAMES = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], red: [255, 0, 0, 1] };

function load({ oled = true, dark = true, scheme = null } = {}) {
  const context = vm.createContext({});
  context.globalThis = context;
  vm.runInContext(readFileSync(new URL('../extension/src/engine/color.js', import.meta.url), 'utf8'), context);
  return context.SN.color.createConverter({ oled, dark, scheme, resolve: (token) => NAMES[token.toLowerCase()] ?? null });
}

test('background: pure white becomes true black (OLED) or a soft near-black', () => {
  assert.equal(load().convertValue('#fff', 'bg'), 'hsl(0 0% 0%)');
  assert.equal(load().convertValue('white', 'bg'), 'hsl(0 0% 0%)');
  assert.equal(load({ oled: false }).convertValue('#ffffff', 'bg'), 'hsl(240 8% 12%)');
});

test('background: light surfaces are flipped, mid tones and darks are kept', () => {
  const c = load();
  assert.equal(c.convertValue('#f5f5f5', 'bg'), 'hsl(0 0% 14%)');
  assert.equal(c.convertValue('#dddddd', 'bg'), 'hsl(0 0% 23%)');
  assert.equal(c.convertValue('#888', 'bg'), 'hsl(0 0% 53%)');
  assert.equal(c.convertValue('#222', 'bg'), 'hsl(0 0% 13%)');
  assert.equal(c.convertValue('#0b57d0', 'bg'), 'hsl(217 60% 43%)');
});

test('background: pale yellows turn into dark amber', () => {
  assert.equal(load().convertValue('#fff3cd', 'bg'), 'hsl(44 100% 20%)');
});

test('foreground: text is lifted to a readable lightness and keeps its hue', () => {
  const c = load();
  assert.equal(c.convertValue('#000', 'fg'), 'hsl(0 0% 75%)');
  assert.equal(c.convertValue('#777', 'fg'), 'hsl(0 0% 75%)');
  assert.equal(c.convertValue('#0b57d0', 'fg'), 'hsl(217 60% 75%)');
  assert.equal(c.convertValue('red', 'fg'), 'hsl(0 60% 75%)');
});

test('shorthands, gradients, shadows and alpha keep their structure', () => {
  const c = load();
  assert.equal(c.convertValue('1px solid #ddd', 'bg'), '1px solid hsl(0 0% 23%)');
  assert.equal(c.convertValue('linear-gradient(#fff, rgba(255,255,255,.5))', 'bg'), 'linear-gradient(hsl(0 0% 0%), hsl(0 0% 0% / 0.5))');
  assert.equal(c.convertValue('0 1px 3px rgba(0,0,0,.2)', 'bg'), '0 1px 3px hsl(0 0% 0% / 0.2)');
});

test('url() and strings are never touched; relative urls can be made absolute', () => {
  const c = load();
  assert.equal(c.convertValue('url(a.png) no-repeat #fff', 'bg'), 'url(a.png) no-repeat hsl(0 0% 0%)');
  assert.equal(c.convertValue('url("#fff.svg")', 'bg'), 'url("#fff.svg")');
  assert.equal(c.convertValue('url(a.png) #fff', 'bg', (u) => `https://x.test/${u}`), 'url("https://x.test/a.png") hsl(0 0% 0%)');
});

test('values without colours are returned unchanged', () => {
  const c = load();
  for (const v of ['none', '10px solid', 'transparent', 'currentColor', 'inherit', 'repeat-x']) assert.equal(c.convertValue(v, 'bg'), v);
});

test('CSS variables: background uses a dedicated variant, foreground keeps the original', () => {
  const c = load();
  assert.equal(c.convertValue('var(--bg, #fff)', 'bg'), 'var(--bg-sn-bg, var(--bg, hsl(0 0% 0%)))');
  assert.equal(c.convertValue('var(--fg)', 'fg'), 'var(--fg)');
  assert.equal(c.convertValue('rgb(255 255 255 / var(--o))', 'bg'), 'hsl(0 0% 0% / var(--o))');
});

test('rgb() built from variables rewrites the variable, not the function', () => {
  assert.equal(load().convertValue('rgb(var(--card) / 1)', 'bg'), 'rgb(var(--card-sn-bg, var(--card)) / 1)');
});

test('rgb triplets used as rgb(var(--x)) are converted as numbers', () => {
  const c = load();
  assert.equal(c.convertTriplet('255 255 255', 'bg'), '0 0 0');
  assert.equal(c.convertTriplet('17, 24, 39', 'fg'), '166, 182, 216');
  assert.equal(c.convertTriplet('1px 2px 3px', 'fg'), null);
});

test('without the dark conversion the page keeps its own colours', () => {
  const c = load({ dark: false });
  assert.equal(c.convertValue('#ffffff', 'bg'), 'hsl(0 0% 100%)');
  assert.equal(c.convertValue('#222', 'fg'), 'hsl(0 0% 13%)');
});

test('scheme: inversion flips what is shown; a dark mode becomes light and vice versa', () => {
  const invert = { preset: 'invert', level: 60 };
  assert.equal(load({ scheme: invert }).convertValue('#fff', 'bg'), 'hsl(0 0% 100%)'); // OLED black → white
  assert.match(load({ scheme: invert }).convertValue('#000', 'fg'), /^hsl\(0 0% ([0-9]|1[0-4])%\)$/); // light text → dark text
  assert.equal(load({ dark: false, scheme: invert }).convertValue('#ffffff', 'bg'), 'hsl(0 0% 0%)'); // a light page → black
});

test('scheme: grayscale removes colour, tints use the original matrices', () => {
  assert.match(load({ dark: false, scheme: { preset: 'gray', level: 60 } }).convertValue('#0b57d0', 'fg'), /^hsl\(\d+ 0% /);
  const yellow = load({ dark: false, scheme: { preset: 'yellow', level: 60 } });
  assert.equal(yellow.convertValue('#ffffff', 'bg'), 'hsl(0 0% 0%)'); // white page → black
  assert.match(yellow.convertValue('#000000', 'fg'), /^hsl\(60 100% /); // black text → yellow
});

test('scheme: lightness helper reports what a default ends up as', () => {
  assert.equal(load({ dark: false }).lightness('#ffffff'), 100);
  assert.equal(load({ dark: false, scheme: { preset: 'invert', level: 60 } }).lightness('#ffffff'), 0);
});
