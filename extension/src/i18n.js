/*!
 * Sonámbulo — page translations. Loads _locales/<code>/messages.json directly so the in-app
 * language choice behaves exactly like the browser language (no chrome.i18n limitations).
 *
 * Copyright 2026 radiowasnton
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
  'use strict';

  const { api } = globalThis.SN;

  /** Native name of every shipped locale (code = folder name in _locales). */
  const LANGUAGES = {
    am: 'አማርኛ', ar: 'العربية', bg: 'Български', bn: 'বাংলা', ca: 'Català', cs: 'Čeština', da: 'Dansk',
    de: 'Deutsch', el: 'Ελληνικά', en: 'English', es: 'Español', et: 'Eesti', fa: 'فارسی', fi: 'Suomi',
    fil: 'Filipino', fr: 'Français', gu: 'ગુજરાતી', he: 'עברית', hi: 'हिन्दी', hr: 'Hrvatski', hu: 'Magyar',
    id: 'Bahasa Indonesia', it: 'Italiano', ja: '日本語', kn: 'ಕನ್ನಡ', ko: '한국어', lt: 'Lietuvių', lv: 'Latviešu',
    ml: 'മലയാളം', mr: 'मराठी', ms: 'Bahasa Melayu', nl: 'Nederlands', no: 'Norsk', pl: 'Polski',
    pt_BR: 'Português (Brasil)', pt_PT: 'Português (Portugal)', ro: 'Română', ru: 'Русский', sk: 'Slovenčina',
    sl: 'Slovenščina', sr: 'Српски', sv: 'Svenska', sw: 'Kiswahili', ta: 'தமிழ்', te: 'తెలుగు', th: 'ไทย',
    tr: 'Türkçe', uk: 'Українська', vi: 'Tiếng Việt', zh_CN: '简体中文', zh_TW: '繁體中文',
  };
  const RTL = new Set(['ar', 'fa', 'he']);
  const ALIASES = { nb: 'no', nn: 'no', tl: 'fil', pt: 'pt_BR', 'zh_HK': 'zh_TW', 'zh_SG': 'zh_CN', zh: 'zh_CN', iw: 'he' };

  /** Maps a browser UI language such as "es-AR" or "pt-BR" to a shipped locale code. */
  function matchLocale(tag) {
    const code = String(tag).replace('-', '_');
    const [base, region] = code.split('_');
    const candidates = [code, region && `${base}_${region.toUpperCase()}`, ALIASES[code], base, ALIASES[base]];
    return candidates.find((c) => c && c in LANGUAGES) ?? 'en';
  }

  async function fetchMessages(code) {
    const response = await fetch(api.runtime.getURL(`_locales/${code}/messages.json`));
    return response.json();
  }

  let messages = {};
  let fallback = {};
  let current = 'en';

  /** @param {string} choice "auto" or a locale code */
  async function init(choice = 'auto') {
    current = choice in LANGUAGES ? choice : matchLocale(api.i18n.getUILanguage());
    [messages, fallback] = await Promise.all([fetchMessages(current), current === 'en' ? {} : fetchMessages('en')]);
    document.documentElement.lang = current.replace('_', '-');
    document.documentElement.dir = RTL.has(current) ? 'rtl' : 'ltr';
  }

  const t = (key, vars = {}) =>
    (messages[key] ?? fallback[key] ?? { message: key }).message.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');

  /** Fills every element tagged with data-i18n, data-i18n-title, data-i18n-aria or data-i18n-placeholder. */
  function apply(scope = document) {
    for (const el of scope.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of scope.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of scope.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
    for (const el of scope.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  }

  globalThis.I18N = Object.freeze({ LANGUAGES, init, t, apply, get current() { return current; } });
})();
