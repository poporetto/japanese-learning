import { Companion } from './engine/engine.js';
import * as State from './engine/state.js';

const $ = (sel) => document.querySelector(sel);
const log = $('#log');

let yui, state;

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
      <summary><span class="tag">N2</span> ${esc(g.point)} — ${esc(g.en)}</summary>
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

function setSprite(key) {
  const def = yui.sprites[key] || yui.sprites.neutral;
  const wrap = $('#sprite');
  wrap.style.setProperty('--hue', def.hue ?? 210);
  $('#sprite-label').textContent = def.label;
  const img = $('#sprite-img');
  img.hidden = false;
  img.src = def.file;
  img.onerror = () => { img.hidden = true; };
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

function send(text) {
  const value = text.trim();
  if (!value) return;
  $('#input').value = '';
  if (busy) {
    queued = value;
    return;
  }
  addUserBubble(value);
  play(yui.respond(value, state));
}

/* ---------- boot ---------- */

async function loadContent() {
  const files = {
    persona: 'src/content/persona.json',
    intents: 'src/content/intents.json',
    dialogue: 'src/content/dialogue.json',
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
  await play(yui.openSession(state));
}

$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  send($('#input').value);
});

$('#reset').addEventListener('click', () => {
  if (!confirm('Reset Yui\'s memory and start over?')) return;
  State.reset();
  log.innerHTML = '';
  state = State.load();
  setMeter();
  play(yui.openSession(state));
});

$('#debug').addEventListener('click', () => {
  const mem = Object.entries(state.memory)
    .map(([k, v]) => `${k}: ${v.value}`)
    .join('\n') || '(nothing yet)';
  alert(
    `affection: ${state.affection}\nturns: ${state.turns}\nstage: ${State.stageOf(state).en}\n` +
    `pendingSlot: ${state.pendingSlot}\npendingTopic: ${state.pendingTopic}\n\n` +
    `memory:\n${mem}\n\ngrammar seen: ${state.learned.length}`
  );
});

boot();
