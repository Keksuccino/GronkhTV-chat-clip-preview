// ==UserScript==
// @name         Gronkh.tv Twitch Clip Preview
// @namespace    https://gronkh.tv/
// @version      0.1.0
// @description  Replace single Twitch clip links in chat with a compact preview card.
// @match        https://gronkh.tv/streams/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      twitch.tv
// @connect      www.twitch.tv
// @connect      clips.twitch.tv
// ==/UserScript==

(function () {
  'use strict';

  if (!location.pathname.startsWith('/streams/')) return;

  const STYLE_ID = 'tm-gronkh-clip-preview-style';
  const MESSAGE_CLASS = 'tm-clip-message';
  const PREVIEW_CLASS = 'tm-clip-preview';
  const PROCESSED_ATTR = 'data-tm-clip-preview';
  const DEBUG = false;

  const clipCache = new Map();
  const observedContainers = new Set();

  const CLIP_URL_RE = /^https?:\/\/(?:www\.)?(?:twitch\.tv\/(?:[^/]+\/clip\/|clip\/)|clips\.twitch\.tv\/)([A-Za-z0-9_-]+)(?:\?.*)?$/i;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .cr-message.${MESSAGE_CLASS} {
        display: block !important;
      }

      .cr-message.${MESSAGE_CLASS} .${PREVIEW_CLASS} {
        display: inline-flex;
        align-items: center;
        gap: 0.6rem;
        width: 100%;
        max-width: 100%;
        margin: 0.2rem 0;
        padding: 0.45rem 0.55rem;
        border-radius: 0.7rem;
        background: linear-gradient(135deg, rgba(148, 70, 255, 0.35), rgba(236, 63, 199, 0.22), rgba(12, 10, 20, 0.7));
        border: 1px solid rgba(205, 120, 255, 0.35);
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(6px);
        cursor: pointer;
        transition: box-shadow 160ms ease, border-color 160ms ease, transform 160ms ease;
      }

      .cr-message.${MESSAGE_CLASS} .${PREVIEW_CLASS}[data-status="loading"] {
        opacity: 0.85;
      }

      .cr-message.${MESSAGE_CLASS} .${PREVIEW_CLASS}:hover {
        border-color: rgba(236, 154, 255, 0.7);
        transform: translateY(-1px);
      }

      .cr-message.${MESSAGE_CLASS} .${PREVIEW_CLASS} {
        color: inherit;
        text-decoration: none;
      }

      .cr-message.${MESSAGE_CLASS} .${PREVIEW_CLASS}:focus-visible {
        outline: 2px solid rgba(120, 200, 255, 0.6);
        outline-offset: 2px;
        border-radius: 0.4rem;
      }

      .tm-clip-thumb {
        position: relative;
        width: 96px;
        height: 54px;
        border-radius: 0.55rem;
        overflow: hidden;
        flex: 0 0 auto;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: linear-gradient(160deg, rgba(83, 153, 255, 0.35), rgba(10, 12, 20, 0.8));
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
      }

      .tm-clip-thumb img {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: cover;
      }

      .tm-clip-thumb::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.4));
      }

      .tm-clip-play {
        position: absolute;
        inset: auto 0.4rem 0.35rem auto;
        padding: 0.1rem 0.35rem;
        border-radius: 999px;
        font-size: 0.6rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        background: rgba(12, 18, 30, 0.75);
        border: 1px solid rgba(255, 255, 255, 0.22);
      }

      .tm-clip-meta {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 0;
        pointer-events: none;
      }

      .tm-clip-title {
        font-size: 0.85rem;
        font-weight: 600;
        line-height: 1.2;
        color: #eef5ff;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        pointer-events: none;
      }

      .tm-clip-sub {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(230, 240, 255, 0.65);
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  function isClipUrl(text) {
    return CLIP_URL_RE.test(text);
  }

  function extractClipUrl(messageEl) {
    const text = messageEl.textContent.trim();
    if (!text || !isClipUrl(text)) return null;

    const anchors = messageEl.querySelectorAll('a');
    if (anchors.length > 1) return null;

    const anchor = anchors.length === 1 ? anchors[0] : null;
    if (anchor) {
      const elements = messageEl.querySelectorAll('*');
      for (const el of elements) {
        if (el === anchor) continue;
        if (anchor.contains(el)) continue;
        if (el.contains(anchor)) continue;
        return null;
      }

      const walker = document.createTreeWalker(messageEl, NodeFilter.SHOW_TEXT, null);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent || node.textContent.trim() === '') continue;
        if (!anchor.contains(node)) return null;
      }
    } else if (messageEl.querySelector('*')) {
      return null;
    }

    const url = anchor ? anchor.href : text;
    if (!isClipUrl(url)) return null;
    return url;
  }

  function buildPreview(url) {
    const root = document.createElement('a');
    root.className = PREVIEW_CLASS;
    root.setAttribute('data-status', 'loading');
    root.href = url;
    root.target = '_blank';
    root.rel = 'noopener noreferrer';
    root.setAttribute('aria-label', 'Open Twitch clip');

    const thumbLink = document.createElement('div');
    thumbLink.className = 'tm-clip-thumb';

    const img = document.createElement('img');
    img.alt = 'Twitch clip preview';
    img.loading = 'lazy';
    thumbLink.appendChild(img);

    const play = document.createElement('span');
    play.className = 'tm-clip-play';
    play.textContent = 'Clip';
    play.setAttribute('aria-hidden', 'true');
    thumbLink.appendChild(play);

    const meta = document.createElement('div');
    meta.className = 'tm-clip-meta';

    const title = document.createElement('span');
    title.className = 'tm-clip-title';
    title.textContent = 'Twitch Clip';

    const sub = document.createElement('div');
    sub.className = 'tm-clip-sub';
    sub.textContent = 'Twitch Clip';

    meta.appendChild(title);
    meta.appendChild(sub);

    root.appendChild(thumbLink);
    root.appendChild(meta);

    return { root, img, title, sub, thumbLink };
  }

  function logDebug(...args) {
    if (!DEBUG) return;
    // eslint-disable-next-line no-console
    console.info('[tm-clip-preview]', ...args);
  }

  function requestText(url) {
    if (typeof GM_xmlhttpRequest !== 'function') {
      logDebug('GM_xmlhttpRequest not available, falling back to fetch:', url);
      return fetch(url, { credentials: 'omit' }).then((response) => {
        logDebug('fetch status:', response.status);
        if (!response.ok) throw new Error('oEmbed request failed');
        return response.text();
      });
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        anonymous: true,
        onload: (response) => {
          logDebug('GM_xmlhttpRequest status:', response && response.status);
          if (!response || response.status < 200 || response.status >= 300) {
            reject(new Error('oEmbed request failed'));
            return;
          }
          resolve(response.responseText || response.response || '');
        },
        onerror: () => reject(new Error('oEmbed request failed'))
      });
    });
  }

  function parseClipMeta(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const readMeta = (selector) => {
      const el = doc.querySelector(selector);
      return el ? (el.getAttribute('content') || '').trim() : '';
    };

    const title = readMeta('meta[property="og:title"]') || readMeta('meta[name="twitter:title"]') || doc.title || '';
    const thumbnail =
      readMeta('meta[property="og:image"]') ||
      readMeta('meta[name="twitter:image"]') ||
      readMeta('meta[name="twitter:image:src"]');
    const author = readMeta('meta[name="twitter:creator"]') || readMeta('meta[name="author"]');

    return { title, thumbnail, author };
  }

  function fetchClipInfo(url) {
    if (clipCache.has(url)) return clipCache.get(url);

    const request = requestText(url)
      .then((html) => {
        const meta = parseClipMeta(html);
        const title = meta.title || 'Twitch Clip';
        const thumbnail = meta.thumbnail || '';
        const author = meta.author || '';
        const looksGeneric =
          title.toLowerCase() === 'twitch' &&
          (!thumbnail || thumbnail.includes('twitch_logo') || thumbnail.includes('ttv-static-metadata'));
        if (!title || looksGeneric) {
          throw new Error('Clip metadata not found');
        }
        return { title, thumbnail, author };
      });

    clipCache.set(url, request);
    return request;
  }

  function applyPreview(messageEl, url) {
    if (!messageEl || messageEl.getAttribute(PROCESSED_ATTR)) return;

    messageEl.setAttribute(PROCESSED_ATTR, '1');
    messageEl.classList.add(MESSAGE_CLASS);

    const preview = buildPreview(url);
    messageEl.textContent = '';
    messageEl.appendChild(preview.root);

    fetchClipInfo(url)
      .then((data) => {
        if (!preview.root.isConnected) return;
        preview.title.textContent = data.title;
        preview.sub.textContent = data.author ? `Clip by ${data.author}` : 'Twitch Clip';
        if (data.thumbnail) {
          preview.img.src = data.thumbnail;
          preview.img.alt = data.title;
        }
        preview.root.setAttribute('data-status', 'ready');
      })
      .catch((error) => {
        if (!preview.root.isConnected) return;
        logDebug('oEmbed failed for', url, error);
        preview.title.textContent = 'Twitch Clip';
        preview.sub.textContent = 'Preview unavailable';
        preview.root.setAttribute('data-status', 'error');
      });
  }

  function processMessageBox(box) {
    if (!(box instanceof HTMLElement)) return;
    const messageEl = box.querySelector('.cr-message');
    if (!messageEl) return;
    if (messageEl.getAttribute(PROCESSED_ATTR)) return;

    const url = extractClipUrl(messageEl);
    if (!url) return;

    applyPreview(messageEl, url);
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;

    if (root.classList && root.classList.contains('cr-message-box')) {
      processMessageBox(root);
    }

    if (root.querySelectorAll) {
      root.querySelectorAll('.cr-message-box').forEach(processMessageBox);
    }
  }

  function observeContainer(container) {
    if (!container || observedContainers.has(container)) return;
    observedContainers.add(container);

    scan(container);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => scan(node));
      }
    });

    observer.observe(container, { childList: true, subtree: true });
  }

  function tryInit() {
    const containers = document.querySelectorAll('grnk-chat-replay .cr-message-container, grnk-chat .cr-message-container');
    containers.forEach(observeContainer);
  }

  function watchDom() {
    ensureStyle();
    const observer = new MutationObserver(() => {
      tryInit();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    tryInit();
  }

  watchDom();
})();
