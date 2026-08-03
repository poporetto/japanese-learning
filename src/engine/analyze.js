// Shallow analysis of what the user actually wrote — tense, polarity, register,
// and a best-effort topic noun. This is deliberately not a parser: everything
// here is heuristic, so every consumer must tolerate a null result.

const RE_PAST = /(った|た|だ|かった|ました|でした)[。．！!？?…\s]*$/;
const RE_NEG = /(ない|なかった|ません|ませんでした|ってない|じゃない)/;
const RE_POLITE = /(です|ます|ました|ません|でした|ですか|ますか)/;

const QUESTION_WORDS = [
  { re: /なに|何(?!か)/, kind: 'what' },
  { re: /どこ/, kind: 'where' },
  { re: /いつ/, kind: 'when' },
  { re: /だれ|誰/, kind: 'who' },
  { re: /なぜ|どうして|なんで/, kind: 'why' },
  { re: /どう(?!して)|いかが/, kind: 'how' },
  { re: /どんな|どの/, kind: 'which' },
  { re: /いくつ|いくら|何歳|なんさい/, kind: 'howmany' },
];

const INTENSIFIERS = /すごく|すっごく|めっちゃ|超|とても|かなり|本当に|ほんとに/;
const HEDGES = /ちょっと|少し|すこし|たぶん|なんか|わりと/;

/**
 * Nouns that are grammatically fine to echo but say nothing — quoting these
 * back sounds like she misunderstood rather than listened.
 */
const ECHO_STOPLIST = new Set([
  '今日', '明日', '昨日', '今', '私', '僕', '俺', '自分', '君', '貴方',
  '日本語', '英語', '結衣', '時間', '感じ', '意味', '一緒', '本当', '最近',
  '全部', '普通', '大丈夫', '元気', '人', '事', '物', '所', '方', '中',
  '写真', '返事', '意見', '質問', '無理', '好き', '嫌い', '上手', '下手',
]);

/** Verb/adjective endings that mean we grabbed a predicate, not a noun. */
const RE_NOT_NOUN = /(する|した|して|しない|できる|なる|なった|ある|いる|思う|見る|行く|来る|言う)$/;

/**
 * Best-effort topic noun. Runs of kanji/katakana are almost always nouns in
 * casual Japanese, which is why this works without a morphological analyzer —
 * but it fails often enough that the caller MUST treat null as normal.
 */
export function extractTopic(raw) {
  // Kanji and katakana runs are collected separately — a combined character
  // class merges them across a boundary and yields junk like 「ギター始」
  // from 「ギター始めた」.
  const runs = raw.match(/[一-鿿々ヶ]{2,8}|[ァ-ヴ][ァ-ヴー]{1,9}/g) || [];

  const candidates = runs
    .map((r) => r.replace(/[ー]+$/, ''))
    .filter((r) => r.length >= 2 && r.length <= 8)
    .filter((r) => !ECHO_STOPLIST.has(r))
    .filter((r) => !RE_NOT_NOUN.test(r));

  if (!candidates.length) return null;
  // Longest run is the most specific thing they said.
  return candidates.sort((a, b) => b.length - a.length)[0];
}

export function analyze(raw) {
  const text = raw.trim();
  const q = QUESTION_WORDS.find((w) => w.re.test(text));

  return {
    past: RE_PAST.test(text),
    negative: RE_NEG.test(text),
    polite: RE_POLITE.test(text),
    question: /[?？]/.test(text) || !!q || /(の|か)[?？]?$/.test(text),
    questionKind: q?.kind ?? null,
    intense: INTENSIFIERS.test(text),
    hedged: HEDGES.test(text),
    topic: extractTopic(text),
    length: text.length,
  };
}

/** Which reaction bucket should she use when nothing else matched? */
export function reactionBucket(a) {
  if (a.question) return 'question';
  if (a.negative) return 'negative';
  if (a.past) return 'past';
  return 'plain';
}
