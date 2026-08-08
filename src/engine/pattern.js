// Does a sentence actually contain the grammar pattern it claims to?
//
// The teaching card is chosen from the pattern named at the end of the English
// gloss (" — 〜わけだ"). For authored lines that annotation is trustworthy; for
// API replies it is the model describing its own output, and it gets it wrong:
// a card for 〜わけだ appeared beside 「急にそんなこと言うなんて、どうしたの。」,
// a sentence with no わけ in it at all. So the claim now has to be corroborated
// against the Japanese before a card is allowed to fire.
//
// Matching is deliberately generous — this is a veto, not a parser, and a
// false reject silently costs a teaching moment. It has to survive:
//   discontinuous patterns   〜ば〜ほど   → 考えれば考えるほど
//   conjugation              〜ほかない   → 歩くほかなかった
//   contraction              〜ことになっている → ことになってる
//   て/で and と/ど alternation  〜てしかたがない → 楽しみでしかたがない
// so each segment is matched by progressively trimmed prefix, in order.

const RUBY = /\{[ぁ-んー]+\}/g;
const TRIM = 3;

const norm = (s) => String(s).replace(RUBY, '').replace(/で/g, 'て').replace(/ど/g, 'と');

function segments(form) {
  return String(form)
    .replace(RUBY, '')
    .replace(/[()（）]/g, '')
    .split('〜')
    .filter(Boolean);
}

export function patternMatches(form, jp) {
  const j = norm(jp);
  let at = 0;
  for (const seg of segments(form)) {
    const s = norm(seg);
    // A segment may legitimately be one character (〜ば〜ほど, 〜げ, 〜切る),
    // so the floor depends on the segment rather than being a flat 2.
    const floor = s.length <= 2 ? 1 : 2;
    let found = -1;
    for (let k = 0; k <= TRIM; k++) {
      const cand = s.slice(0, s.length - k);
      if (cand.length < floor) break;
      const i = j.indexOf(cand, at);
      if (i >= 0) { found = i + cand.length; break; }
    }
    if (found < 0) return false;
    at = found;
  }
  return true;
}

// Every written form of a point: the headword plus its aliases.
export const formsOf = (g) => [g.point, ...(g.aliases || [])].map((f) => f.replace(RUBY, ''));
