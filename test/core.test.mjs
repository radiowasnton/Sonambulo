// Unit tests for src/core.js — run with `npm test` (Node 20+, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadCore(initial = {}) {
  const data = { ...initial };
  const chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
        set: async (items) => Object.assign(data, structuredClone(items)),
      },
    },
  };
  const context = vm.createContext({ chrome, URL, btoa, atob, structuredClone, Date });
  context.globalThis = context;
  vm.runInContext(readFileSync(new URL('../extension/src/core.js', import.meta.url), 'utf8'), context);
  return { SN: context.SN, data };
}

const at = (h, m) => new Date(2026, 0, 1, h, m, 0);

test('hostKey: strips www, ports and rejects unsupported schemes', () => {
  const { SN } = loadCore();
  assert.equal(SN.hostKey('https://www.Example.com:8080/a?b#c'), 'example.com');
  assert.equal(SN.hostKey('file:///tmp/a.html'), 'file');
  assert.equal(SN.hostKey('chrome://extensions'), null);
  assert.equal(SN.hostKey('about:blank'), null);
  assert.equal(SN.hostKey('nonsense'), null);
});

test('parseHostInput: accepts URLs and bare domains, rejects junk', () => {
  const { SN } = loadCore();
  assert.equal(SN.parseHostInput(' https://www.Site.org/x '), 'site.org');
  assert.equal(SN.parseHostInput('docs.site.org'), 'docs.site.org');
  assert.equal(SN.parseHostInput(''), null);
  assert.equal(SN.parseHostInput('not a host'), null);
});

test('hostChain: walks up subdomains but never to the bare TLD', () => {
  const { SN } = loadCore();
  assert.deepEqual([...SN.hostChain('a.b.example.com')], ['a.b.example.com', 'b.example.com', 'example.com']);
  assert.deepEqual([...SN.hostChain('localhost')], ['localhost']);
});

test('resolve: exact record wins over parent domain, defaults apply otherwise', async () => {
  const { SN } = loadCore({ sites: { 'example.com': { mode: 'normal' }, 'a.example.com': { mode: 'filtered' } } });
  const store = await SN.load();
  assert.equal(SN.resolve(store, 'a.example.com').mode, 'filtered');
  assert.equal(SN.resolve(store, 'b.example.com').mode, 'normal');
  const other = SN.resolve(store, 'other.org');
  assert.equal(other.mode, 'oled');
  assert.equal(other.saved, false);
});

test('resolve: followOS only affects sites without a record', async () => {
  const { SN } = loadCore({ settings: { followOS: true }, sites: { 'x.com': { mode: 'dark' } } });
  const store = await SN.load();
  assert.equal(SN.resolve(store, 'y.com', false).mode, 'normal');
  assert.equal(SN.resolve(store, 'y.com', true).mode, 'oled');
  assert.equal(SN.resolve(store, 'x.com', false).mode, 'dark');
});

test('resolve: filtered mode starts with soft defaults until the user tunes it', async () => {
  const { SN } = loadCore({ sites: { 'x.com': { mode: 'filtered' } } });
  const cfg = SN.resolve(await SN.load(), 'x.com');
  assert.equal(cfg.tune.warmth, SN.FILTERED_TUNE.warmth);
  assert.equal(cfg.customTune, false);
});

test('modes: OLED is a main mode that is dark with pure black', async () => {
  const { SN } = loadCore({ sites: { 'a.com': { mode: 'oled' }, 'b.com': { mode: 'dark' } } });
  const store = await SN.load();
  assert.equal(SN.resolve(store, 'a.com').oled, true);
  assert.equal(SN.resolve(store, 'b.com').oled, false);
  assert.deepEqual([...SN.MODES], ['dark', 'oled', 'filtered', 'normal']);
  assert.equal(SN.isDarkMode('oled'), true);
  assert.equal(SN.isDarkMode('filtered'), false);
  assert.equal(SN.resolve(store, 'new.com').mode, 'oled'); // the default for new sites
});

