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

/** 漢字{かんじ} -> <ruby>漢字<rt>かんじ</rt></ruby> */
function ruby(text) {
  return esc(text).replace(
    /([一-鿿々ヶ]+)\{([ぁ-んー]+)\}/g,
    '<ruby>$1<rt>$2</rt></ruby>'
  );
}

function stripRuby(text) {
  return text.replace(/\{[ぁ-んー]+\}/g, '');
}

function scrollDown() {
  log.scrollTop = log.scrollHeight;
}

function addUserBubble(text) {
  const el = document.createElement('div');
  el.className = 'row me';
  el.innerHTML = `<div class="bubble me">${esc(text)}</div>`;
  log.append(el);
  scrollDown();
}

function addHerBubble(bubble) {
  const el = document.createElement('div');
  el.className = 'row her';
  el.innerHTML = `
    <div class="bubble her" role="button" tabindex="0">
      <div class="jp">${ruby(bubble.jp)}</div>
      ${bubble.en ? `<div class="en" hidden>${esc(bubble.en)}</div>` : ''}
      <button class="copy" title="Copy plain text">⧉</button>
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
  scrollDown();
}

function addPhoto(photo) {
  const el = document.createElement('div');
  el.className = 'row her';
  el.innerHTML = `
    <figure class="photo">
      <img src="${esc(photo.file)}" alt="${esc(photo.alt || '')}">
      <div class="photo-fallback">📷<span>${esc(photo.file)}</span></div>
    </figure>`;
  const img = el.querySelector('img');
  img.addEventListener('error', () => el.querySelector('.photo').classList.add('missing'));
  log.append(el);
  scrollDown();
}

function addTeach(g) {
  const el = document.createElement('div');
  el.className = 'row her';
  el.innerHTML = `
    <details class="teach">
      <summary><span class="tag">N2</span> ${ruby(g.point)} — ${esc(g.en)}</summary>
      <p class="ex">${ruby(g.ex)}</p>
      <p class="exen">${esc(g.exEn)}</p>
      ${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}
    </details>`;
  log.append(el);
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

/* ---------- chrome: sprite, meter, suggestions ---------- */

const PROFILE_FALLBACK = 'assets/portraits/yui-chat-profile.png';

function setSprite(key) {
  const def = yui.sprites[key] || yui.sprites.neutral;
  const wrap = $('#sprite');
  wrap.style.setProperty('--hue', def.hue ?? 210);
  $('#sprite-label').textContent = def.label;
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
    const dots = typingIndicator();
    const chars = stripRuby(bubble.jp).length;
    await sleep(Math.min(1600, 320 + chars * 45));
    dots.remove();
    addHerBubble(bubble);
    await sleep(180);
  }

  if (turn.photo) {
    const dots = typingIndicator();
    await sleep(900);
    dots.remove();
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
  const turn = await yui.respond(value, state);
  busy = false;
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
  settings.notify = (await Notification.requestPermission()) === 'granted';
  State.saveSettings(settings);
}

/* ---------- boot ---------- */

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
      const res = await fetch(path);
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
  await play(await yui.openSession(state));
  scheduleProactive();
}

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

$('#set-save').addEventListener('click', async (e) => {
  e.preventDefault();
  settings = {
    ...settings,
    apiKey: $('#set-key').value.trim(),
    model: $('#set-model').value,
    llm: $('#set-llm').checked,
    proactive: $('#set-proactive').checked,
    notify: $('#set-notify').checked,
  };

  if (settings.notify && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    settings.notify = (await Notification.requestPermission()) === 'granted';
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
  if (!confirm('Reset Yui\'s memory and start over?\n\n(Your API key and settings are kept.)')) return;
  clearTimeout(proactiveTimer);
  State.reset();
  log.innerHTML = '';
  state = State.load();
  setMeter();
  await play(await yui.openSession(state));
  scheduleProactive();
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
  if (!document.hidden) scheduleProactive();
});

settings = State.loadSettings();
boot();
