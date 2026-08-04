// Public surface. Everything the UI needs is behind respond() / openSession() /
// proactive(). All three are async because the optional Gemini leg is.
//
// The authored engine runs in full whether or not an API key is set. The LLM
// rewrites the words of a turn the director already planned; it never decides
// what kind of turn it is, never touches memory, and never gates the app.

import { detectScript } from './normalize.js';
import { analyze, reactionBucket } from './analyze.js';
import { matchIntent } from './match.js';
import { ingest, fillSlots, recall } from './memory.js';
import { direct, pick, photoPlan, teachPlan, proactivePlan, scheduledPlan } from './director.js';
import { bumpAffection, timeBand, touchDay, stageOf, pushHistory, loadSettings, markUsed } from './state.js';
import { improvise, llmReady } from './llm.js';

// Intents where a lexicon word is part of the request, not a fact about him.
const SCAN_BLOCKING = ['ask_photo', 'meaning_question', 'teach_request'];

// Authored bubbles are templates and get reused forever. Slot-filling must
// never write back into the loaded JSON, so every turn works on copies.
const clone = (bubbles) => bubbles.map((b) => ({ ...b }));

// What the director's turn kinds mean, phrased as stage directions for the API.
const GOALS = {
  greet: '会話を切り出す。時間帯に合った軽い挨拶から。',
  qa: '自分について聞かれたので、素直に答えて、ついでに相手にも聞き返す。',
  intent: '相手の言ったことに自然に反応する。',
  topic_follow: '今の話題を掘り下げる。',
  callback: '前に相手が話してくれたことを思い出して、そこに触れる。',
  deflect: '相手の話にちゃんと乗る。分からないふりや話題転換はしない。',
  default: '自然に会話を続ける。',
};

// A pendingSlot is a machine word; the API needs it as a thing to ask about.
const SLOT_JP = {
  name: '名前（なんて呼べばいいか）',
  food: '好きな食べ物',
  hobby: '趣味',
  job: '仕事',
  place: '住んでいるところ',
  drink: '飲み物の好み',
  weekend: '週末の予定',
  music: '好きな音楽',
};

export class Companion {
  constructor(content) {
    this.persona = content.persona;
    this.intents = content.intents;
    this.dialogue = content.dialogue;
    this.grammar = content.grammar;
    this.lexicon = content.lexicon;
    this.sprites = content.sprites;
    this.qa = content.qa.entries;
  }

  /**
   * Session housekeeping, split out from the greeting so the caller can open
   * with a clock-pinned message instead. Composing a greeting and then throwing
   * it away would still burn its repeat counter and possibly a photo cooldown.
   */
  startSession(state) {
    const { gapDays } = touchDay(state);
    state._band = timeBand();
    // A question she asked last session isn't pending anymore. Without this,
    // a restored pendingSlot swallows the first thing said on return.
    state.pendingSlot = null;
    state.pendingTopic = null;
    return { gapDays };
  }

  /** Is a clock-pinned message due right now? Pure — composes nothing. */
  hasScheduled(state) {
    return !!scheduledPlan(state, this.dialogue, new Date());
  }

  /** First turn of a session: she speaks first, unprompted. */
  async openSession(state) {
    const { gapDays } = this.startSession(state);
    const plan = direct({
      state,
      dialogue: this.dialogue,
      intentId: null,
      sessionStart: true,
      gapDays,
      band: timeBand(),
    });
    // Authored, like the proactive nudges: the opener answers nothing, so
    // spending a request on it would cost a free-tier slot per page load —
    // and burn the rate-limit gap that the first real reply wants.
    return this._compose(plan, state, {
      newMemories: [],
      script: 'jp',
      band: timeBand(),
      noLLM: true,
    });
  }

  /**
   * She messages first, unprompted — the idle timer in app.js drives this.
   * Deliberately authored-only: it fires on a clock rather than on user input,
   * so routing it through the API would burn free-tier quota on nobody.
   */
  async proactive(state) {
    state._band = timeBand();
    const plan = proactivePlan(state, this.dialogue, timeBand());
    if (!plan) return null;

    state.lastProactiveTurn = state.turns;
    state.unanswered = (state.unanswered || 0) + 1;
    return this._compose(plan, state, {
      newMemories: [],
      script: 'jp',
      band: state._band,
      noLLM: true,
    });
  }