test('modes: development builds that stored OLED apart from the mode are migrated', () => {
  const { SN } = loadCore();
  assert.equal(SN.normalizeSite({ mode: 'dark', oled: true }).mode, 'oled');
  assert.equal(SN.normalizeSite({ mode: 'dark', oled: false }).mode, 'dark');
  assert.equal(SN.normalizeSettings({ defaultMode: 'dark', oled: true }).defaultMode, 'oled');
  assert.equal(SN.normalizeSettings({ defaultMode: 'dark', oled: false }).defaultMode, 'dark');
  assert.equal('oled' in SN.normalizeSite({ mode: 'dark', oled: true }), false);
});

test('high contrast: stacked by default, alone when "stack" is off', () => {
  const { SN } = loadCore();
  assert.equal(SN.DEFAULT_HC.stack, true);
  assert.equal(SN.normalizeSite({ mode: 'oled', hc: { on: true } }).hc.stack, true); // missing means stacked
  assert.equal(SN.normalizeSite({ mode: 'oled', hc: { on: true, stack: false } }).hc.stack, false);

  const cfg = (mode, hc) => ({ mode, hc: { on: true, preset: 'boost', stack: true, ...hc } });
  // stacked: the mode acts first, then the scheme is applied to what it shows
  assert.equal(SN.modeApplies(cfg('oled')), true);
  assert.equal(SN.wantsDarkBase(cfg('oled')), true);
  assert.equal(SN.hcInverts(cfg('oled', { preset: 'invert' })), true); // it inverts the OLED look
  assert.equal(SN.hcInverts(cfg('filtered', { preset: 'yellow' })), true);
  assert.equal(SN.hcInverts(cfg('normal', { preset: 'boost' })), false);
  // alone: the mode is ignored
  assert.equal(SN.modeApplies(cfg('oled', { stack: false })), false);
  assert.equal(SN.wantsDarkBase(cfg('oled', { stack: false })), false);
  assert.equal(SN.hcInverts(cfg('oled', { preset: 'cyan', stack: false })), true);
  // high contrast off: plain modes
  assert.equal(SN.wantsDarkBase({ mode: 'dark', hc: { on: false, preset: 'yellow', stack: true } }), true);
  assert.equal(SN.hcInverts({ mode: 'normal', hc: { on: false, preset: 'yellow', stack: true } }), false);
});

test('schedule: overnight window and next boundary', () => {
  const { SN } = loadCore();
  const night = { on: true, from: '20:00', to: '07:00' };
  assert.equal(SN.inSchedule(night, at(23, 0)), true);
  assert.equal(SN.inSchedule(night, at(3, 0)), true);
  assert.equal(SN.inSchedule(night, at(12, 0)), false);
  assert.equal(SN.inSchedule({ ...night, on: false }, at(12, 0)), true);
  assert.equal(SN.msToNextBoundary(night, at(12, 0)), 8 * 3600000);
  assert.equal(SN.msToNextBoundary({ ...night, on: false }, at(12, 0)), null);
});

test('saveSite: seeds from the resolved config and merges nested patches', async () => {
  const { SN, data } = loadCore({ settings: { defaultMode: 'filtered' } });
  await SN.saveSite('a.com', { hc: { on: true, preset: 'cyan' } });
  assert.equal(data.sites['a.com'].mode, 'filtered');
  assert.deepEqual(data.sites['a.com'].hc, { on: true, preset: 'cyan', level: 60, stack: true });
  await SN.saveSite('a.com', { hc: { stack: false } });
  assert.equal(data.sites['a.com'].hc.stack, false);
  assert.equal(data.sites['a.com'].hc.preset, 'cyan');
  await SN.saveSite('a.com', { tune: { brightness: 70 } });
  assert.equal(data.sites['a.com'].tune.brightness, 70);
  assert.equal(data.sites['a.com'].tune.warmth, SN.FILTERED_TUNE.warmth);
  await SN.saveSite('a.com', { tune: null });
  assert.equal(data.sites['a.com'].tune, null);
});

