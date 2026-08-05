// Memory is what makes her read as intelligent. Two capture paths:
//   1. pendingSlot — she asked "名前は？", so the next message IS the answer.
//      Robust, no parsing gymnastics.
//   2. opportunistic — lexicon scan picks up foods/hobbies/moods mentioned
//      in passing.

import { scanLexicon } from './match.js';
import { normalize } from './normalize.js';

/** Strip the polite scaffolding off a slot answer: 「私はケンです」-> ケン */
function cleanSlotAnswer(raw) {
  return raw
    .trim()
    .replace(/^(?:私|わたし|僕|ぼく|俺|おれ|うち)は/, '')
    .replace(/(?:です|だよ|だね|だ|ます|といいます|と言います|かな)[。.!！]*$/, '')
    .replace(/[。.!！?？]+$/, '')
    .trim();
}

// A free-text answer is a bare noun, not a sentence. Case-marking particles or
// a verb ending mean they answered with a whole clause — 「昨日は美術館に行った」
// is a story about their day, not their name.
// Sentence-final particles and て-form endings were missing, so an imperative
// reply to 「なんて呼べばいい？」 sailed through the check: answering
// 「行ってきなよ」 filed *that* as the user's name, and every {name} line after
// it read 「行ってきなよね。じゃあこれからそう呼ぶから。」 A missed capture just
// means she asks again; a wrong one is permanent, so this errs strict.
const RE_SENTENCEY =
  /[はをにへとでもがや]|から|まで|(った|てる|ます|ない|だった|して|きて|なよ|ないで|ください)$|[よねぞぜわさ]$/;

function looksLikeBareNoun(value) {
  return value.length >= 1 && value.length <= 10 && !RE_SENTENCEY.test(value);
}

export function remember(state, slot, value, label) {
  state.memory[slot] = { value, label: label ?? value, turn: state.turns };
}

export function recall(state, slot) {
  return state.memory[slot]?.value ?? null;
}

/**
 * Runs every user turn. Returns the slots that were newly filled so the
 * director can acknowledge them ("へえ、ラーメン好きなんだ").
 */
export function ingest(state, raw, lexicon, opts = {}) {
  const filled = [];

  if (state.pendingSlot) {
    const slot = state.pendingSlot;
    state.pendingSlot = null;
    // Free-text capture is only safe for open slots like {name}. For slots
    // backed by a lexicon (food, hobby...) the scan below is the only path —
    // otherwise "疲れた…" gets filed as a favourite food.
    // ...and only when the message isn't something else entirely. Without
    // this, answering 「こんにちは」 to 「なんて呼べばいい？」 names you Konnichiwa.
    if (!lexicon[slot] && !opts.intentId) {
      const val = cleanSlotAnswer(raw);
      if (val && looksLikeBareNoun(val) && !/[?？]/.test(raw)) {
        remember(state, slot, val);
        filled.push({ slot, value: val, fromPrompt: true });
      }
    }
  }

  // When she's being asked for a photo, 「写真」 is the request, not a hobby.
  if (opts.skipScan) return filled;

  for (const hit of scanLexicon(raw, lexicon)) {
    const existing = state.memory[hit.slot];
    if (existing && normalize(existing.value) === normalize(hit.value)) continue;
    remember(state, hit.slot, hit.value, hit.label);
    filled.push({ ...hit, fromPrompt: false });
  }

  return filled;
}

/** Slots she can naturally bring up again, oldest-mentioned first. */
export function callbackCandidates(state) {
  return Object.entries(state.memory)
    .filter(([, v]) => v && v.value)
    .sort((a, b) => a[1].turn - b[1].turn)
    .map(([slot, v]) => ({ slot, ...v }));
}

/**
 * Slots supplied per-turn rather than from memory, so `pick` must not reject a
 * line for referencing them. The caller guarantees a value before rendering.
 */
const TRANSIENT_SLOTS = new Set(['echo']);

/** Fill {name} / {food} / {echo} style slots in authored text. */
export function fillSlots(text, state, extras = {}) {
  return text.replace(/\{(\w+)\}/g, (m, slot) => {
    if (slot in extras) return extras[slot];
    return recall(state, slot) ?? m;
  });
}

/** A line is usable only if every slot it references is known. */
export function slotsSatisfied(text, state) {
  const needed = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  return needed.every((s) => TRANSIENT_SLOTS.has(s) || recall(state, s) !== null);
}
