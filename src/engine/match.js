// Intent matching: weighted substring scoring over normalized text.
// Longer keyword hits outrank shorter ones, so 「ラーメン」 beats a stray 「ラ」.

import { normalize } from './normalize.js';

/**
 * @param {string} raw          user input, unnormalized
 * @param {Array}  intents      content/intents.json
 * @returns {{id:string, score:number}|null}
 */
export function matchIntent(raw, intents) {
  const text = normalize(raw);
  if (!text) return null;

  // normalize() strips spaces, which is right for Japanese and fatal for
  // English word boundaries — so keep a spaced latin view alongside it.
  const latin = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let best = null;

  for (const intent of intents) {
    let score = 0;

    for (const kw of intent.kw || []) {
      const key = normalize(kw);
      if (!key) continue;
      // Latin keywords need word boundaries — otherwise "you" fires inside
      // "How do you say...". Japanese has no boundaries, so substring is right.
      const isLatin = /^[a-z0-9 ]+$/.test(kw.trim().toLowerCase());
      const needle = kw.trim().toLowerCase();
      const hit = isLatin
        ? new RegExp(`\\b${needle.replace(/\s+/g, '\\s+')}\\b`).test(latin)
        : text.includes(key);
      if (hit) score += key.length * 2;
    }

    for (const src of intent.re || []) {
      if (new RegExp(src).test(text)) score += 8;
    }

    // Exact-match keywords are strong signals for one-word replies ("うん").
    for (const kw of intent.exact || []) {
      if (text === normalize(kw)) score += 20;
    }

    for (const kw of intent.not || []) {
      if (text.includes(normalize(kw))) score -= 30;
    }

    score *= intent.weight ?? 1;

    if (score > 0 && (!best || score > best.score)) {
      best = { id: intent.id, score };
    }
  }

  return best && best.score >= 4 ? best : null;
}

/** Scan input for known entities she should remember (foods, hobbies, moods). */
export function scanLexicon(raw, lexicon) {
  const text = normalize(raw);
  const found = [];
  for (const [slot, entries] of Object.entries(lexicon)) {
    for (const entry of entries) {
      if (text.includes(normalize(entry.k))) {
        found.push({ slot, value: entry.v ?? entry.k, label: entry.k, en: entry.e });
      }
    }
  }
  return found;
}
