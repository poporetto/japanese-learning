import { Companion } from './engine/engine.js';
import * as State from './engine/state.js';
import { MODELS, llmReady, lastError, quotaStatus } from './engine/llm.js';

const $ = (sel) => document.querySelector(sel);
const log = $('#log');

let yui, state, settings;

/* ---------- rendering helpers ---------- */

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Authored furigana is always 漢字{かんじ}, but Gemini improvises the wording of
// her replies and writes readings its own way — katakana readings, a numeral
// as the base (1人{ひとり}), full-width braces. Anything the pattern misses used
// to reach the user as literal { }, so the base is widened and there's a
// final sweep: better to lose a reading than to show punctuation as text.
const RUBY_PAIR = /([一-鿿々ヶ〇0-9０-９]+)\{([ぁ-ゖァ-ヴーゝゞ・]+)\}/g;

// A brace group holding nothing but kana is a reading we failed to pair with a
// base — safe to drop. ANYTHING else keeps its contents: an earlier version
// deleted whole groups, so one stray brace from the model turned
// 「お一緒{いっしょ}に{お寿司{すし}を食{た}}べに行{い}こう」 into
// 「お一緒にべに行こう」 — silently eating the kanji. In a language-learning
// app, corrupting her Japanese is far worse than showing a stray character.
const LEFTOVER_READING = /\{[ぁ-ゖァ-ヴーゝゞ・]*\}/g;
const STRAY_BRACE = /[{}]/g;

const normalizeBraces = (s) => s.replace(/[｛]/g, '{').replace(/[｝]/g, '}');

const tidyBraces = (s) => s.replace(LEFTOVER_READING, '').replace(STRAY_BRACE, '');

/** 漢字{かんじ} -> <ruby>漢字<rt>かんじ</rt></ruby> */
function ruby(text) {
  return tidyBraces(
    esc(normalizeBraces(text)).replace(RUBY_PAIR, '<ruby>$1<rt>$2</rt></ruby>')
  );
}

/** Plain text: chips, clipboard, notification bodies. */
function stripRuby(text) {
  return tidyBraces(normalizeBraces(text));
}

function scrollDown() {
  log.scrollTop = log.scrollHeight;
}

/**
 * The scroll-back transcript. Kept beside the rest of the state so it survives
 * a reload — a companion you can't scroll back through has no past, and the
 * whole point of her is that she accumulates one.
 */
const TRANSCRIPT_MAX = 400;
let replaying = false;

function remember(entry) {
  if (replaying || !state) return;
  state.transcript = [...(state.transcript || []), entry].slice(-TRANSCRIPT_MAX);
}

function addUserBubble(text) {
  const el = document.createElement('div');
  el.className = 'row me';
  el.innerHTML = `
    <div class="mine">
      <div class="bubble me">${esc(text)}</div>
      <small class="receipt" ${replaying ? '' : 'hidden'}>既読</small>
    </div>`;
  log.append(el);
  remember({ t: 'me', jp: text });
  scrollDown();
}

/** Mark only the newest message as read, like a real chat receipt. */
function markLatestRead() {
  const receipts = log.querySelectorAll('.row.me .receipt');
  const receipt = receipts[receipts.length - 1];
  if (receipt) receipt.hidden = false;
}

