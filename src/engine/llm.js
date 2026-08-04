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

// Rolling aliases, not pinned ids. Pinned older ids (gemini-2.5-flash and
// below) now 404 for keys issued recently — "no longer available to new users" —
// so an alias is the only thing that stays working without edits.
// One request per user turn; free tier is comfortable for personal use.
export const MODELS = [
  { id: 'gemini-flash-latest', label: 'Flash (latest) — best quality' },
  { id: 'gemini-flash-lite-latest', label: 'Flash-Lite (latest) — faster, higher daily limit' },
];

const SPRITES = [
  'neutral', 'smile', 'excited', 'shy', 'happy_shy',
  'pout', 'surprised', 'concerned', 'tired', 'sleepy',
];

// Measured round trips run 2.6–6.2s. At 9s the tail occasionally aborted and
// fell back to an authored line, which is indistinguishable from her ignoring
// you. The typing indicator covers the wait now, so patience is cheap.
const TIMEOUT_MS = 15000;

export function llmReady(settings) {
  return !!(settings?.llm && settings?.apiKey?.trim());
}

/* ---------- staying inside the free tier ---------- */
//
// The only *hard* guarantee is on Google's side: a project with no billing
// account attached cannot spend money — it returns 429 RESOURCE_EXHAUSTED
// instead. Everything below is the client-side half, so the app stops asking
// well before that, and stops asking entirely once told no.

const QUOTA_KEY = 'yui.quota.v1';

// Free-tier requests-per-day, minus headroom. Flash is 250/day, Flash-Lite
// 1000; both share a per-minute cap that human typing speed can't reach.
const DAILY_CAP = { 'gemini-flash-latest': 200, 'gemini-flash-lite-latest': 800 };
const DEFAULT_CAP = 200;
const MIN_GAP_MS = 6500; // ≈9 req/min ceiling, under the free tier's 10 RPM

/** Google's daily quota resets at midnight Pacific, not local midnight. */
function quotaDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

export function loadQuota() {
  let q;
  try {
    q = JSON.parse(localStorage.getItem(QUOTA_KEY) || '{}');
  } catch {
    q = {};
  }
  if (q.day !== quotaDay()) q = {};
  return { day: quotaDay(), used: 0, exhausted: false, lastCall: 0, blockedUntil: 0, strikes: 0, ...q };
}

function saveQuota(q) {
  localStorage.setItem(QUOTA_KEY, JSON.stringify(q));
}

export function quotaStatus(settings) {
  const q = loadQuota();
  return { used: q.used, cap: DAILY_CAP[settings?.model] ?? DEFAULT_CAP, exhausted: q.exhausted };
}

/**
 * Both the per-minute and the per-day free-tier limits come back as
 * 429 RESOURCE_EXHAUSTED, so the status alone can't tell them apart — and
 * treating a one-second burst as "no more Gemini today" would be far more
 * annoying than the problem it prevents. The violated quota's id says which:
 * per-day ids contain "PerDay", per-minute ones "PerMinute".
 */
function classifyQuotaError(status, body) {
  if (status !== 429 && !(status === 403 && /quota|RESOURCE_EXHAUSTED/i.test(body))) {
    return null;
  }

  let details = [];
  try {
    details = JSON.parse(body)?.error?.details || [];
  } catch { /* non-JSON body — fall through to the ambiguous case */ }

  const ids = details
    .flatMap((d) => d.violations || [])
    .map((v) => `${v.quotaId || ''} ${v.quotaMetric || ''}`)
    .join(' ');

  if (/PerDay/i.test(ids)) return { scope: 'day' };
  if (/PerMinute/i.test(ids)) {
    const retry = details.find((d) => String(d['@type']).endsWith('RetryInfo'))?.retryDelay;
    const secs = parseFloat(retry) || 30;
    return { scope: 'minute', waitMs: (secs + 1) * 1000 };
  }
  // Unattributable 429: back off for a few minutes rather than a day, but
  // don't let it drip forever — three in a row is treated as the daily wall.
  return { scope: 'unknown', waitMs: 5 * 60 * 1000 };
}

