/*!
 * Sonámbulo — background: keyboard shortcuts, toolbar state and installation.
 * Pages configure themselves straight from storage, so this file stays small.
 *
 * Copyright 2026 radiowasnton
 * SPDX-License-Identifier: Apache-2.0
 */
if (typeof importScripts === 'function') importScripts('core.js');

(() => {
  'use strict';

  const { api, MODES, isDarkMode, hostKey, hostChain, load, saveSettings, saveSite, inSchedule, msToNextBoundary } = globalThis.SN;

  const CONTENT_FILES = ['src/core.js', 'src/engine/color.js', 'src/engine/styles.js', 'src/content.js'];

  const iconSet = (prefix) => Object.fromEntries([16, 32, 48, 128].map((size) => [size, `assets/brand/${prefix}-${size}.png`]));

  /** Toolbar icon mirrors whether Sonámbulo is currently running; an alarm wakes us at schedule boundaries. */
  async function syncToolbar() {
    const { settings } = await load();
    const running = settings.power && inSchedule(settings.schedule);
    await api.action.setIcon({ path: iconSet(running ? 'sonambulo' : 'sonambulo-paused') });

    await api.alarms.clear('schedule');
    const wait = msToNextBoundary(settings.schedule);
    if (wait !== null) api.alarms.create('schedule', { when: Date.now() + wait + 1000 });
  }

  /** Content scripts are not injected into tabs that were open before installing or updating. */
  async function injectIntoOpenTabs() {
    const tabs = await api.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
    await Promise.allSettled(
      tabs.map((tab) => api.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: CONTENT_FILES,
      })),
    );
  }

  /* ---------- keyboard shortcuts ---------- */

  async function currentPage() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    try {
      const state = await api.tabs.sendMessage(tab.id, { t: 'state' }, { frameId: 0 });
      return state?.cfg ? state : null;
    } catch {
      return null; // restricted page, or the page has no content script yet
    }
  }

  const shortcuts = {
    async 'toggle-power'() {
      const { settings } = await load();
      await saveSettings({ power: !settings.power });
    },
    async 'toggle-site'() {
      const page = await currentPage();
      if (!page) return;
      const { settings } = await load();
      const dark = isDarkMode(settings.defaultMode) ? settings.defaultMode : 'oled';
      await saveSite(page.host, { mode: page.cfg.mode === 'normal' ? dark : 'normal', hc: page.cfg.hc });
    },
    async 'cycle-mode'() {
      const page = await currentPage();
      if (page) await saveSite(page.host, { mode: MODES[(MODES.indexOf(page.cfg.mode) + 1) % MODES.length], hc: page.cfg.hc });
    },
    async 'toggle-contrast'() {
      const page = await currentPage();
      if (page) await saveSite(page.host, { mode: page.cfg.mode, hc: { ...page.cfg.hc, on: !page.cfg.hc.on } });
    },
  };

  api.commands.onCommand.addListener((name) => shortcuts[name]?.());

  /* ---------- lifecycle ---------- */

  api.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install') await saveSettings({});
    if (reason === 'install' || reason === 'update') await injectIntoOpenTabs();
    await syncToolbar();
  });

  api.runtime.onStartup.addListener(syncToolbar);
  api.alarms.onAlarm.addListener(syncToolbar);
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) syncToolbar();
  });

  /* ---------- services for the content scripts ---------- */

  const MAX_CSS_BYTES = 4 * 1024 * 1024;
  const FETCH_TIMEOUT_MS = 10000;
  const cssCache = new Map();

  /** Stylesheets from other origins cannot be read by the page's scripts, but the background may fetch them. */
  async function fetchCss(url) {
    if (!/^https?:\/\//i.test(url)) return null;
    if (cssCache.has(url)) return cssCache.get(url);
    try {
      const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const type = response.headers.get('content-type') ?? '';
      const text = response.ok && !type.includes('html') ? await response.text() : null;
      const css = text !== null && text.length <= MAX_CSS_BYTES ? text : null;
      if (cssCache.size >= 150) cssCache.delete(cssCache.keys().next().value);
      cssCache.set(url, css);
      return css;
    } catch {
      return null;
    }
  }

  let fixIndex = null;

  /** CSS patches for individual websites, shipped in data/site-fixes. */
  async function siteCss(url) {
    const host = hostKey(url);
    if (!host) return null;
    fixIndex ??= await (await fetch(api.runtime.getURL('data/site-fixes/index.json'))).json();

    const names = new Set(hostChain(host));
    for (const family of ['google', 'github', 'ebay']) if (host.includes(`${family}.`)) names.add(family);
    if (host.endsWith('.force.com')) names.add('salesforce.com');
    if (host === 'docs.google.com') names.add(`docs.google.com-${new URL(url).pathname.split('/')[1]}`);

    const files = [...names].filter((name) => fixIndex.includes(name));
    const parts = await Promise.all(files.map((name) => fetch(api.runtime.getURL(`data/site-fixes/${name}.css`)).then((r) => r.text())));
    return parts.join('\n') || null;
  }

  api.runtime.onMessage.addListener((message, sender, respond) => {
    switch (message?.t) {
      case 'topHost': // child frames cannot see the top-level URL, so they ask for it
        respond(hostKey(sender.tab?.url ?? ''));
        return false;
      case 'fetchCss':
        fetchCss(message.url).then(respond);
        return true;
      case 'siteCss':
        siteCss(message.url).then(respond, () => respond(null));
        return true;
      default:
        return false;
    }
  });
})();