function addHerBubble(bubble) {
  const el = document.createElement('div');
  el.className = 'row her';
  el.innerHTML = `
    <div class="bubble her" role="button" tabindex="0">
      <div class="jp">${ruby(bubble.jp)}</div>
      ${bubble.en ? `<div class="en" hidden>${esc(bubble.en)}</div>` : ''}
      <button class="copy" title="Copy plain text" aria-label="Copy">${svgIcon('copy', 'ico-sm')}</button>
    </div>`;
  const box = el.querySelector('.bubble');
  const en = el.querySelector('.en');
  const toggle = () => en && (en.hidden = !en.hidden);
  box.addEventListener('click', (e) => {
    if (e.target.closest('.copy')) return;
    toggle();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  el.querySelector('.copy').addEventListener('click', () =>
    navigator.clipboard?.writeText(stripRuby(bubble.jp))
  );
  log.append(el);
  remember({ t: 'her', jp: bubble.jp, en: bubble.en });
  scrollDown();
}

function addPhoto(photo) {
  const el = document.createElement('div');
  el.className = 'row her';
  el.innerHTML = `
    <figure class="photo">
      <img src="${esc(photo.file)}" alt="${esc(photo.alt || '')}">
      <div class="photo-fallback">${svgIcon('imageOff', 'ico-lg')}<span>${esc(photo.file)}</span></div>
    </figure>`;
  const img = el.querySelector('img');
  img.addEventListener('error', () => el.querySelector('.photo').classList.add('missing'));
  el.querySelector('.photo').addEventListener('click', () => openLightbox(photo));
  log.append(el);
  remember({ t: 'photo', file: photo.file, alt: photo.alt });
  keepInGallery(photo);
  scrollDown();
}

/** Every photo she's ever sent, deduped, newest last. Drives the 🖼 gallery. */
function keepInGallery(photo) {
  if (replaying || !state) return;
  state.gallery = (state.gallery || []).filter((g) => g.file !== photo.file);
  state.gallery.push({ file: photo.file, alt: photo.alt || '', on: State.localDate() });
}

function addTeach(g) {
  const el = document.createElement('div');
  el.className = 'row her';
  el.innerHTML = `
    <details class="teach">
      <summary><span class="tag">N2</span> ${ruby(g.point)} — ${esc(g.en)}</summary>
      ${g.line ? `<p class="said">${ruby(g.line)}</p>
      <p class="saidnote">${ruby('↑ 結衣{ゆい}がたった今{いま}使{つか}った文{ぶん}')}</p>` : ''}
      <p class="ex">${ruby(g.ex)}</p>
      <p class="exen">${esc(g.exEn)}</p>
      ${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}
    </details>`;
  log.append(el);
  remember({ t: 'teach', g });
  scrollDown();
}

/** Redraw a saved session instantly — no typing delays, no re-recording. */
function replayLog() {
  const past = state.transcript || [];
  if (!past.length) return;
  replaying = true;
  log.classList.add('replay');
  for (const e of past) {
    if (e.t === 'me') addUserBubble(e.jp);
    else if (e.t === 'her') addHerBubble(e);
    else if (e.t === 'photo') addPhoto(e);
    else if (e.t === 'teach') addTeach(e.g);
  }
  const rule = document.createElement('div');
  rule.className = 'daybreak';
  rule.textContent = 'ここから今日';
  log.append(rule);
  log.classList.remove('replay');
  replaying = false;
  scrollDown();
}

function typingIndicator() {
  const el = document.createElement('div');
  el.className = 'row her typing';
  el.innerHTML = '<div class="bubble her dots"><i></i><i></i><i></i></div>';
  log.append(el);
  scrollDown();
  return el;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lucide icon paths, inlined. The project has no build step and makes no
 * external requests, so pulling the icon font or a CDN bundle isn't an option —
 * and these are a few hundred bytes each. MIT licensed.
 */
const ICONS = {
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  imageOff: '<line x1="2" x2="22" y1="2" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" x2="6" y1="13.5" y2="21"/><line x1="18" x2="21" y1="12" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/>',
};

// Width/height are attributes, not just CSS: an svg with only a viewBox sizes
// itself from the stylesheet, so a stale or missing styles.css renders these
// enormous instead of merely unstyled.
const ICON_SIZE = { ico: 18, 'ico-lg': 30, 'ico-sm': 13 };

const svgIcon = (name, cls = 'ico') => {
  const n = ICON_SIZE[cls] || 18;
  return `<svg class="${cls}" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${ICONS[name]}</svg>`;
};

/* ---------- chrome: sprite, meter, suggestions ---------- */

const PROFILE_FALLBACK = 'assets/portraits/yui-chat-profile.png';
let spriteLabel = '';

function setPresence(text) {
  $('#sprite-label').textContent = text || spriteLabel;
}

function setSprite(key) {
  const def = yui.sprites[key] || yui.sprites.neutral;
  const wrap = $('#sprite');
  wrap.style.setProperty('--hue', def.hue ?? 210);
  spriteLabel = def.label;
  setPresence();
  const img = $('#sprite-img');
  img.hidden = false;
  img.dataset.profileFallback = '0';
  img.onload = () => { img.hidden = false; };
  img.onerror = () => {
    if (img.dataset.profileFallback === '1') {
      img.hidden = true;
      return;
    }
    img.dataset.profileFallback = '1';
    img.src = PROFILE_FALLBACK;
  };
  img.src = def.file;
}

function setMeter() {
  const stage = State.stageOf(state);
  $('#stage').textContent = `${stage.jp} · ${stage.en}`;
  $('#meter-fill').style.width = `${state.affection}%`;
  $('#meter').setAttribute('aria-valuenow', state.affection);
  const name = state.memory.name?.value;
  $('#who').textContent = name ? `結衣 → ${name}` : '結衣 Yui';
}

function setSuggestions(list) {
  const bar = $('#suggestions');
  bar.innerHTML = '';
  for (const s of list || []) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.innerHTML = `<span>${esc(stripRuby(s.jp))}</span><small>${esc(s.en || '')}</small>`;
    b.addEventListener('click', () => send(stripRuby(s.jp)));
    bar.append(b);
  }
}

/* ---------- turn playback ---------- */

let busy = false;
let queued = null;

async function play(turn) {
  busy = true;
  setSuggestions([]);
  setSprite(turn.sprite);

  for (const bubble of turn.bubbles) {
    setPresence('入力中…');
    const dots = typingIndicator();
    const chars = stripRuby(bubble.jp).length;
    await sleep(Math.min(1600, 320 + chars * 45));
    dots.remove();
    setPresence();
    addHerBubble(bubble);
    await sleep(220 + Math.random() * 260);
  }

  if (turn.photo) {
    setPresence('写真を選んでる…');
    const dots = typingIndicator();
    await sleep(700 + Math.random() * 650);
    dots.remove();
    setPresence();
    addPhoto(turn.photo);
  }

  if (turn.teach) addTeach(turn.teach);

  setSuggestions(turn.suggestions);
  setMeter();
  State.save(state);
  busy = false;

  // Anything typed while she was "typing" gets sent now, not dropped.
  if (queued) {
    const next = queued;
    queued = null;
    send(next);
  }
}

async function send(text) {
  const value = text.trim();
  if (!value) return;
  $('#input').value = '';
  if (busy) {
    queued = value;
    return;
  }
  addUserBubble(value);
  ensureNotifyPermission();
  // Held from here so a slow API call can't be raced by the idle timer.
  busy = true;
  setPresence('読んでる…');
  await sleep(280 + Math.random() * 520);
  markLatestRead();
  setPresence('入力中…');
  // The API round trip — plus any wait for the per-minute gap — happens before
  // play() draws anything, so without this the screen sits dead for seconds and
  // reads as her ignoring you. Show she's typing for the whole wait.
  const waiting = typingIndicator();
  let turn;
  try {
    turn = await yui.respond(value, state);
  } finally {
    waiting.remove();
    setPresence();
    busy = false;
  }
  await play(turn);
  // Rescheduled only now: respond() zeroes `unanswered`, and scheduling before
  // that read the pre-reply value — which at 5 meant she'd given up and
  // answering her never brought her back.
  scheduleProactive();
}

/* ---------- she messages first ---------- */

let proactiveTimer = null;

/** Idle gap before she says something unprompted, growing as she's ignored. */
function nextDelay() {
  const base = 55000 + Math.random() * 50000;             // 55–105s
  const backoff = Math.min(6, 1.7 ** (state.unanswered || 0));
  return Math.round(base * backoff);
}

function scheduleProactive() {
  clearTimeout(proactiveTimer);
  if (!settings.proactive) return;
  // Silence is only a same-day boundary. Without this reset, five ignored
  // weekday nudges could prevent her from saying anything all weekend.
  if (state.lastProactiveDate !== State.localDate()) state.unanswered = 0;
  // She gives up after a handful of unanswered messages rather than nagging
  // an empty room forever. Sending anything at all resets this.
  if ((state.unanswered || 0) >= 5) return;
  proactiveTimer = setTimeout(fireProactive, nextDelay());
}

async function fireProactive() {
  if (busy) return scheduleProactive();
  busy = true;
  const turn = await yui.proactive(state);
  busy = false;
  if (!turn) return scheduleProactive();

  await play(turn);
  notify(turn);
  scheduleProactive();
}

/* ---------- clock-pinned messages ---------- */

let clockTimer = null;

/**
 * Checked every 30s and on every return to the tab. A slot that came due while
 * the tab was closed is delivered on arrival, provided it's still inside its
 * window — that's what makes a 06:00 message work when nobody's watching at 6.
 */
async function tickScheduled() {
  if (busy || !settings.scheduled) return false;
  busy = true;
  const turn = await yui.scheduled(state);
  busy = false;
  if (!turn) return false;

  await play(turn);
  notify(turn);
  scheduleProactive();
  return true;
}

function startClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(tickScheduled, 30000);
}

function notify(turn) {
  if (!settings.notify || !document.hidden) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const body = turn.bubbles.map((b) => stripRuby(b.jp)).join(' ');
  try {
    // `renotify` so a second message re-alerts instead of silently replacing
    // the first — the tag still keeps her to one notification in the tray.
    const n = new Notification('結衣 Yui', {
      body,
      tag: 'yui',
      renotify: true,
      icon: 'assets/portraits/yui-chat-profile.png',
      // Chromium-based installed apps can show the photo as a large preview.
      // iOS currently falls back to the app icon, while the same photo still
      // appears in the chat when the user opens the notification.
      ...(turn.photo?.file ? { image: turn.photo.file } : {}),
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* Safari throws outside a service worker; the bubble is still there */ }
}

/**
 * Browsers only grant notification permission from a user gesture, so this
 * rides the first click or send rather than firing at boot — where it would
 * be auto-denied and never askable again.
 */
async function ensureNotifyPermission() {
  if (!settings.notify || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  await Notification.requestPermission();
  syncSettingsForm();
}

/**
 * Why notifications aren't arriving, in words. "denied" is the important one:
 * it fails completely silently, and no amount of asking again will fix it —
 * only the user, in the browser's own site settings.
 */
function notifyState() {
  if (typeof Notification === 'undefined') {
    return { ok: false, msg: 'this browser has no notification support' };
  }
  if (!settings.notify) return { ok: false, msg: 'turned off here' };
  if (Notification.permission === 'denied') {
    return { ok: false, msg: 'blocked — allow notifications for this site in your browser settings' };
  }
  if (Notification.permission === 'default') {
    return { ok: false, msg: 'not granted yet — send a message or hit test below' };
  }
  return { ok: true, msg: 'on — only while this page is open, and only when it isn\'t focused' };
}

/* ---------- boot ---------- */

/**
 * Arriving at 08:00 should open with her morning message, not with a generic
 * greeting followed immediately by one — a due slot replaces the opener rather
 * than stacking on top of it.
 */
async function playOpening() {
  if (settings.scheduled && yui.hasScheduled(state)) {
    yui.startSession(state);
    await play(await yui.scheduled(state));
  } else {
    await play(await yui.openSession(state));
  }
}


async function loadContent() {
  const files = {
    persona: 'src/content/persona.json',
    intents: 'src/content/intents.json',
    dialogue: 'src/content/dialogue.json',
    qa: 'src/content/qa.json',
    grammar: 'src/content/grammar-n2.json',
    lexicon: 'src/content/lexicon.json',
    sprites: 'src/content/sprites.json',
  };
  const entries = await Promise.all(
    Object.entries(files).map(async ([k, path]) => {
      // 'no-cache' revalidates against the server every load rather than
      // trusting the 10-minute cache GitHub Pages sets. Content changes far
       // more often than code here, and a stale dialogue.json paired with
      // current code is exactly the mismatch that looks like a broken app.
      // It's still cheap: an unchanged file comes back as a 304.
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return [k, await res.json()];
    })
  );
  return Object.fromEntries(entries);
}

async function boot() {
  try {
    const content = await loadContent();
    yui = new Companion(content);
  } catch (err) {
    log.innerHTML = `<div class="row her"><div class="bubble her">
      <div class="jp">読み込みエラー</div>
      <div class="en">Couldn't load content — serve this folder over HTTP
      (<code>python3 -m http.server</code>), not via file://.<br>${esc(String(err))}</div>
    </div></div>`;
    return;
  }

  state = State.load();
  setMeter();
  buildSettings();
  replayLog();
  await playOpening();
  scheduleProactive();
  startClock();
}

/* ---------- gallery ---------- */

function openGallery() {
  const grid = $('#gallery-grid');
  const shots = [...(state.gallery || [])].reverse();
  $('#gallery-count').textContent = shots.length
    ? `${shots.length} 枚 · ${shots.length} photo${shots.length > 1 ? 's' : ''} she's sent you`
    : 'Nothing yet — she sends photos as you get to know her.';
  grid.innerHTML = '';
  for (const g of shots) {
    const fig = document.createElement('figure');
    fig.className = 'shot';
    fig.innerHTML = `
      <img src="${esc(g.file)}" alt="${esc(g.alt)}" loading="lazy">
      <div class="shot-fallback">${svgIcon('imageOff', 'ico-lg')}<span>${esc(g.file.split('/').pop())}</span></div>
      <figcaption>${esc(g.alt || '')}<small>${esc(g.on || '')}</small></figcaption>`;
    fig.querySelector('img').addEventListener('error', () => fig.classList.add('missing'));
    fig.addEventListener('click', () => openLightbox(g));
    grid.append(fig);
  }
  $('#gallery-dlg').showModal();
}

function openLightbox(photo) {
  const dlg = $('#lightbox');
  $('#lightbox-img').src = photo.file;
  $('#lightbox-cap').textContent = photo.alt || '';
  dlg.showModal();
}

$('#gallery').addEventListener('click', openGallery);
const profile = $('#sprite');
const openProfile = () => {
  const img = $('#sprite-img');
  if (!img.hidden && img.src) {
    openLightbox({ file: img.currentSrc || img.src, alt: `結衣 Yui · ${spriteLabel}` });
  }
};
profile.addEventListener('click', openProfile);
profile.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openProfile();
  }
});
$('#lightbox').addEventListener('click', () => $('#lightbox').close());

/* ---------- settings ---------- */

function buildSettings() {
  const sel = $('#set-model');
  sel.innerHTML = MODELS.map(
    (m) => `<option value="${m.id}">${esc(m.label)}</option>`
  ).join('');
  syncSettingsForm();
}

function syncSettingsForm() {
  $('#set-key').value = settings.apiKey;
  $('#set-model').value = settings.model;
  $('#set-llm').checked = settings.llm;
  $('#set-proactive').checked = settings.proactive;
  $('#set-scheduled').checked = settings.scheduled;
  $('#notify-status').textContent = notifyState().msg;
  $('#set-notify').checked = settings.notify;
  const q = quotaStatus(settings);
  $('#llm-status').textContent = !llmReady(settings)
    ? 'off — authored replies only'
    : q.exhausted
      ? 'free tier used up for today — authored replies until it resets'
      : `on — ${q.used}/${q.cap} requests used today`;
  document.body.classList.toggle('llm-on', llmReady(settings) && !q.exhausted);
}

$('#settings').addEventListener('click', () => {
  syncSettingsForm();
  $('#settings-dlg').showModal();
});

// Fires immediately and unconditionally so "nothing happened" is itself the
// answer — it proves whether the browser will show one at all.
$('#notify-test').addEventListener('click', async () => {
  const out = $('#notify-test-result');
  if (typeof Notification === 'undefined') { out.textContent = ' no support'; return; }
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') {
    out.textContent = ` blocked (${Notification.permission}) — allow it in browser site settings`;
    syncSettingsForm();
    return;
  }
  try {
    const n = new Notification('結衣 Yui', { body: 'テスト。ちゃんと届いてる？', tag: 'yui-test' });
    n.onclick = () => { window.focus(); n.close(); };
    out.textContent = ' sent — check your notification tray';
  } catch (err) {
    out.textContent = ` failed: ${err.message}`;
  }
  syncSettingsForm();
});