/* ---------- prompt ---------- */

// Below this she doesn't talk about her ex, and the API isn't even told he
// exists. Putting `life.past` in every prompt would let Gemini raise it on
// turn one, which would make the authored affection gating decorative.
const PAST_MIN_AFFECTION = 40;

function pastBlock(persona, state) {
  const past = persona.life?.past;
  if (!past || state.affection < PAST_MIN_AFFECTION) return '';
  return `

【過去のこと — 親しくなった相手にだけ、ぽつりと漏らす程度に】
${past.summary}
${(past.beats || []).map((b) => `- ${b}`).join('\n')}
扱い方: 自分からは持ち出さない。相手が過去や恋愛の話をしたときに、一言だけこぼす。
長く語らない。同情を引こうとしない。すぐ話題を戻して、笑ってごまかす。`;
}

// School-era memories are ordinary getting-to-know-you material, so the gate is
// low — but the framing is stated explicitly, because the one thing this must
// never become is her performing her teenage self for him.
const SCHOOL_MIN_AFFECTION = 20;

function schoolBlock(persona, state) {
  const sc = persona.life?.school;
  if (!sc || state.affection < SCHOOL_MIN_AFFECTION) return '';
  return `

【高校時代の思い出 — 昔話として】
${sc.summary}
${(sc.beats || []).map((b) => `- ${b}`).join('\n')}
今の気持ち: ${sc.nowFeels}
扱い方: 二十六歳の大人が懐かしく振り返る話として語る。当時の自分の見た目を売りにしない。
色っぽい話題とは絶対に混ぜない。混ざりそうになったら現在の話に戻す。`;
}

// Same gating logic as the past: below this the API isn't told this side of
// her exists, so it can't jump ahead of the authored escalation.
const INTIMATE_MIN_AFFECTION = 60;

