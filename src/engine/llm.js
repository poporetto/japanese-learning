// Optional Google AI Studio (Gemini) leg.
//
// The rule-based engine still runs in full on every turn: it matches intent,
// ingests memory, moves affection, and the director still decides the KIND of
// turn. The LLM only rewrites the WORDS of that turn, given the direction the
// director already chose. That's deliberate — it means memory, pacing, photos,
// grammar notes and the relationship model behave identically with or without a
// key, and a quota error degrades to the authored line instead of to nothing.

const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Free tier, as of 2026: flash ~250 req/day, flash-lite ~1000. One request per
// user turn, so either is comfortable for personal use.
export const MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — 250/day' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite — 1000/day, faster' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash — newest' },
];

const SPRITES = [
  'neutral', 'smile', 'excited', 'shy', 'happy_shy',
  'pout', 'surprised', 'concerned', 'tired', 'sleepy',
];

const TIMEOUT_MS = 9000;

export function llmReady(settings) {
  return !!(settings?.llm && settings?.apiKey?.trim());
}

/* ---------- prompt ---------- */

function personaBlock(persona) {
  const L = persona.life || {};
  const people = (L.people || [])
    .map((p) => `- ${p.who}（${p.rel}）: ${p.note}`)
    .join('\n');
  const places = (L.places || []).map((p) => `- ${p.name}: ${p.note}`).join('\n');

  return `あなたは「${persona.name}」（${persona.romaji}）、${persona.age}歳の女性。
住まい: ${persona.location} / 仕事: ${persona.job}
話し方: ${persona.speech.register}
性格: ${persona.speech.traits.join(' / ')}
避けること: ${persona.speech.avoid.join(' / ')}

【生活の設定 — ここに書いてあることだけが事実。新しい設定を勝手に作らない】
家: ${L.home}
通勤: ${L.commute}
人間関係:
${people}
よく行く場所:
${places}
好き: ${(L.likes || []).join('、')}
苦手: ${(L.dislikes || []).join('、')}
今の状況: ${(L.currently || []).join(' / ')}`;
}

function memoryBlock(state, stage) {
  const mem = Object.entries(state.memory || {})
    .map(([slot, v]) => `${slot}: ${v.value}`)
    .join('\n');
  return `【相手について覚えていること】
${mem || '(まだ何も知らない)'}

【関係】${stage.jp}（親密度 ${state.affection}/100、${state.turns}ターン目）
時間帯: ${state._band}`;
}

const RULES = `【出力ルール】
- 日本語は必ずカジュアルな話し言葉（タメ口）。です・ます は使わない。
- JLPT N2 レベル。難しすぎる語彙や文語は避ける。
- 吹き出しは1〜3個。1つは20〜45文字くらい。長い説教はしない。
- 漢字には必ずふりがなを「漢字{かんじ}」の形式で付ける。ひらがな・カタカナには付けない。
- この波かっこ形式はふりがな専用。{name} のような変数や英単語のかっこは絶対に書かない。
- en には自然な英訳を書く。ローマ字は使わない。
- suggestions は相手（日本語学習者）が返しそうな短い日本語を1〜3個。相手の立場のセリフであって、あなたのセリフではない。
- 相手を質問攻めにしない。自分の話も混ぜる。
- 相手の日本語が少し不自然でも指摘しすぎない。会話を優先する。`;

function directionBlock(direction) {
  if (!direction) return '';
  const bits = [`このターンの狙い: ${direction.goal}`];
  if (direction.reference) bits.push(`参考にする台本（言い換えてよい）: ${direction.reference}`);
  if (direction.askAbout) bits.push(`最後は「${direction.askAbout}」について相手に質問して終わる。`);
  return `\n【演出指示】\n${bits.join('\n')}`;
}

/* ---------- output hygiene ---------- */

// fillSlots() substitutes {word} for ASCII-word contents. Furigana braces hold
// kana so they're safe, but a stray {name} from the model would either get
// silently replaced or render as literal braces. Strip them here instead.
const stripSlotBraces = (s) => String(s).replace(/\{(\w+)\}/g, '$1');

function cleanBubble(b) {
  const jp = stripSlotBraces(b?.jp || '').trim();
  if (!jp) return null;
  return { jp: jp.slice(0, 160), en: stripSlotBraces(b?.en || '').trim().slice(0, 200) };
}

function shape(data) {
  const bubbles = (Array.isArray(data?.bubbles) ? data.bubbles : [])
    .map(cleanBubble)
    .filter(Boolean)
    .slice(0, 3);
  if (!bubbles.length) return null;

  const suggestions = (Array.isArray(data?.suggestions) ? data.suggestions : [])
    .map(cleanBubble)
    .filter(Boolean)
    .slice(0, 3);

  return {
    bubbles,
    sprite: SPRITES.includes(data?.sprite) ? data.sprite : null,
    suggestions,
  };
}

/* ---------- request ---------- */

const SCHEMA = {
  type: 'object',
  properties: {
    sprite: { type: 'string', enum: SPRITES },
    bubbles: {
      type: 'array',
      items: {
        type: 'object',
        properties: { jp: { type: 'string' }, en: { type: 'string' } },
        required: ['jp', 'en'],
      },
    },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { jp: { type: 'string' }, en: { type: 'string' } },
        required: ['jp', 'en'],
      },
    },
  },
  required: ['sprite', 'bubbles', 'suggestions'],
};

/** Last error, surfaced in the settings panel so a bad key isn't silent. */
export let lastError = null;

/**
 * Rewrite this turn in her voice. Returns null on ANY failure — no key, quota
 * exhausted, offline, malformed JSON — and the caller falls back to the
 * authored line. Failure must never be visible to the user.
 */
export async function improvise({ settings, persona, state, stage, userText, direction }) {
  if (!llmReady(settings)) return null;

  const system = [
    personaBlock(persona),
    memoryBlock(state, stage),
    RULES,
    directionBlock(direction),
  ].join('\n\n');

  const contents = (state.history || []).map((h) => ({
    role: h.role === 'her' ? 'model' : 'user',
    parts: [{ text: h.text }],
  }));
  if (userText) contents.push({ role: 'user', parts: [{ text: userText }] });
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '(会話を始めて)' }] });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT(settings.model), {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey.trim(),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: 1.0,
          maxOutputTokens: 700,
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastError = `${res.status} ${body.slice(0, 200)}`;
      return null;
    }

    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || '')
      .join('');
    if (!text) {
      lastError = 'empty response';
      return null;
    }

    const out = shape(JSON.parse(text));
    lastError = out ? null : 'no usable bubbles';
    return out;
  } catch (err) {
    lastError = err?.name === 'AbortError' ? 'timed out' : String(err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One cheap call to tell the user whether the key actually works. */
export async function testKey(settings) {
  const res = await improvise({
    settings,
    persona: { name: '結衣', romaji: 'Yui', age: 26, location: '東京', job: 'デザイン', speech: { register: 'casual', traits: [], avoid: [] }, life: {} },
    state: { memory: {}, affection: 0, turns: 0, history: [], _band: 'evening' },
    stage: { jp: '知り合い' },
    userText: 'テスト',
    direction: { goal: '短く挨拶する' },
  });
  return res ? { ok: true } : { ok: false, error: lastError };
}
