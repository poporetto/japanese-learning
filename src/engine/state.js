// All persistent state lives here. localStorage only — no backend.

const KEY = 'yui.state.v1';

// Settings live under their OWN key on purpose: ↺ wipes who she thinks you are,
// not your API key. Re-typing the key after every reset would be miserable.
const SETTINGS_KEY = 'yui.settings.v1';

export const STAGES = [
  { id: 'stranger', min: 0, jp: '知り合い', en: 'Acquaintance' },
  { id: 'friend', min: 15, jp: '友達', en: 'Friend' },
  { id: 'close', min: 40, jp: '仲良し', en: 'Close' },
  { id: 'special', min: 70, jp: '大切な人', en: 'Special' },
];

function fresh() {
  return {
    affection: 0,
    turns: 0,
    memory: {},          // slot -> { value, label, turn }
    flags: {},           // arbitrary booleans set by dialogue
    seen: {},            // beat/variant id -> count, prevents repeats
    pendingSlot: null,   // she asked a question; next reply fills this slot
    pendingTopic: null,  // topic she's mid-way through
    lastPhotoTurn: -99,
    lastTeachTurn: -99,
    lastCallbackTurn: -99,
    lastRegisterTurn: -99,
    lastSeenDate: null,
    streak: 0,
    learned: [],         // grammar point ids surfaced so far
    lastProactiveTurn: -99,
    unanswered: 0,       // proactive messages sent since he last replied
    history: [],         // recent turns, verbatim — the LLM's short-term memory
    scheduled: {},       // "HH:MM" -> the date it last fired, so once per day
    transcript: [],      // rendered chat log, so you can scroll back after a reload
    gallery: [],         // every photo she's sent, deduped
  };
}

/** Local calendar date. Scheduled messages key off this, never UTC. */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    return { ...fresh(), ...JSON.parse(raw) };
  } catch {
    return fresh();
  }
}

export function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function reset() {
  localStorage.removeItem(KEY);
}

/* ---------- settings (survive a memory reset) ---------- */

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-flash-latest',
  llm: true,          // use the API when a key is present
  proactive: true,    // she messages first when the conversation goes quiet
  scheduled: true,    // おはよう at 6, おやすみ at 23, meals in between
  notify: true,       // browser notification when the tab isn't focused
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/**
 * Rolling transcript handed to the LLM. Capped hard — free-tier tokens-per-minute
 * is the binding constraint, and she has `memory` for anything that matters long
 * term, so old turns are genuinely disposable.
 */
const HISTORY_MAX = 16;

export function pushHistory(state, role, text) {
  if (!text) return;
  state.history = [...(state.history || []), { role, text }].slice(-HISTORY_MAX);
}

export function stageOf(state) {
  return [...STAGES].reverse().find((s) => state.affection >= s.min);
}

export function bumpAffection(state, delta) {
  state.affection = Math.max(0, Math.min(100, state.affection + (delta || 0)));
}

/** Call once per session start; drives "久しぶり" vs "また来たね". */
export function touchDay(state) {
  const today = new Date().toISOString().slice(0, 10);
  const prev = state.lastSeenDate;
  state.lastSeenDate = today;
  if (!prev) return { first: true, gapDays: 0 };
  const gap = Math.round(
    (new Date(today) - new Date(prev)) / 86400000
  );
  if (gap === 1) state.streak += 1;
  else if (gap > 1) state.streak = 1;
  return { first: false, gapDays: gap };
}

export function timeBand(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return 'night';
  if (h < 11) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 22) return 'evening';
  return 'night';
}