$('#set-save').addEventListener('click', async (e) => {
  e.preventDefault();
  settings = {
    ...settings,
    apiKey: $('#set-key').value.trim(),
    model: $('#set-model').value,
    llm: $('#set-llm').checked,
    proactive: $('#set-proactive').checked,
    scheduled: $('#set-scheduled').checked,
    notify: $('#set-notify').checked,
  };

  if (settings.notify && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  State.saveSettings(settings);
  syncSettingsForm();
  scheduleProactive();
  $('#settings-dlg').close();
});

$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  send($('#input').value);
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('Reset Yui\'s memory and start over?\n\nThe chat history and photo gallery are cleared too.\n(Your API key and settings are kept.)')) return;
  clearTimeout(proactiveTimer);
  State.reset();
  log.innerHTML = '';
  state = State.load();
  setMeter();
  await playOpening();
  scheduleProactive();
  startClock();
});

$('#debug').addEventListener('click', () => {
  const mem = Object.entries(state.memory)
    .map(([k, v]) => `${k}: ${v.value}`)
    .join('\n') || '(nothing yet)';
  alert(
    `affection: ${state.affection}\nturns: ${state.turns}\nstage: ${State.stageOf(state).en}\n` +
    `pendingSlot: ${state.pendingSlot}\npendingTopic: ${state.pendingTopic}\n` +
    `unanswered: ${state.unanswered}\nLLM: ${llmReady(settings) ? settings.model : 'off'}` +
    `${lastError ? ` (last error: ${lastError})` : ''}\n\n` +
    `memory:\n${mem}\n\ngrammar seen: ${state.learned.length}`
  );
});

// Coming back to the tab shouldn't trigger an instant backlog of nudges.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  scheduleProactive();
  tickScheduled();
});

settings = State.loadSettings();
boot();
