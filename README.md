# 結衣 — a Japanese companion chat app

A rule-based companion character who chats in casual N2 Japanese, remembers what
you tell her, builds a relationship over time, and occasionally sends photos.

**No AI API, no backend, no build step.** Static files + `localStorage`.

## Run it

```bash
python3 -m http.server 8777
```

Then open <http://localhost:8777>. It must be served over HTTP — the content
loads via `fetch`, which `file://` blocks.

## How she can feel smart without an LLM

Pattern matching alone produces a FAQ bot. Four things do the actual work:

1. **She leads.** Most turns end with a question, which collapses the space of
   likely replies into something matchable. Quick-reply chips reinforce it.
2. **She remembers.** Facts you mention (name, food, job, hobby, where you live)
   are stored and brought up again turns later — "そういえば、ラーメン好きって
   言ってたよね". This reads as intelligence more than any matching rule.
3. **She never fails visibly.** Unmatched input gets a deflection in character
   ("まあいいや。それよりさ、聞いて聞いて—") followed immediately by a new
   topic. She's a little self-absorbed, which conveniently hides parser misses.
4. **The director decides turn *type* before turn *text*** — react, ask, call
   back a memory, teach, send a photo. That's what gives it pacing.

## Layout

```
index.html
src/app.js              UI: bubbles, furigana, typing delays, chips
src/styles.css
src/engine/
  normalize.js          NFKC, katakana→hiragana, script detection
  match.js              weighted substring intent scoring
  memory.js             entity capture + slot filling
  state.js              affection, stages, persistence
  director.js           chooses the KIND of turn
  engine.js             getReply orchestration
src/content/            ← author here, no JS needed
  persona.json          who she is
  intents.json          what the user might mean
  dialogue.json         everything she says
  grammar-n2.json       N2 points woven in as side notes
  lexicon.json          entities worth remembering
  sprites.json          emotion → sprite file
assets/sprites/         drop your sprites here
assets/photos/          drop her photos here
```

## Adding content

Everything she says lives in `src/content/dialogue.json`. No code changes needed.

```jsonc
{
  "id": "t_coffee_open",        // unique — used to avoid repeating lines
  "s": "smile",                 // sprite emotion key
  "b": [                        // bubbles, sent one after another
    { "jp": "コーヒー派？紅茶{こうちゃ}派？", "en": "Coffee or tea person?" }
  ],
  "q": "drink",                 // your next message gets stored in this slot
  "sug": [{ "jp": "コーヒー", "en": "Coffee" }],
  "aff": 1,                     // affection delta
  "cond": { "minAff": 20 }      // gate by affection / stage / known slot / flag
}
```

- **Furigana:** write `漢字{かんじ}` inline. The renderer turns it into `<ruby>`.
  Readings are authored, not generated — accurate, and zero dependencies.
- **Slots:** `{name}`, `{food}`, `{job}`, `{hobby}`, `{place}` fill from memory.
  A line referencing an unknown slot is skipped automatically, so you can write
  familiar lines without guarding them.
- **New rememberable entity:** add it to `lexicon.json` and write an `acks`
  entry for it. Slots backed by a lexicon only accept lexicon values — that's
  what stops "疲れた…" being filed as your favourite food.

## Sprites and photos

`sprites.json` maps emotion keys to files. Drop PNGs into `assets/sprites/`
with the listed filenames and they appear automatically; until then a coloured
placeholder shows. Same for `assets/photos/` — the photo bubble shows a dashed
placeholder with the expected path when a file is missing.

### Photo events

Photos are **contextual**, not just random — that's what makes them feel like
she's actually living somewhere. Each entry in `dialogue.photos` declares when
she'd send it:

```jsonc
{
  "id": "ph_ramen",
  "kind": "scene",                                   // or "selfie"
  "minAffection": 6,
  "file": "assets/photos/ramen.jpg",
  "when": { "intent": ["food_talk"], "topic": ["t_meals"] },
  "b": [{ "jp": "はい、証拠{しょうこ}写真{しゃしん}。", "en": "Here, photographic evidence." }]
}
```

- Mention ramen and she sends the bowl; complain about work and you get her
  desk; say it's raining and you get her window.
- `band` triggers on time of day — the station at dusk, morning light in her
  kitchen, the empty office floor at night.
- **scene** photos (her surroundings) are frequent, 5-turn cooldown. **selfies**
  are rarer, 12-turn cooldown, and are what 「写真見せて」 reaches for first —
  falling back to showing you her surroundings if she isn't comfortable yet.
- A photo with no `when` only appears on the low-probability random path.
- Ask too often and she deflects (`photoDeny`) rather than spamming.

Currently 19 photos: konbini hauls, ramen, her desk, the office at night, the
sky, rain on the window, Nakameguro station, the Meguro river, a neighbourhood
cat, her film camera, developed prints, her room, burnt home cooking — plus four
selfies gated at affection 25/35/45/60.

## Relationship model

Affection 0–100, gained by writing in Japanese, writing at length, telling her
things about yourself, and specific authored lines. Stages: 知り合い → 友達 →
仲良し → 大切な人. Stage and affection gate dialogue via `cond`.

The ⓘ button dumps live state; ↺ resets her memory.

## If you later want an LLM

`Companion.respond()` is the only surface the UI touches, and the fallback path
is one branch in `director.js` (`kind: 'deflect'`). Swapping in WebLLM or an API
for *just that branch* leaves the authored personality, memory, and pacing
intact.