  /**
   * Clock-driven message. Like `proactive`, authored only — it fires on a
   * timer, and 「おやすみ」 at 23:00 shouldn't cost a free-tier request.
   */
  async scheduled(state) {
    state._band = timeBand();
    const plan = scheduledPlan(state, this.dialogue, new Date());
    if (!plan) return null;

    // Retire every slot that came due, not just the one delivered, so a
    // backlog can't dribble out over the following minutes.
    state.scheduled = { ...(state.scheduled || {}) };
    for (const at of plan.slots) state.scheduled[at] = plan.day;

    state.unanswered = (state.unanswered || 0) + 1;
    return this._compose(plan, state, {
      newMemories: [],
      script: 'jp',
      band: state._band,
      noLLM: true,
    });
  }

  /**
   * Main entry: user said something.
   * `opts.fromChip` marks a tapped quick-reply. Those are authored prompts
   * with authored answers waiting for them, so they take the scripted path —
   * no request, no quota, and no chance of the API wandering off a thread the
   * chip was written to continue.
   */
  async respond(raw, state, opts = {}) {
    state.turns += 1;
    state.unanswered = 0;
    pushHistory(state, 'me', raw);

    state._band = timeBand();
    const script = detectScript(raw);
    const a = analyze(raw);

    // Match before ingesting: the intent tells us whether a lexicon word is
    // really a fact about him (「写真が趣味」) or part of a request (「写真見せて」).
    const match = matchIntent(raw, this.intents);

    // Questions aimed at her are scored separately. A question wins ties —
    // 「趣味は写真？」 is her being asked, not him volunteering a hobby.
    const qaHit = matchIntent(raw, this.qa);
    const qaWins =
      qaHit && (!match || qaHit.score * (a.question ? 1.6 : 1) >= match.score);
    const qaEntry = qaWins ? this.qa.find((e) => e.id === qaHit.id) : null;

    const newMemories = ingest(state, raw, this.lexicon, {
      // 「ラーメン好き？」 asked OF her must not file ramen as HIS favourite.
      skipScan: !!qaEntry || (match && SCAN_BLOCKING.includes(match.id)),
      intentId: match?.id ?? null,
    });

    // Writing in Japanese is the behaviour we want to reinforce.
    if (script === 'jp') bumpAffection(state, 1);
    if (script === 'jp' && raw.length > 12) bumpAffection(state, 1);
    if (newMemories.length) bumpAffection(state, 1);

    const plan = direct({
      state,
      dialogue: this.dialogue,
      intentId: match?.id ?? null,
      qaEntry,
      sessionStart: false,
      gapDays: 0,
      band: state._band,
      justLearned: newMemories.length > 0,
    });

    // What she's currently talking about decides which photo she'd reach for.
    return this._compose(plan, state, {
      newMemories,
      script,
      analysis: a,
      intentId: match?.id ?? null,
      intentScore: match?.score ?? 0,
      band: state._band,
      userText: raw,
      fromChip: !!opts.fromChip,
    });
  }

