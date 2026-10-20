/*!
 * Sonámbulo — settings page: general options, saved websites and backups.
 *
 * Copyright 2026 radiowasnton
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
  'use strict';

  const { api, MODES, ENGINES, PRESETS, TUNE_RANGE, load, resolve, saveSettings, saveSite, removeSites, exportData, importData, parseHostInput } = globalThis.SN;
  const { t, LANGUAGES } = globalThis.I18N;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const MODE_GLYPH = { dark: 'moon', oled: 'moon-solid', filtered: 'dimmed-sun', normal: 'sun' };
  const SHORTCUT_LABELS = {
    'toggle-site': 'cmdToggleSite',
    'cycle-mode': 'cmdCycleMode',
    'toggle-contrast': 'cmdToggleContrast',
    'toggle-power': 'cmdTogglePower',
  };

  let store;
  let filter = 'all';
  let query = '';

  const setChecked = (el, on) => el.setAttribute('aria-checked', String(on));

  function glyph(name) {
    const icon = document.createElement('i');
    icon.className = 'glyph';
    icon.dataset.g = name;
    return icon;
  }

  /* ---------- tabs ---------- */

  function showTab(name) {
    for (const tab of $$('[data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const view of $$('[data-view]')) view.hidden = view.dataset.view !== name;
  }

  /** The popup asks for a tab through session storage, since an options page cannot take URL parameters. */
  async function consumeRequestedTab() {
    const { optionsTab } = await api.storage.session.get('optionsTab');
    if (!optionsTab) return;
    await api.storage.session.remove('optionsTab');
    showTab(optionsTab);
  }

  /* ---------- general ---------- */

  function renderGeneral() {
    const { settings } = store;
    for (const button of $$('#default-mode [data-mode]')) setChecked(button, button.dataset.mode === settings.defaultMode);
    for (const button of $$('#default-engine [data-engine]')) setChecked(button, button.dataset.engine === settings.engine);
    for (const input of $$('[data-setting]')) input.checked = settings[input.dataset.setting];
    $('#schedule-on').checked = settings.schedule.on;
    $('#schedule-times').hidden = !settings.schedule.on;
    $('#schedule-from').value = settings.schedule.from;
    $('#schedule-to').value = settings.schedule.to;
    $('#language').value = settings.lang;
  }

  function buildLanguageSelect() {
    const select = $('#language');
    select.replaceChildren(new Option(t('languageAuto'), 'auto'));
    for (const [code, name] of Object.entries(LANGUAGES)) select.append(new Option(name, code));
  }

  async function renderShortcuts() {
    const list = $('#shortcuts');
    list.replaceChildren();
    const commands = await api.commands.getAll();
    for (const name of Object.keys(SHORTCUT_LABELS)) {
      const command = commands.find((c) => c.name === name);
      if (!command) continue;
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = t(SHORTCUT_LABELS[command.name]);
      const keys = document.createElement(command.shortcut ? 'kbd' : 'span');
      keys.textContent = command.shortcut || t('shortcutNone');
      if (!command.shortcut) keys.className = 'none';
      item.append(label, keys);
      list.append(item);
    }
  }

  async function changeShortcuts() {
    if (api.commands.openShortcutSettings) await api.commands.openShortcutSettings();
    else await api.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }

  /* ---------- websites ---------- */

  const PRESET_LABELS = { boost: 'hcBoost', gray: 'hcGray', invert: 'hcInvert', invertGray: 'hcInvertGray', yellow: 'hcYellow', cyan: 'hcCyan', green: 'hcGreen' };
  const TUNE_LABELS = { brightness: 'tuneBrightness', contrast: 'tuneContrast', saturation: 'tuneSaturation', warmth: 'tuneWarmth' };

  const rows = new Map(); // host → row controller, kept between renders so open panels and drags survive
  const expanded = new Set();

  const matchesFilter = (rec) => {
    if (filter === 'all') return true;
    if (filter === 'contrast') return rec.hc.on;
    return rec.mode === filter;
  };

  function element(tag, className, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.append(...children);
    return node;
  }

  function button(className, label, onClick, role) {
    const node = element('button', className);
    node.type = 'button';
    if (role) node.setAttribute('role', role);
    if (label) node.append(label);
    node.addEventListener('click', onClick);
    return node;
  }

  function iconButton(name, title, className, onClick) {
    const node = button(`icon-btn ${className}`, null, onClick);
    node.title = title;
    node.setAttribute('aria-label', title);
    node.append(glyph(name));
    return node;
  }

  function slider(labelKey, [min, max]) {
    const output = element('output');
    const input = Object.assign(element('input'), { type: 'range', min, max, step: 1 });
    return { input, output, node: element('label', 'slider', [element('span', '', [t(labelKey)]), output, input]) };
  }

  /** One website: its quick controls plus a panel (gear) with the complete configuration. */
  function createRow(host) {
    const row = { host, rec: null, cfg: null, pending: null, timer: 0 };

    // Slider drags fire many events; they are merged into a single write.
    const queue = (patch) => {
      row.pending = { ...row.pending, ...patch, hc: { ...row.pending?.hc, ...patch.hc }, tune: { ...row.pending?.tune, ...patch.tune } };
      clearTimeout(row.timer);
      row.timer = setTimeout(() => {
        const next = row.pending;
        row.pending = null;
        if (!Object.keys(next.tune).length) delete next.tune;
        saveSite(host, next);
      }, 80);
    };

    /* quick controls */
    row.modeButtons = MODES.map((mode) => {
      const node = button('seg-item', null, () => saveSite(host, { mode }), 'radio');
      node.dataset.mode = mode;
      node.append(glyph(MODE_GLYPH[mode]), t(`mode${mode[0].toUpperCase()}${mode.slice(1)}`));
      return node;
    });
    const modes = element('div', 'seg', row.modeButtons);
    modes.setAttribute('role', 'radiogroup');

    row.contrastButton = button('seg-item contrast', null, () => saveSite(host, { hc: { on: !row.rec.hc.on } }));
    row.contrastButton.title = t('modeContrast');
    row.contrastButton.setAttribute('aria-label', t('modeContrast'));
    row.contrastButton.append(glyph('contrast'));

    row.gear = iconButton('gear', t('navSettings'), 'gear', () => {
      if (!expanded.delete(host)) expanded.add(host);
      row.sync();
    });
    const remove = iconButton('trash', t('sitesRemove'), 'remove', () => removeSites([host]));
    const head = element('div', 'site-head', [
      element('span', 'site-name', [host]),
      element('div', 'site-controls', [element('div', 'seg', [row.contrastButton]), modes, row.gear, remove]),
    ]);

    /* detail panel */
    row.engineChips = ENGINES.map((engine) => {
      const node = button('chip', t(`engine${engine[0].toUpperCase()}${engine.slice(1)}`), () => saveSite(host, { engine }), 'radio');
      node.dataset.engine = engine;
      node.title = t(`hintEngine${engine[0].toUpperCase()}${engine.slice(1)}`);
      return node;
    });
    row.presetChips = PRESETS.map((preset) => {
      const node = button('chip', t(PRESET_LABELS[preset]), () => saveSite(host, { hc: { on: true, preset } }), 'radio');
      node.dataset.preset = preset;
      return node;
    });

    row.stack = Object.assign(element('input'), { type: 'checkbox' });
    row.stack.addEventListener('change', () => saveSite(host, { hc: { stack: row.stack.checked } }));
    const stackRow = element('label', 'row', [element('span', '', [t('hcStack')]), element('span', 'switch', [row.stack, element('span')])]);
    stackRow.title = t('hintHcStack');

    row.level = slider('hcIntensity', [0, 100]);
    row.level.input.addEventListener('input', () => {
      row.level.output.textContent = `${row.level.input.value}%`;
      queue({ hc: { level: Number(row.level.input.value) } });
    });

    row.tune = Object.fromEntries(Object.entries(TUNE_RANGE).map(([key, range]) => {
      const control = slider(TUNE_LABELS[key], range);
      control.input.addEventListener('input', () => {
        control.output.textContent = `${control.input.value}%`;
        queue({ tune: { [key]: Number(control.input.value) } });
      });
      return [key, control];
    }));
    row.reset = button('btn', null, () => saveSite(host, { tune: null }));
    row.reset.append(glyph('reset'), t('reset'));

    row.solid = Object.assign(element('input'), { type: 'checkbox' });
    row.solid.addEventListener('change', () => saveSite(host, { solid: row.solid.checked }));
    const solidRow = element('label', 'row', [element('span', '', [t('solidBg')]), element('span', 'switch', [row.solid, element('span')])]);
    solidRow.title = t('hintSolidBg');

    const block = (title, ...children) => element('section', 'detail-block', [element('h3', '', [title]), ...children]);
    row.detail = element('div', 'site-detail', [
      block(t('engine'), element('div', 'chips', row.engineChips), solidRow),
      block(t('modeContrast'), element('div', 'chips', row.presetChips), stackRow, row.level.node),
      block(t('tuneTitle'), ...Object.values(row.tune).map((c) => c.node), row.reset),
    ]);
    row.detail.hidden = true;

    row.li = element('li', '', [head, row.detail]);

    row.sync = () => {
      const { rec, cfg } = row;
      const open = expanded.has(host);
      row.detail.hidden = !open;
      row.gear.setAttribute('aria-expanded', String(open));
      for (const node of row.modeButtons) setChecked(node, node.dataset.mode === rec.mode);
      row.contrastButton.setAttribute('aria-pressed', String(rec.hc.on));
      for (const node of row.engineChips) setChecked(node, node.dataset.engine === cfg.engine);
      for (const node of row.presetChips) setChecked(node, node.dataset.preset === rec.hc.preset);
      row.stack.checked = rec.hc.stack;
      row.solid.checked = cfg.solid;
      const set = (control, value) => {
        if (document.activeElement !== control.input) control.input.value = value;
        control.output.textContent = `${value}%`;
      };
      set(row.level, rec.hc.level);
      for (const [key, control] of Object.entries(row.tune)) set(control, cfg.tune[key]);
      row.reset.hidden = !cfg.customTune;
    };
    return row;
  }

  function renderSites() {
    for (const chip of $$('[data-filter]')) setChecked(chip, chip.dataset.filter === filter);

    const all = Object.entries(store.sites).sort(([a], [b]) => a.localeCompare(b));
    const shown = all.filter(([host, rec]) => host.includes(query) && matchesFilter(rec));

    for (const host of [...rows.keys()]) {
      if (!(host in store.sites)) {
        rows.delete(host);
        expanded.delete(host);
      }
    }
    const list = $('#sites');
    const wanted = shown.map(([host, rec]) => {
      const row = rows.get(host) ?? createRow(host);
      rows.set(host, row);
      row.rec = rec;
      row.cfg = resolve(store, host);
      row.sync();
      return row.li;
    });
    // Moving nodes drops focus, so the list is only rebuilt when its content or order changed.
    if (wanted.length !== list.children.length || wanted.some((li, i) => li !== list.children[i])) list.replaceChildren(...wanted);

    const empty = $('#empty');
    empty.hidden = shown.length > 0;
    empty.textContent = t('sitesEmpty');
    $('#remove-all').hidden = all.length === 0;
  }

  async function addSite(event) {
    event.preventDefault();
    const input = $('#add-host');
    const host = parseHostInput(input.value);
    const error = $('#add-error');
    error.hidden = Boolean(host);
    error.textContent = t('sitesInvalid');
    if (!host) return;
    input.value = '';
    await saveSite(host, {});
  }

  async function confirmRemoveAll() {
    const dialog = $('#confirm');
    dialog.addEventListener('close', () => dialog.returnValue === 'ok' && removeSites(Object.keys(store.sites)), { once: true });
    dialog.showModal();
  }

  /* ---------- backup ---------- */

  function showResult(message, isError) {
    const result = $('#backup-result');
    result.hidden = false;
    result.textContent = message;
    result.classList.toggle('is-error', isError);
  }

  async function downloadBackup() {
    const blob = new Blob([JSON.stringify(await exportData(), null, 2)], { type: 'application/json' });
    const link = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `sonambulo-backup-${new Date().toISOString().slice(0, 10)}.json`,
    });
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function restoreBackup(file) {
    try {
      showResult(t('backupImported', { count: await importData(await file.text()) }), false);
    } catch {
      showResult(t('backupInvalid'), true);
    }
  }

  /* ---------- wiring ---------- */

  function bind() {
    for (const tab of $$('[data-tab]')) tab.addEventListener('click', () => showTab(tab.dataset.tab));

    for (const button of $$('#default-mode [data-mode]')) button.addEventListener('click', () => saveSettings({ defaultMode: button.dataset.mode }));
    for (const button of $$('#default-engine [data-engine]')) button.addEventListener('click', () => saveSettings({ engine: button.dataset.engine }));
    for (const input of $$('[data-setting]')) input.addEventListener('change', () => saveSettings({ [input.dataset.setting]: input.checked }));
    $('#schedule-on').addEventListener('change', (e) => saveSettings({ schedule: { on: e.target.checked } }));
    $('#schedule-from').addEventListener('change', (e) => e.target.value && saveSettings({ schedule: { from: e.target.value } }));
    $('#schedule-to').addEventListener('change', (e) => e.target.value && saveSettings({ schedule: { to: e.target.value } }));
    $('#language').addEventListener('change', async (e) => {
      await saveSettings({ lang: e.target.value });
      location.reload();
    });
    $('#shortcuts-change').addEventListener('click', () => changeShortcuts().catch(() => {}));

    $('#search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderSites(); });
    for (const chip of $$('[data-filter]')) chip.addEventListener('click', () => { filter = chip.dataset.filter; renderSites(); });
    $('#add-form').addEventListener('submit', addSite);
    $('#remove-all').addEventListener('click', confirmRemoveAll);

    $('#export').addEventListener('click', downloadBackup);
    $('#import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      if (e.target.files[0]) restoreBackup(e.target.files[0]);
      e.target.value = '';
    });

    api.storage.onChanged.addListener(async (_changes, area) => {
      if (area !== 'local') return;
      store = await load();
      renderGeneral();
      renderSites();
    });
    api.storage.session.onChanged.addListener((changes) => changes.optionsTab && consumeRequestedTab());
  }

  async function init() {
    store = await load();
    await globalThis.I18N.init(store.settings.lang);
    globalThis.I18N.apply();
    document.title = `Sonámbulo — ${t('navSettings')}`;
    $('#about').textContent = t('aboutLine', { version: api.runtime.getManifest().version });

    buildLanguageSelect();
    bind();
    renderGeneral();
    renderSites();
    renderShortcuts();
    showTab('general');
    consumeRequestedTab();
  }

  init();
})();
