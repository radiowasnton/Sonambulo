/*!
 * Sonámbulo — popup. Writes to storage; pages react live, so no reload is ever needed.
 *
 * Copyright 2026 radiowasnton
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
  'use strict';

  const { api, load, resolve, hostKey, inSchedule, saveSite, saveSettings, wantsDarkBase, modeApplies } = globalThis.SN;
  const { t } = globalThis.I18N;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const osDark = matchMedia('(prefers-color-scheme: dark)').matches;
  let host = null;
  let store;
  let cfg = null;

  /* Slider drags fire many events; merge them into one write. */
  let pending = null;
  let flushTimer = 0;
  function queue(patch) {
    pending = { ...pending, ...patch, hc: { ...pending?.hc, ...patch.hc }, tune: { ...pending?.tune, ...patch.tune } };
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 80);
  }
  function flush() {
    if (!pending) return;
    const patch = pending;
    pending = null;
    if (!patch.tune || !Object.keys(patch.tune).length) delete patch.tune;
    saveSite(host, patch, osDark);
  }

  const save = (patch) => saveSite(host, patch, osDark);
  const setChecked = (el, on) => el.setAttribute('aria-checked', String(on));

  function setSlider(input, value) {
    if (document.activeElement !== input) input.value = value;
    input.closest('.slider').querySelector('output').textContent = `${value}%`;
  }

  function render() {
    const { settings } = store;
    const scheduled = !inSchedule(settings.schedule);
    const running = settings.power && !scheduled;
    cfg = host ? resolve(store, host, osDark) : null;

    $('#unsupported').hidden = Boolean(host);
    $('#controls').hidden = !host;
    $('#host').textContent = host ?? '';
    $('#status').hidden = !host;

    const power = $('#power');
    power.setAttribute('aria-pressed', String(settings.power));
    $('#power-label').textContent = t(settings.power ? 'powerPause' : 'powerResume');

    if (!cfg) return;

    $('#status').textContent = t(!settings.power ? 'statusPaused' : scheduled ? 'statusScheduled' : cfg.saved ? 'statusSaved' : 'statusDefault');
    $('#controls').classList.toggle('is-off', !running);

    for (const button of $$('[data-mode]')) setChecked(button, button.dataset.mode === cfg.mode);
    // The engine matters whenever something is recolored: a dark mode, or a high-contrast scheme stacked on a mode.
    $('#engine-row').hidden = !(wantsDarkBase(cfg) || (cfg.hc.on && modeApplies(cfg)));
    for (const chip of $$('[data-engine]')) setChecked(chip, chip.dataset.engine === cfg.engine);
    $('#solid-row').hidden = !wantsDarkBase(cfg);
    $('#solid').checked = cfg.solid;
    $('#contrast-toggle').setAttribute('aria-pressed', String(cfg.hc.on));
    $('#contrast-panel').hidden = !cfg.hc.on;
    for (const chip of $$('[data-preset]')) setChecked(chip, chip.dataset.preset === cfg.hc.preset);
    $('#hc-stack').checked = cfg.hc.stack;
    setSlider($('#level'), cfg.hc.level);

    for (const input of $$('[data-tune]')) setSlider(input, cfg.tune[input.dataset.tune]);
    $('#reset').hidden = !cfg.customTune;
  }

  async function refresh() {
    store = await load();
    render();
  }

  function bind() {
    for (const button of $$('[data-mode]')) button.addEventListener('click', () => save({ mode: button.dataset.mode }));
    $('#solid').addEventListener('change', (e) => save({ solid: e.target.checked }));
    for (const chip of $$('[data-engine]')) chip.addEventListener('click', () => save({ engine: chip.dataset.engine }));
    $('#contrast-toggle').addEventListener('click', () => save({ hc: { on: !cfg.hc.on } }));
    for (const chip of $$('[data-preset]')) chip.addEventListener('click', () => save({ hc: { on: true, preset: chip.dataset.preset } }));

    $('#hc-stack').addEventListener('change', (e) => save({ hc: { stack: e.target.checked } }));
    $('#level').addEventListener('input', (e) => {
      setSlider(e.target, e.target.value);
      queue({ hc: { level: Number(e.target.value) } });
    });
    for (const input of $$('[data-tune]')) {
      input.addEventListener('input', () => {
        setSlider(input, input.value);
        queue({ tune: { [input.dataset.tune]: Number(input.value) } });
      });
    }
    $('#reset').addEventListener('click', () => save({ tune: null }));

    $('#power').addEventListener('click', () => saveSettings({ power: !store.settings.power }));
    $('#open-settings').addEventListener('click', () => openOptions('general'));
    $('#open-sites').addEventListener('click', () => openOptions('sites'));
    addEventListener('pagehide', flush);
  }

  async function openOptions(tab) {
    await api.storage.session.set({ optionsTab: tab });
    await api.runtime.openOptionsPage();
    close();
  }

  async function init() {
    store = await load();
    await globalThis.I18N.init(store.settings.lang);
    globalThis.I18N.apply();

    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    host = tab?.url ? hostKey(tab.url) : null;
    $('#version').textContent = `v${api.runtime.getManifest().version}`;

    bind();
    render();
    api.storage.onChanged.addListener((_changes, area) => area === 'local' && refresh());
  }

  init();
})();
