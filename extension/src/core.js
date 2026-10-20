/*!
 * Sonámbulo — shared core: data model, per-site resolution and storage.
 * Loaded as a classic script by the background, the content script and the pages.
 *
 * Copyright 2026 radiowasnton
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;

  const MODES = ['dark', 'oled', 'filtered', 'normal'];
  const DARK_MODES = ['dark', 'oled'];
  const ENGINES = ['styles', 'render'];
  const PRESETS = ['boost', 'gray', 'invert', 'invertGray', 'yellow', 'cyan', 'green'];
  /** Presets that invert the page by themselves: each one is a complete dark scheme. */
  const INVERTING = ['invert', 'invertGray', 'yellow', 'cyan', 'green'];

  const NEUTRAL_TUNE = Object.freeze({ brightness: 100, contrast: 100, saturation: 100, warmth: 0 });
  const FILTERED_TUNE = Object.freeze({ brightness: 92, contrast: 100, saturation: 100, warmth: 35 });
  const TUNE_RANGE = Object.freeze({
    brightness: [50, 150],
    contrast: [50, 150],
    saturation: [0, 200],
    warmth: [0, 100],
  });

  /** Heavy web apps (Office on the web…) get the light profile of the Styles engine from the start. */
  const LITE_HOSTS = ['officeapps.live.com', 'office.com', 'office365.com', 'sharepoint.com', 'onedrive.live.com'];

  const DEFAULT_HC = Object.freeze({ on: false, preset: 'boost', level: 60, stack: true });
  const DEFAULT_SETTINGS = Object.freeze({
    power: true,
    defaultMode: 'oled',
    engine: 'styles',
    followOS: false,
    scrollbars: true,
    detectDark: true,
    schedule: Object.freeze({ on: false, from: '20:00', to: '07:00' }),
    lang: 'auto',
  });

  const clamp = (n, [min, max], fallback) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback);
  const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

  /* ---------- normalisation ---------- */

  function normalizeHC(raw) {
    const hc = raw && typeof raw === 'object' ? raw : {};
    return {
      on: hc.on === true,
      preset: pick(hc.preset, PRESETS, DEFAULT_HC.preset),
      level: clamp(hc.level, [0, 100], DEFAULT_HC.level),
      stack: hc.stack !== false,
    };
  }

  function normalizeTune(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const tune = {};
    for (const [key, range] of Object.entries(TUNE_RANGE)) tune[key] = clamp(raw[key], range, NEUTRAL_TUNE[key]);
    return tune;
  }

  function normalizeSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const sch = s.schedule && typeof s.schedule === 'object' ? s.schedule : {};
    let defaultMode = pick(s.defaultMode, MODES, DEFAULT_SETTINGS.defaultMode);
    if ('oled' in s && defaultMode === 'dark' && s.oled !== false) defaultMode = 'oled'; // development builds had a separate OLED switch
    return {
      power: s.power !== false,
      defaultMode,
      engine: pick(s.engine, ENGINES, DEFAULT_SETTINGS.engine),
      followOS: s.followOS === true,
      scrollbars: s.scrollbars !== false,
      detectDark: s.detectDark !== false,
      schedule: {
        on: sch.on === true,
        from: isTime(sch.from) ? sch.from : DEFAULT_SETTINGS.schedule.from,
        to: isTime(sch.to) ? sch.to : DEFAULT_SETTINGS.schedule.to,
      },
      lang: typeof s.lang === 'string' ? s.lang : 'auto',
    };
  }

  function normalizeSite(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let mode = pick(raw.mode, MODES, 'normal');
    if (mode === 'dark' && 'oled' in raw && raw.oled !== false) mode = 'oled'; // development builds stored OLED apart from the mode
    return {
      mode,
      engine: pick(raw.engine, ENGINES, null),
      solid: raw.solid === true,
      hc: normalizeHC(raw.hc),
      tune: normalizeTune(raw.tune),
    };
  }

  /* ---------- hosts ---------- */

  /** Storage key for a URL: hostname without "www.", or null for pages we cannot touch. */
  function hostKey(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') return 'file';
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.hostname.toLowerCase().replace(/^www\./, '') || null;
    } catch {
      return null;
    }
  }

  /** "a.b.example.com" → ["a.b.example.com", "b.example.com", "example.com"] */
  function hostChain(host) {
    const labels = host.split('.');
    const chain = [];
    for (let i = 0; i < labels.length - 1 || i === 0; i++) chain.push(labels.slice(i).join('.'));
    return chain;
  }

  /** Accepts "https://www.Example.com/path" or "example.com" and returns a clean key. */
  function parseHostInput(input) {
    const text = String(input ?? '').trim();
    if (!text) return null;
    const key = hostKey(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return key && /^[a-z\d.-]+$/.test(key) && key.length <= 253 ? key : null;
  }

  /* ---------- schedule ---------- */

  const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

  function inSchedule(schedule, now = new Date()) {
    if (!schedule.on) return true;
    const from = toMinutes(schedule.from);
    const to = toMinutes(schedule.to);
    const cur = now.getHours() * 60 + now.getMinutes();
    if (from === to) return true;
    return from < to ? cur >= from && cur < to : cur >= from || cur < to;
  }

  /** Milliseconds until the schedule flips, or null when there is no schedule. */
  function msToNextBoundary(schedule, now = new Date()) {
    if (!schedule.on || schedule.from === schedule.to) return null;
    const cur = now.getHours() * 60 + now.getMinutes();
    const delta = (target) => (((toMinutes(target) - cur) % 1440) + 1440) % 1440 || 1440;
    const minutes = Math.min(delta(schedule.from), delta(schedule.to));
    return minutes * 60000 - now.getSeconds() * 1000 - now.getMilliseconds();
  }

  const isDarkMode = (mode) => DARK_MODES.includes(mode);

  /* ---------- resolution ---------- */

  /**
   * Final configuration for a host.
   * @param {{settings:object, sites:object}} store
   * @param {string} host    key produced by hostKey()
   * @param {boolean} osDark whether the operating system prefers a dark theme
   */
  function resolve(store, host, osDark = false) {
    const { settings, sites } = store;
    const record = host ? hostChain(host).map((h) => sites[h]).find(Boolean) ?? null : null;

    let mode = settings.defaultMode;
    if (!record && settings.followOS) mode = osDark ? (isDarkMode(settings.defaultMode) ? settings.defaultMode : 'oled') : 'normal';
    if (record) mode = record.mode;

    return {
      active: settings.power && inSchedule(settings.schedule),
      host,
      saved: Boolean(record),
      mode,
      engine: record?.engine ?? settings.engine,
      solid: record?.solid ?? false,
      hc: record ? record.hc : { ...DEFAULT_HC },
      tune: record?.tune ?? (mode === 'filtered' ? { ...FILTERED_TUNE } : { ...NEUTRAL_TUNE }),
      customTune: Boolean(record?.tune),
      lite: host ? hostChain(host).some((h) => LITE_HOSTS.includes(h)) : false,
      oled: mode === 'oled',
      scrollbars: settings.scrollbars,
      detectDark: settings.detectDark,
    };
  }

  /**
   * With "stack" on (the default) a high-contrast scheme is applied to what the mode shows. With it off the
   * scheme is shown alone, exactly as the original standalone extension did: the changes of the mode
   * (dark engine, brightness, blue light…) are not applied.
   */
  const modeApplies = (cfg) => !cfg.hc.on || cfg.hc.stack;

  /** Whether a dark engine must provide the dark base. */
  const wantsDarkBase = (cfg) => isDarkMode(cfg.mode) && modeApplies(cfg);

  /** Whether the scheme inverts what is being shown (also when the mode has already made the page dark). */
  const hcInverts = (cfg) => cfg.hc.on && INVERTING.includes(cfg.hc.preset);

  /* ---------- storage ---------- */

  async function load() {
    const raw = await api.storage.local.get(['settings', 'sites', 'nativeDark']);
    const sites = {};
    for (const [host, rec] of Object.entries(raw.sites ?? {})) {
      const clean = normalizeSite(rec);
      if (clean) sites[host] = clean;
    }
    return { settings: normalizeSettings(raw.settings), sites, nativeDark: raw.nativeDark ?? {} };
  }

  async function saveSettings(patch) {
    const { settings } = await load();
    const next = normalizeSettings({ ...settings, ...patch, schedule: { ...settings.schedule, ...patch.schedule } });
    await api.storage.local.set({ settings: next });
    return next;
  }

  /** Create or update the record of a host. Missing fields are seeded from the current resolution. */
  async function saveSite(host, patch, osDark = false) {
    const store = await load();
    const cfg = resolve(store, host, osDark);
    const current = store.sites[host] ?? {
      mode: cfg.mode,
      engine: null,
      solid: cfg.solid,
      hc: cfg.hc,
      tune: cfg.customTune ? cfg.tune : null,
    };
    const next = normalizeSite({
      ...current,
      ...patch,
      hc: { ...current.hc, ...patch.hc },
      tune: patch.tune === null ? null : patch.tune ? { ...cfg.tune, ...patch.tune } : current.tune,
    });
    store.sites[host] = next;
    await api.storage.local.set({ sites: store.sites });
    return next;
  }

  async function removeSites(hosts) {
    const { sites } = await load();
    for (const host of hosts) delete sites[host];
    await api.storage.local.set({ sites });
  }

  /* ---------- backup ---------- */

  async function exportData() {
    const { settings, sites } = await load();
    return { app: 'sonambulo', version: 2, exportedAt: new Date().toISOString(), settings, sites };
  }

  /** Sonámbulo 1.x backups: base64 of [{key: "ws-host", value: "{\"mode\":1,…}"}]. */
  function fromLegacy(text) {
    const LEGACY_MODES = { 1: 'oled', 2: 'filtered', 4: 'normal' }; // 1.x turned OLED black on by default
    const entries = JSON.parse(atob(text.trim()));
    const sites = {};
    for (const { key, value } of entries) {
      if (typeof key !== 'string' || !key.startsWith('ws-')) continue;
      const host = parseHostInput(key.slice(3).replace(/^\*\./, '').split('/')[0]);
      let mode;
      try {
        mode = LEGACY_MODES[(typeof value === 'string' ? JSON.parse(value) : value)?.mode];
      } catch {
        continue; // damaged entry: skip it, keep importing the rest
      }
      if (host && mode && !sites[host]) sites[host] = { mode };
    }
    return { sites };
  }

  /** Parses a backup file (current or legacy). Throws when the content is not a backup. */
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = fromLegacy(text);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.sites !== 'object') {
      throw new Error('invalid-backup');
    }
    const sites = {};
    for (const [rawHost, rec] of Object.entries(data.sites)) {
      const host = parseHostInput(rawHost);
      const clean = normalizeSite(rec);
      if (host && clean) sites[host] = clean;
    }
    return { settings: data.settings ? normalizeSettings(data.settings) : null, sites };
  }

  async function importData(text) {
    const backup = parseBackup(text);
    const { sites } = await load();
    const merged = { ...sites, ...backup.sites };
    await api.storage.local.set({ sites: merged, ...(backup.settings && { settings: backup.settings }) });
    return Object.keys(backup.sites).length;
  }

  globalThis.SN = Object.freeze({
    api, MODES, DARK_MODES, ENGINES, PRESETS, INVERTING, NEUTRAL_TUNE, FILTERED_TUNE, TUNE_RANGE, DEFAULT_HC, DEFAULT_SETTINGS,
    hostKey, hostChain, parseHostInput, inSchedule, msToNextBoundary,
    isDarkMode, resolve, wantsDarkBase, hcInverts, modeApplies, normalizeSettings, normalizeSite,
    load, saveSettings, saveSite, removeSites, exportData, parseBackup, importData,
  });
})();