  async _compose(plan, state, meta) {
    const bubbles = [];
    let sprite = 'neutral';
    let photo = null;
    let suggestions = [];

    // Notes accumulated while assembling the authored turn. If the API leg is
    // on, these become stage directions instead of being spoken verbatim — so
    // an improvised reply still acknowledges what she just learned, still
    // asks the question the director wanted asked, and still lands on the
    // topic the director chose.
    const direction = { goal: [], refs: [], askAbout: null };

    // Acknowledge anything she just learned about him — before her own line.
    for (const mem of meta.newMemories.slice(0, 1)) {
      const ackSet = this.dialogue.acks[mem.slot] || this.dialogue.acks.default;
      const ack = pick(ackSet, state);
      if (ack) {
        bubbles.push(...clone(ack.b));
        sprite = ack.s || sprite;
        markUsed(state, ack.id);
      }
      direction.goal.push(
        `相手について今「${mem.slot} = ${mem.value}」と知ったところ。まずそこに反応する。`
      );
    }

    // He wrote in English — a nudge, not a scolding, and only occasionally.
    if (meta.script === 'en' && state.turns % 3 === 1) {
      const nudge = pick(this.dialogue.nudges, state);
      if (nudge) bubbles.push(...clone(nudge.b));
    }

    // Polite form to a friend is the most common thing an N2 learner overdoes,
    // and she's already established she dislikes it. Rate-limited hard, or
    // 「そうです」 would trigger it every other turn.
    if (
      meta.analysis?.polite &&
      state.turns - state.lastRegisterTurn > 8 &&
      state.affection >= 8
    ) {
      const reg = pick(this.dialogue.registerNudges, state);
      if (reg) {
        bubbles.push(...clone(reg.b));
        sprite = reg.s || sprite;
        state.lastRegisterTurn = state.turns;
        markUsed(state, reg.id);
      }
      direction.goal.push('相手が敬語で話しているので、軽くからかってタメ口を促す。');
    }

    if (plan.kind === 'photo_request') {
      const p = photoPlan(state, this.dialogue, { ...meta, forced: true });
      if (p) {
        bubbles.push(...clone(p.b));
        photo = { file: p.file, alt: p.alt };
        sprite = p.s || 'shy';
        state.lastPhotoTurn = state.turns;
        markUsed(state, p.id);
        bumpAffection(state, p.aff ?? 1);
        // A photo that asks you something needs chips to answer it with.
        if (p.sug) suggestions = p.sug;
        if (p.q) state.pendingSlot = p.q;
      } else {
        const deny = pick(this.dialogue.photoDeny, state);
        if (deny) {
          bubbles.push(...clone(deny.b));
          sprite = deny.s || 'shy';
        }
      }
    }

    // Nothing matched — but if a noun could be pulled out of what he wrote,
    // quoting it back reads as listening, where a generic line reads as a miss.
    // Extraction is heuristic, so this only engages when it produced something
    // that passed the validator; otherwise the authored deflect stands.
    let echo = null;
    if (plan.kind === 'deflect' && meta.analysis?.topic) {
      const rx = pick(this.dialogue.reactions[reactionBucket(meta.analysis)], state);
      if (rx) {
        echo = meta.analysis.topic;
        bubbles.push(...clone(rx.b));
        sprite = rx.s || sprite;
        suggestions = rx.sug || suggestions;
        bumpAffection(state, rx.aff ?? 0);
        markUsed(state, rx.id);
      }
    }

    const v = echo ? null : plan.variant;
    if (v) {
      bubbles.push(...clone(v.b));
      if (v.file) photo = { file: v.file, alt: v.alt || '' };
      sprite = v.s || sprite;
      suggestions = v.sug || suggestions;
      bumpAffection(state, v.aff ?? 0);
      markUsed(state, v.id);
      if (v.q) state.pendingSlot = v.q;
      if (v.setFlag) state.flags[v.setFlag] = true;
      if (plan.kind === 'callback') state.lastCallbackTurn = state.turns;
      if (plan.kind !== 'deflect') direction.refs.push(v.b.map((b) => b.jp).join(' '));
      if (v.q) direction.askAbout = v.q;
    }

    // Deflect turns chain into a fresh topic so the conversation never stalls.
    if (plan.kind === 'deflect' && plan.topic && !echo) {
      const open = pick([plan.topic.open], state) || plan.topic.open;
      bubbles.push(...clone(open.b));
      sprite = open.s || sprite;
      suggestions = open.sug || suggestions;
      if (open.q) state.pendingSlot = open.q;
      state.pendingTopic = plan.topic.id;
      // Count the topic too — that's the key repeat-avoidance picks topics on.
      markUsed(state, plan.topic.id);
      markUsed(state, plan.topic.open.id);
      direction.goal.push('相手の話に反応したあと、自分からも話題を少し広げる。');
      direction.refs.push(open.b.map((b) => b.jp).join(' '));
      if (open.q) direction.askAbout = open.q;
    } else if (plan.kind === 'topic_follow') {
      state.pendingTopic = null;
    } else if (plan.kind !== 'greet' && plan.kind !== 'proactive' && plan.kind !== 'scheduled') {
      // A proactive nudge is her talking into silence — it must not wipe the
      // thread she's still waiting on an answer for.
      state.pendingTopic = null;
    }

    // ---- optional: let Gemini say it in her own words instead ----
    //
    // Everything above already happened: memory written, affection moved,
    // pendingSlot/pendingTopic set, repeat counters bumped. Only the text is
    // replaced, and only if the call succeeds. `photo_request` is excluded —
    // an improvised line about a photo she isn't actually sending would lie.
    const settings = loadSettings();
    let llmHandled = false;
    const swappable =
      !meta.noLLM &&
      !meta.fromChip &&
      bubbles.length &&
      plan.kind !== 'photo_request' &&
      llmReady(settings);

    if (swappable) {
      const out = await improvise({
        settings,
        persona: this.persona,
        state,
        stage: stageOf(state),
        userText: meta.userText,
        direction: {
          goal: direction.goal.length
            ? direction.goal.join(' ')
            : GOALS[plan.kind] || GOALS.default,
          reference: direction.refs.join(' / ') || null,
          askAbout: direction.askAbout ? SLOT_JP[direction.askAbout] || direction.askAbout : null,
        },
      });

      if (out) {
        llmHandled = true;
        bubbles.length = 0;
        bubbles.push(...out.bubbles);
        if (out.sprite) sprite = out.sprite;
        if (out.suggestions.length) suggestions = out.suggestions;
        // Authored deflects carry no affection, so a conversation carried
        // mostly by the API would otherwise never advance a stage.
        if (plan.kind === 'deflect') {
          bumpAffection(state, 1);
          // The authored deflect chains into a scripted topic to stop the
          // conversation stalling. The API just engaged with what he actually
          // said, so leaving that thread pending would drag the *next* turn
          // back onto a script he never asked for.
          state.pendingTopic = null;
          state.pendingSlot = null;
        }
      }
    }

    // Unsolicited photo, on her own initiative — usually because the photo
    // matches whatever she just brought up.
    if (!photo && plan.kind !== 'photo_request') {
      // On a deflect the director pre-picks a topic to chain into. If the API
      // then took the turn somewhere else — which is the whole point of the
      // API — that topic was discarded, and using it to choose a photo pins a
      // picture to a subject she never raised: an umbrella question answered
      // with a photo of team lunch.
      const discardedTopic = llmHandled && plan.kind === 'deflect';
      const p = photoPlan(state, this.dialogue, {
        ...meta,
        topicId: discardedTopic ? state.pendingTopic : (plan.topic?.id ?? state.pendingTopic ?? null),
        contextualOnly: llmHandled,
      });
      if (p) {
        bubbles.push(...clone(p.b));
        photo = { file: p.file, alt: p.alt };
        sprite = p.s || sprite;
        state.lastPhotoTurn = state.turns;
        markUsed(state, p.id);
        bumpAffection(state, p.aff ?? 0);
        // She asked what you think — her question outranks whatever chips the
        // turn's own line offered, since the photo is what's on screen now.
        if (p.sug) suggestions = p.sug;
        if (p.q) state.pendingSlot = p.q;
      }
    }

    // Teaching rides along as a side note, never as the main message.
    let teach = null;
    const g = teachPlan(state, this.grammar, {
      ...meta,
      topicId: plan.topic?.id ?? state.pendingTopic ?? null,
    });
    if (g && bubbles.length) {
      teach = g;
      state.lastTeachTurn = state.turns;
      if (!state.learned.includes(g.id)) state.learned.push(g.id);
    }

    // Authored lines are guaranteed fillable by pick(); an improvised one is
    // not, so anything still in braces after filling gets its braces dropped
    // rather than shown to the user as 「{name}、それ本当？」.
    const extras = echo ? { echo } : {};
    const deSlot = (s) => fillSlots(s, state, extras).replace(/\{(\w+)\}/g, '$1');
    for (const b of bubbles) {
      b.jp = deSlot(b.jp);
      if (b.en) b.en = deSlot(b.en);
    }
    suggestions = suggestions.map((s) => ({ jp: deSlot(s.jp), en: s.en }));

    // Her side of the transcript, ruby markup stripped — the API shouldn't be
    // shown furigana braces as if they were part of normal Japanese.
    pushHistory(state, 'her', bubbles.map((b) => b.jp).join(' ').replace(/\{[ぁ-んー]+\}/g, ''));

    return {
      bubbles,
      sprite: this.sprites[sprite] ? sprite : 'neutral',
      photo,
      teach,
      suggestions,
      stage: stageOf(state),
      affection: state.affection,
      name: recall(state, 'name'),
    };
  }
}
