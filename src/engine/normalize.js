// Text normalization for matching. Japanese has no spaces, so everything
// downstream works on substrings of a normalized string, not on tokens.

const PUNCT = /[、。！？!?.,~〜…・「」『』（）()【】\[\]"'’”\s]+/g;

/** Katakana -> hiragana, so ラーメン and らーめん match the same key. */
function kataToHira(s) {
  return s.replace(/[ァ-ヶ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}

/** Long-vowel mark and small-tsu are noise for matching. */
function foldKana(s) {
  return s.replace(/ー/g, '').replace(/っ/g, '');
}

export function normalize(raw) {
  return foldKana(kataToHira(raw.normalize('NFKC').toLowerCase())).replace(
    PUNCT,
    ''
  );
}

const RE_KANJI = /[一-鿿々]/;
const RE_KANA = /[぀-ヿ]/;
const RE_LATIN = /[a-z]/i;

/** What script did the user actually type in? Drives her reaction to effort. */
export function detectScript(raw) {
  const kanji = RE_KANJI.test(raw);
  const kana = RE_KANA.test(raw);
  const latin = RE_LATIN.test(raw);
  if (kanji || kana) return latin ? 'mixed' : 'jp';
  if (latin) return 'en';
  return 'other';
}

/** Rough proxy for "did they write a real sentence or just a word". */
export function isQuestion(raw) {
  return /[?？]|か$|かな|の\?|どう|なに|何|だれ|誰|いつ|どこ|なぜ|どうして|どんな/.test(
    raw
  );
}

export function isShort(raw) {
  return normalize(raw).length <= 3;
}
