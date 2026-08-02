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
      if (val && val.length <= 24 && !/[?？]/.test(raw)) {
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

/** Fill {name} / {food} style slots in authored text. */
export function fillSlots(text, state) {
  return text.replace(/\{(\w+)\}/g, (m, slot) => {
    if (slot === 'stage') return '';
    return recall(state, slot) ?? m;
  });
}

/** A line is usable only if every slot it references is known. */
export function slotsSatisfied(text, state) {
  const needed = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  return needed.every((s) => recall(state, s) !== null);
}
