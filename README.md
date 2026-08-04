# 結衣 — a Japanese companion chat app

A companion character who chats in casual N2 Japanese, remembers what you tell
her, messages you first when the conversation goes quiet, builds a relationship
over time, and occasionally sends photos.

**No backend, no build step.** Static files + `localStorage`. Works fully
offline on authored content; add a Google AI Studio key and she improvises the
wording of her replies instead of picking from a script.

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

## Gemini (optional)

Open ⚙, paste a [Google AI Studio key](https://aistudio.google.com/apikey), save.
The key lives in `localStorage` in that one browser — **it is never written to
this repo** and `↺` (reset memory) doesn't erase it.

What changes: the director still decides the *kind* of turn — react, ask, call
back a memory, deflect into a new topic — and memory, affection, photos and
grammar notes run exactly as before. The API only rewrites the *words* of the
turn the director already planned. So her pacing and her personality are the
authored ones either way; the API buys you replies that actually engage with
what you wrote instead of the nearest matching pattern.

`persona.json → life` is the shared canon — her flat, her boss 田中さん, the
stray cat 「しっぽ」, the ramen place she goes to weekly. It's injected into
every request, which is what stops an improvised reply inventing a different
life each turn.

### Staying on the free tier

The hard guarantee is Google's: **don't attach a billing account** to the Cloud
project behind the key. Without one the API returns `429 RESOURCE_EXHAUSTED`
rather than charging you. On top of that, `llm.js` enforces three limits itself:

| Gate | Behaviour |
|---|---|
| Daily cap | 200 requests for Flash, 800 for Flash-Lite — under the free RPD |
| Rate limit | 6.5s minimum between calls, under the free 10 RPM |
| 429 latch | A per-**day** quota error stops all calls until the Pacific-midnight reset; a per-**minute** one only pauses for the retry delay |

Every one of those falls back to the authored line. Hitting the limit looks like
her being slightly less responsive, never like an error. ⚙ shows the day's count.

## Her backstory

She likes you. She's also two years out of a relationship that taught her not
to trust being liked back, and it surfaces in her — briefly, and never on
demand. `persona.json → life.past` holds the canon; the beats are that she was
only called when convenient, that she read being needed as being valued, that
"I want to see you more" got her called clingy, and that she found out
afterwards there had been someone else. What stuck isn't the betrayal, it's the
suspicion that two years of her was just useful.

It unfolds across three gated threads: `t_ex` (affection 40) is her telling
you, `t_trust` (50) is her admitting the reflex it left her with, `t_like` (55)
is her noticing she likes you and finding that frightening. Telling you sets
`knows_ex`, which unlocks quieter follow-ups — the photo folder she can't
delete, bracing when you're kind, the admission that she thinks about him less
now and it might not only be because she's busy.

Three mechanisms keep this from becoming her whole personality:

- **`cond.chance`** — a rarity dial on `pick()`. Without it, an unseen line
  *wins* the least-seen draw, so the rarest content would fire the most.
- **Affection gates** on the topics, the proactive asides, and the 42 grammar
  cards tagged to the thread.
- **`llm.js` only puts `life.past` in the prompt above affection 40**, so Gemini
  can't raise on turn one what the authored gates are holding back.

A 400-draw simulation at affection 0 produces zero references to any of it.

## Proactive messages

She starts messages on her own after 55–105 seconds of silence, backing off
1.7× per unanswered nudge and giving up after five. These are **always
authored**, never API calls — they fire on a timer, so routing them through
Gemini would spend quota on an empty room.

About 40% of her nudges are **questions** rather than reports — entries marked
`"ask": true`, drawn from their own pool so a run of monologue always has
something answerable in it. Commenting on your silence needs two unanswered
nudges of grace and then wins only a third of draws, which puts 「あれ、いない？」
at roughly 9% of nudges instead of dominating them.

Author them in `dialogue.proactive`, same shape as everything else:

```jsonc
{
  "id": "p_a1", "s": "pout",
  "cond": { "band": ["afternoon"] },
  "b": [{ "jp": "田中{たなか}さんの修正{しゅうせい}指示{しじ}、また「なんかもうちょっとこう…」だった。",
          "en": "Tanaka's edit note was 'can you make it, like, a bit more…' again." }],
  "sug": [{ "jp": "それはひどい", "en": "That's rough" }]
}
```

`cond.minUnanswered` / `maxUnanswered` gate on how long she's been ignored, and
those lines jump the queue — otherwise 「無視してる？」 would lose the random
draw against 60 ordinary ones and never appear.

Currently 71 proactive lines: time-banded slices of her day, 14 questions aimed
at you, ignored-escalation, and affection-gated ones.

## Story arcs

Seven multi-beat threads that develop as you keep talking, gated on turns and
affection so they unfold rather than dump:

| arc | what happens |
|---|---|
| `t_deadline` | the brochure gets sent back to square one, and eventually shipped |
| `t_cat_gone` | しっぽ stops showing up; she detours home looking, then finds him |
| `t_minami` | her best friend is moving to Tokyo — and has heard about you |
| `t_film_fail` | a whole roll comes back blank because she left the back open |
| `t_promotion` | more accounts offered; she's pleased and frightened, then accepts |
| `t_swap` | she asks you to teach her English in exchange |
| `t_rainy` | a whole day indoors, and why she can't quite hate the rain |

Later beats gate behind earlier ones via `minTurns`, so `t_deadline_f3`
(「終わってはじめて、どれだけ疲れてたか分かった」) can't arrive before the
complaint that sets it up. Three proactive lines continue the arcs unprompted.

## Timed messages

Eight clock slots, 20 authored variants, in `dialogue.scheduled`:

| time | |
|---|---|
| 06:00 | おはよう — still half asleep |
| 07:30 | heading out, fighting the Hibiya line |
| 12:00 | lunch — what are you having? |
| 15:00 | the 3pm slump |
| 19:00 | dinner |
| 22:00 | winding down, how was your day |
| 23:00 | おやすみ |
| 01:00 | "wait, you're still up?" |

Each fires **once per local day** and expires: a slot is only delivered within
`window` minutes of its time, so opening the app at 21:00 doesn't hand you a
stale おはよう. That grace period is the point — the tab isn't open at 06:00, so
you get it when you arrive, provided you arrive soon enough. Arriving inside a
window opens with the timed message *instead of* the usual greeting rather than
stacking both.

If several come due at once, the most recent is delivered and the rest are
retired, so you never work through a backlog that's no longer true.

### Notifications

On by default, but there are real limits worth knowing before relying on them:

- **Only while the page is open.** These are plain `Notification` calls, not
  push. If the app isn't running in a tab or in the background, nothing fires —
  a 06:00 おはよう reaches you when you next open it, not on a closed phone.
  Real background delivery needs a service worker and a push server.
- **Only when the tab isn't focused.** Looking at the app already shows you the
  message, so notifying too would be noise.
- **`denied` is permanent from our side.** Browsers auto-deny a permission
  request that isn't tied to a user gesture, and once denied, asking again does
  nothing — only you can undo it in the browser's site settings. ⚙ now states
  the current permission and has a **test button** so a silent failure is
  visible instead of mysterious.

Permission is requested on your first message rather than at load, for the
gesture reason above.

## Chat history and gallery

The transcript persists. Reload and your conversation is still there to scroll
back through, with a 「ここから今日」 divider marking where the restored history
ends. It replays instantly — the typing animation is suppressed, or a reload
would look like her firing 200 messages at once. Capped at 400 entries.

🖼 opens the **gallery**: every photo she's sent, deduped and dated, newest
first. Tap any thumbnail — in the gallery or in the chat — for a full-size
lightbox. Photos whose image files don't exist yet show the same dashed
placeholder as in the chat.

`↺` clears both along with her memory.

## Deploying to GitHub Pages

Push and enable Pages; it's static, so nothing else is needed. **No key goes in
the repo** — each visitor (including you, per browser) enters their own in ⚙.

If you want the key restricted so a copied key is useless elsewhere, add an
HTTP-referrer restriction on it in the Google Cloud console, limited to
`yourname.github.io/*`. That's the only meaningful protection for a key used
from a browser; a key shipped inside the page is readable by anyone regardless
of how it's obfuscated.

## Layout

```
index.html
src/app.js              UI: bubbles, furigana, typing delays, chips, settings
src/styles.css
src/engine/
  normalize.js          NFKC, katakana→hiragana, script detection
  match.js              weighted substring intent scoring
  memory.js             entity capture + slot filling
  state.js              affection, stages, persistence, settings, history
  director.js           chooses the KIND of turn
  llm.js                optional Gemini leg + free-tier quota gates
  engine.js             getReply orchestration
src/content/            ← author here, no JS needed
  persona.json          who she is, and her fixed life canon
  intents.json          what the user might mean
  dialogue.json         everything she says, incl. proactive
  qa.json               questions aimed at her
  grammar-n2.json       all 156 N2 points, tagged to intents and topics
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

Currently **56 photos — 33 scenes and 23 selfies.** The scenes are her
surroundings: konbini hauls, ramen, gyoza, her desk at work and at home, the
empty office floor, the train window, the shopping street at dusk, the konbini
at 1am, the sky, rain, umbrellas, laundry, Nakameguro station, the Meguro river
in spring, the neighbourhood cat, her film camera, undeveloped rolls, prints,
her brother's CDs, the guitar she keeps not buying, her room, burnt home
cooking. The selfies run from affection 18 to 96.

A missing file shows a dashed placeholder with the path it expects, so entries
are authored before the images exist — drop a file in with the right name and it
appears with no code change.

**Scenes still needed (12):** `umbrella`, `bento`, `gyoza`, `sakura`,
`shippo-close`, `film-rolls`, `records`, `guitar-shop`, `laundry`, `breakfast`,
`deadline`, `old-photos`.

Most arrive through the `t_showme` topic (「今どこにいるか、当ててみて」) and the
`p_where*` proactive lines, so they read as her showing you where she is rather
than as a random drop.

### "How do I look?" selfies

Fifteen events where she wants you to see her and asks what you think. Unlike
the ambient photos, each carries its own `sug` chips, so her question is
actually answerable — tap 「似合ってる」 rather than typing into a dead end.
The `t_outfit` topic is how she leads in, and its three follows react to
whichever way you answered, including you being unhelpfully honest.

**Selfies still needed (15)**, all `.jpg` in `assets/photos/`:

| file | affection | moment |
|---|---|---|
| `ponytail` | 18 | tying her hair up, asking up or down |
| `glasses` | 20 | her glasses at home, rarely shown |
| `cafe-selfie` | 22 | the window seat, good light |
| `shoes-new` | 24 | new sneakers, shot from above |
| `cap-casual` | 25 | a cap, hiding bed-hair |
| `coat-winter` | 26 | bundled up, survival over cuteness |
| `gym-pink` | 28 | pink gym clothes, ponytail, all motivation |
| `dress-new` | 30 | new dress, second-guessing the fitting room |
| `hoodie-home` | 32 | oversized hoodie on the sofa |
| `haircut` | 35 | three centimetres off — did you notice? |
| `makeup` | 38 | makeup done properly, twice-a-month rare |
| `hair-down` | 40 | just taken down, debating cutting it |
| `earrings` | 42 | small new earrings nobody notices |
| `yukata` | 45 | is the obi crooked? |
| `dressed-up` | 55 | nowhere to go, just wanted you to see |

Emotions are spread across the set rather than defaulting to 照れ — excited for
the gym clothes and the new shoes, sleepy for the hoodie, surprised for the
haircut, shy for the dress and the last one.

## N2 grammar

All **156 points** of the standard JLPT N2 list are in `grammar-n2.json`, and a
600-turn simulation surfaces every one of them. They ride along as a collapsible
side note, never as the main message — roughly one every four turns, unseen
points first.

Each is tagged with `when.intent` and/or `when.topic`, and a matching card beats
a random one: complain about work and you get 〜どころか, say you're exhausted and
you get 〜てしかたがない, and the ex thread pulls 〜ざるを得ない, 〜ものの,
〜てはじめて. Topic matching matters because most of the conversation happens
inside her topic threads, where `intentId` is null and an intent-only match
would always fall through to a random card.

Examples are written in her voice and set in her life — 田中さん's vague edits,
the ramen place, the film she hasn't developed — so a card reads as an aside
from the conversation rather than a page from a textbook.

**Her lines use the grammar, and so do your reply chips.** 41 of the 80 topic
chips are built on an N2 pattern, and the chip's English names it:

```
[ 怒らざるを得ないよ ]              [ 探してみないことには分からないね ]
  You've no choice but to be         You won't know unless you look
  angry — 〜ざるを得ない               — 〜ないことには
```

Tapping one is production practice you don't notice doing, which is the half
that reading cards alone never gives you.

### Furigana rendering

Authored readings are always `漢字{かんじ}`, but Gemini writes its own and
doesn't always match: katakana readings, a numeral base (`1人{ひとり}`),
full-width `｛｝`. Those used to reach the screen as literal braces. `ruby()`
now normalises full-width braces, accepts numerals in the base and katakana in
the reading, and sweeps any unpaired `{...}` away — losing a reading is fine,
showing punctuation as text is not. The prompt also asks for half-width braces
and hiragana readings so most pair properly in the first place.

```jsonc
{
  "id": "n2_dokoroka",
  "point": "〜どころか",                      // furigana renders here too
  "en": "far from / let alone",
  "ex": "休{やす}めるどころか、仕事{しごと}が増{ふ}えた。",
  "exEn": "Far from getting a rest, I got more work.",
  "note": "Reality is the opposite of the expectation, and worse.",
  "when": { "intent": ["tired", "work_talk"], "topic": ["t_work"] },
  "cond": { "minAff": 40 }                  // 42 points sit in the ex thread
}
```

## Relationship model

Affection 0–100, gained by writing in Japanese, writing at length, telling her
things about yourself, and specific authored lines. Stages: 知り合い → 友達 →
仲良し → 大切な人. Stage and affection gate dialogue via `cond`.

The ⓘ button dumps live state; ↺ resets her memory.

## Why the authored layer stays

It isn't a fallback bolted on for offline use — it's the thing that makes her a
character rather than a chat window. The director's pacing, the memory
callbacks, the contextual photos and the relationship gates all live there, and
they behave identically whether or not the API answers. Turning the key off
costs you responsiveness to unusual input; it costs you none of the personality.

That's also what makes the free-tier limits survivable: running out of quota
degrades her, but never breaks her.