test('normalizeSite: clamps out-of-range values and drops garbage', () => {
  const { SN } = loadCore();
  const site = SN.normalizeSite({ mode: 'weird', hc: { level: 999, preset: 'nope' }, tune: { brightness: 5, warmth: 'x' } });
  assert.equal(site.mode, 'normal');
  assert.equal(site.hc.level, 100);
  assert.equal(site.hc.preset, 'boost');
  assert.equal(site.tune.brightness, 50);
  assert.equal(site.tune.warmth, 0);
  assert.equal(SN.normalizeSite(null), null);
});

test('backup: round-trips current format and imports Sonámbulo 1.x files', async () => {
  const { SN, data } = loadCore({ sites: { 'a.com': { mode: 'dark' } } });
  const exported = JSON.stringify(await SN.exportData());
  const fresh = loadCore();
  assert.equal(await fresh.SN.importData(exported), 1);
  assert.equal(fresh.data.sites['a.com'].mode, 'dark');
  const oledRoundTrip = loadCore({ sites: { 'o.com': { mode: 'oled' } } });
  assert.equal(await fresh.SN.importData(JSON.stringify(await oledRoundTrip.SN.exportData())), 1);
  assert.equal(fresh.data.sites['o.com'].mode, 'oled');

  const legacy = btoa(JSON.stringify([
    { key: 'ws-github.com', value: '{"mode":1}' },
    { key: 'ws-wikipedia.org', value: '{"mode":4}' },
    { key: 'ws-docs.google.com/presentation', value: '{"mode":2}' },
    { key: 'global_settings', value: '{}' },
  ]));
  assert.equal(await fresh.SN.importData(legacy), 3);
  assert.equal(fresh.data.sites['github.com'].mode, 'oled'); // 1.x had OLED black on by default
  assert.equal(fresh.data.sites['wikipedia.org'].mode, 'normal');
  assert.equal(fresh.data.sites['docs.google.com'].mode, 'filtered');
  assert.ok(data);
});

test('backup: rejects files that are not backups', async () => {
  const { SN } = loadCore();
  await assert.rejects(SN.importData('{"hello":"world"}'));
  await assert.rejects(SN.importData('definitely not a backup'));
});

test('engine: per-site choice wins over the global default; defaults to styles', async () => {
  const { SN } = loadCore({ settings: { engine: 'render' }, sites: { 'a.com': { mode: 'dark', engine: 'styles' }, 'b.com': { mode: 'dark' } } });
  const store = await SN.load();
  assert.equal(SN.resolve(store, 'a.com').engine, 'styles');
  assert.equal(SN.resolve(store, 'b.com').engine, 'render');
  assert.equal(SN.resolve(store, 'c.com').engine, 'render');
  assert.equal(loadCore().SN.normalizeSettings({ engine: 'nope' }).engine, 'styles');
  assert.equal(SN.normalizeSite({ mode: 'dark', engine: 'nope' }).engine, null);
});

test('solid background and the light profile are per-site data and per-host rules', async () => {
  const { SN, data } = loadCore({ sites: { 'a.com': { mode: 'oled', solid: true }, 'b.com': { mode: 'oled' } } });
  const store = await SN.load();
  assert.equal(SN.resolve(store, 'a.com').solid, true);
  assert.equal(SN.resolve(store, 'b.com').solid, false);
  assert.equal(SN.resolve(store, 'new.org').solid, false);
  await SN.saveSite('b.com', { solid: true });
  assert.equal(data.sites['b.com'].solid, true);
  assert.equal(data.sites['b.com'].mode, 'oled'); // the other fields are kept
  assert.equal(SN.resolve(store, 'excel.officeapps.live.com').lite, true);
  assert.equal(SN.resolve(store, 'contoso.sharepoint.com').lite, true);
  assert.equal(SN.resolve(store, 'example.org').lite, false);
});