function intimateBlock(persona, state) {
  const it = persona.life?.intimate;
  if (!it || state.affection < INTIMATE_MIN_AFFECTION) return '';
  return `

【この相手への気持ち — 親密度が高いときだけ】
${it.summary}
${(it.beats || []).map((b) => `- ${b}`).join('\n')}
表現の限度: ${it.limits}`;
}

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
- かっこは必ず半角の { } を使う。全角の｛｝は使わない。
- 読みは必ずひらがなで書く。カタカナやローマ字の読みは書かない。
- ふりがなは漢字の直後にだけ置く。送り仮名を含めない（○ 落{お}ち着{つ}く／× 落ち着{おちつ}く）。
- この波かっこ形式はふりがな専用。{name} のような変数や英単語のかっこは絶対に書かない。
- en には自然な英訳を書く。ローマ字は使わない。
- suggestions は相手（日本語学習者）が返しそうな短い日本語を1〜3個。相手の立場のセリフであって、あなたのセリフではない。
- 相手を質問攻めにしない。自分の話も混ぜる。
- 相手の日本語が少し不自然でも指摘しすぎない。会話を優先する。`;

function directionBlock(direction, userText) {
  if (!direction) return '';
  const bits = [];

  // This comes first on purpose. The director's plan is about pacing; it is not
  // a licence to ignore what he just wrote. Leading with the goal instead —
  // which for unmatched input reads "change the subject" — is what made her
  // answer beside the point.
  if (userText) {
    bits.push(
      `相手の直前のメッセージ: 「${userText}」`,
      'まずこの内容に具体的に反応すること。相手が話した固有名詞や出来事に触れる。',
      '一般的な相槌だけで済ませない。話を勝手にすり替えない。'
    );
  }
  bits.push(`そのうえでの狙い: ${direction.goal}`);
  if (direction.reference) bits.push(`口調の参考（内容ではなく雰囲気だけ真似る）: ${direction.reference}`);
  if (direction.askAbout) bits.push(`余裕があれば「${direction.askAbout}」についても聞く。`);
  return `\n【演出指示】\n${bits.join('\n')}`;
}

/* ---------- output hygiene ---------- */

// Braces are deliberately left intact here. The model is told not to emit
// {name}-style variables, but when it copies the habit from context anyway,
// fillSlots downstream substitutes the real value — which is the outcome we
// want. Only genuinely unfillable leftovers get flattened, in engine.js.
function cleanBubble(b) {
  const jp = String(b?.jp || '').trim();
  if (!jp) return null;
  return { jp: jp.slice(0, 160), en: String(b?.en || '').trim().slice(0, 200) };
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

  // Three gates, all before the request is built. Once the free tier says no
  // for the day, she goes back to authored lines and stays there until the
  // Pacific-midnight reset — no retry loop, no drip of doomed requests.
  const quota = loadQuota();
  if (quota.exhausted) {
    lastError = 'free-tier daily quota reached — using authored replies';
    return null;
  }
  if (quota.used >= (DAILY_CAP[settings.model] ?? DEFAULT_CAP)) {
    lastError = 'local daily cap reached — using authored replies';
    return null;
  }
  if (Date.now() < quota.blockedUntil) {
    lastError = 'rate limit hit — using authored replies for a moment';
    return null;
  }
  // Wait out the per-minute spacing rather than giving up on the turn. Bailing
  // here is what made her look deaf: at conversational typing speed most turns
  // fell inside the gap and silently dropped to an authored deflect.
  const gap = MIN_GAP_MS - (Date.now() - quota.lastCall);
  if (gap > 0) {
    if (gap > MIN_GAP_MS) {           // clock skew — don't hang on it
      lastError = 'rate-limited locally';
      return null;
    }
    await new Promise((r) => setTimeout(r, gap));
  }

  const system = [
    personaBlock(persona) + schoolBlock(persona, state) + pastBlock(persona, state) + intimateBlock(persona, state),
    memoryBlock(state, stage),
    RULES,
    directionBlock(direction, userText),
  ].join('\n\n');

  // History already ends with the user's latest message — respond() pushes it
  // before composing. Appending `userText` again sent it twice, and the model
  // noticed: 「え、2回言った！？」.
  const turns = (state.history || []).map((h) => ({
    role: h.role === 'her' ? 'model' : 'user',
    parts: [{ text: h.text }],
  }));

  // Proactive and scheduled messages put several of her turns back to back,
  // and a session opens on her line. Collapse same-role runs and drop any
  // leading model turns so the transcript alternates the way chat APIs expect.
  const contents = [];
  for (const t of turns) {
    if (!contents.length && t.role === 'model') continue;
    const prev = contents[contents.length - 1];
    if (prev && prev.role === t.role) prev.parts[0].text += '\n' + t.parts[0].text;
    else contents.push(t);
  }
  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: userText || '(会話を始めて)' }] });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  // Counted before the response comes back: a request that fails still
  // consumed a slot, and over-counting is the safe direction to be wrong in.
  saveQuota({ ...quota, used: quota.used + 1, lastCall: Date.now() });

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
          // Chit-chat needs no reasoning budget, and thinking tokens are billed
          // against the same output allowance — leaving it on burned ~200 extra
          // tokens per turn and added a second of latency for no gain.
          thinkingConfig: { thinkingLevel: 'low' },
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const hit = classifyQuotaError(res.status, body);
      if (hit) {
        const q = loadQuota();
        const strikes = hit.scope === 'unknown' ? q.strikes + 1 : 0;
        if (hit.scope === 'day' || strikes >= 3) {
          saveQuota({ ...q, exhausted: true, strikes });
          lastError = 'free-tier daily quota reached — using authored replies';
        } else {
          saveQuota({ ...q, blockedUntil: Date.now() + hit.waitMs, strikes });
          lastError = 'rate limit hit — using authored replies for a moment';
        }
      } else {
        lastError = `${res.status} ${body.slice(0, 200)}`;
      }
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
