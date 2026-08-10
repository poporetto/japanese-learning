// The director decides WHAT KIND of turn she takes before deciding the words.
// This is the difference between a lookup table and a character with pacing.

import { recall, callbackCandidates, slotsSatisfied } from './memory.js';
import { stageOf, localDate, dayType, dayOfWeek } from './state.js';

/**
 * Filter authored variants by their conditions, then prefer unseen ones.
 * `ctx.intentId` is the intent matched on *this* turn, which lets a follow-up
 * branch on the answer you just gave — the difference between a question and
 * a choice.
 */
export function pick(variants, state, ctx = {}) {
  const usable = (variants || []).filter((v) => {
    const c = v.cond || {};
    if (c.afterIntent && !c.afterIntent.includes(ctx.intentId)) return false;
    // Quick-reply chips are authored sentences, and most match no intent at
    // all — so a branch that depends on *which* answer you gave has to look at
    // the words. Substring/regex against the raw message.
    if (c.afterText && !new RegExp(c.afterText).test(ctx.userText || '')) return false;
    if (c.minAff != null && state.affection < c.minAff) return false;
    if (c.maxAff != null && state.affection >= c.maxAff) return false;
    if (c.stage && stageOf(state).id !== c.stage) return false;
    if (c.needSlot && recall(state, c.needSlot) === null) return false;
    if (c.lacksSlot && recall(state, c.lacksSlot) !== null) return false;
    if (c.minTurns != null && state.turns < c.minTurns) return false;
    // How many unanswered nudges she's already sent — lets a proactive line
    // escalate from 「ねえ」 to 「無視しないでよ」 without new selection code.
    if (c.minUnanswered != null && (state.unanswered || 0) < c.minUnanswered) return false;
    if (c.maxUnanswered != null && (state.unanswered || 0) > c.maxUnanswered) return false;
    // state._band is refreshed each turn by the engine; it's derived, not saved state.
    if (c.band && !c.band.includes(state._band)) return false;
    const allowedDays = Array.isArray(c.dayType) ? c.dayType : c.dayType ? [c.dayType] : null;
    if (allowedDays && !allowedDays.includes(state._dayType || dayType())) return false;
    const weekdays = Array.isArray(c.dayOfWeek) ? c.dayOfWeek : c.dayOfWeek ? [c.dayOfWeek] : null;
    if (weekdays && !weekdays.includes(state._dayOfWeek || dayOfWeek())) return false;
    if (c.flag && !state.flags[c.flag]) return false;
    if (c.notFlag && state.flags[c.notFlag]) return false;
    // Rarity dial. `pick` prefers least-seen, so an unseen line otherwise
    // *wins* the draw — exactly backwards for something she should only bring
    // up once in a while, like her ex.
    if (c.chance != null && Math.random() > c.chance) return false;
    // Never offer a line — or a quick-reply chip — whose {slots} we can't fill.
    const text = [...(v.b || []), ...(v.sug || [])].map((x) => x.jp).join('');
    if (!slotsSatisfied(text, state)) return false;
    return true;
  });

  if (!usable.length) return null;

  // Anything said in the last ~30 picks is off the table while an alternative
  // exists. Falls back to the full set for pools too small to honour it.
  const recent = new Set(state.recent || []);
  const pool = usable.filter((v) => !recent.has(v.id));
  const from = pool.length ? pool : usable;

  const min = Math.min(...from.map((v) => state.seen[v.id] || 0));
  const freshest = from.filter((v) => (state.seen[v.id] || 0) === min);
  return freshest[Math.floor(Math.random() * freshest.length)];
}

// What counts as actually reaching out, rather than just talking at her.
const RE_REACHING_OUT =
  /ごめん|すまな|悪{わる}?かった|謝|話(そう|そっか)|待って|ここにいる|そばにいる|大丈夫\?|大丈夫？|愛して|好きだよ/;

/**
 * Chooses the turn plan. Returns { kind, variant, extra }.
 * Order here IS the personality: she prioritizes her own thread over
 * mechanically answering, which is what stops it feeling like a FAQ bot.
 */
export function direct(ctx) {
  const { state, dialogue, intentId, qaEntry, sessionStart, gapDays, band } = ctx;

  // 1. Session framing always wins.
  if (sessionStart) {
    if (state.turns === 0) {
      const v = pick(dialogue.greetings.first, state);
      if (v) return { kind: 'greet', variant: v };
    }
    if (gapDays >= 3) {
      const v = pick(dialogue.greetings.longGap, state);
      if (v) return { kind: 'greet', variant: v };
    }
    const v = pick(dialogue.greetings[band], state);
    if (v) return { kind: 'greet', variant: v };
  }

  // 1.5 She's withdrawn. This deliberately pre-empts her own threads: the
  //     point of the beat is that she isn't engaging, and a warm topic firing
  //     mid-sulk would undo it. Expires on its own clock.
  if (state.coldUntil && Date.now() < state.coldUntil && !sessionStart) {
    // Reaching out properly ends it. Without this the only way through a sulk
    // is the wall clock, which makes the beat something that happens *to* you
    // and leaves the reconciliation lines unreachable.
    if (RE_REACHING_OUT.test(ctx.userText || '')) {
      const v = pick(dialogue.thaw, state);
      if (v) return { kind: 'thawed', variant: v };
    }
    const v = pick(dialogue.withdrawn, state);
    if (v) return { kind: 'withdrawn', variant: v };
  }

  // 2. A direct question about her outranks everything. Failing to answer one
  //    is the loudest way to break the illusion that she's listening.
  if (qaEntry) {
    const v = pick(qaEntry.a, state);
    if (v) return { kind: 'qa', variant: v };
  }

  // 3. Intents she must never ignore.
  const HARD = ['ask_photo', 'meaning_question', 'teach_request', 'goodbye', 'confess'];
  if (intentId && HARD.includes(intentId)) {
    if (intentId === 'ask_photo') return { kind: 'photo_request' };
    const v = pick(dialogue.intentReplies[intentId], state);
    if (v) return { kind: 'intent', variant: v };
  }

  // 3. Ordinary intent reply. A contentless 「うん」 carries no topic of its
  //    own, so it yields to her open thread instead.
  const CONTENTLESS = ['affirm', 'deny'];
  const yieldToTopic = state.pendingTopic && CONTENTLESS.includes(intentId);
  if (intentId && dialogue.intentReplies[intentId] && !yieldToTopic) {
    const v = pick(dialogue.intentReplies[intentId], state);
    if (v) return { kind: 'intent', variant: v };
  }

  // 4. She asked something and is waiting — follow her own thread.
  if (state.pendingTopic) {
    const topic = dialogue.topics.find((t) => t.id === state.pendingTopic);
    if (topic) {
      const turn = { intentId, userText: ctx.userText };
      // Two passes: a follow that declares which answer it responds to wins
      // outright. Otherwise the generic follows would tie with it in the draw
      // and your choice would only be honoured a third of the time.
      const branching = topic.follow.filter((f) => f.cond?.afterText || f.cond?.afterIntent);
      const v = pick(branching, state, turn) || pick(
        topic.follow.filter((f) => !f.cond?.afterText && !f.cond?.afterIntent), state, turn
      );
      if (v) return { kind: 'topic_follow', variant: v, topic };
    }
  }

  // 5. Nothing matched — bring up something he told her earlier.
  const cooled = state.turns - state.lastCallbackTurn > 6;
  if (cooled) {
    const known = callbackCandidates(state).map((c) => c.slot);
    const cb = pick(
      (dialogue.callbacks || []).filter((c) => known.includes(c.cond?.needSlot)),
      state
    );
    if (cb) return { kind: 'callback', variant: cb };
  }

  // 6. Deflect and start a fresh topic. She never says "I don't understand".
  //    But if she just successfully learned something, apologizing for not
  //    following would be nonsense — pivot straight into a new topic.
  // Topics that exist to fill a gap she still has (like your name) jump the
  // queue — otherwise they lose the random draw forever.
  const gapTopics = dialogue.topics.filter((t) => t.cond?.lacksSlot);
  const topic = pick(gapTopics, state) || pick(dialogue.topics, state);
  // She wrote the chip herself, so answering it with 「もう一回、簡単に言って」
  // reads as her disowning her own sentence — measured at 22% of taps. A tap
  // draws from `pivot`, which acknowledges and moves on without claiming she
  // missed anything.
  const pool = ctx.fromChip ? (dialogue.pivot || []) : dialogue.deflect;
  const deflect = ctx.justLearned ? null : pick(pool, state);
  return { kind: 'deflect', variant: deflect, topic };
}

/**
 * Messages pinned to the clock rather than to idle time — おはよう at 6,
 * meals, おやすみ at 23.
 *
 * Each slot fires at most once per local day. A slot also expires: opening the
 * app at 9pm should not deliver a stale "good morning", so a slot is only
 * delivered within `window` minutes of its time. That grace period is what
 * makes it work at all, since the tab isn't open at 06:00 most days — you get
 * the message when you show up, provided you show up soon enough.
 */
export function scheduledPlan(state, dialogue, now = new Date()) {
  const today = localDate(now);
  const mins = now.getHours() * 60 + now.getMinutes();
  const fired = state.scheduled || {};

  const due = (dialogue.scheduled || []).filter((e) => {
    if (fired[e.at] === today) return false;
    const [h, m] = e.at.split(':').map(Number);
    const late = mins - (h * 60 + m);
    return late >= 0 && late <= (e.window ?? 90);
  });
  if (!due.length) return null;

  // Several can come due at once — after a long absence, or when two slots sit
  // close together. Deliver the most recent and retire the rest, rather than
  // working through a backlog that's no longer true.
  const latest = due.reduce((a, b) => (a.at > b.at ? a : b)).at;
  const v = pick(due.filter((e) => e.at === latest), state);
  if (!v) return null;

  return { kind: 'scheduled', variant: v, slots: [...new Set(due.map((e) => e.at))], day: today };
}

/**
 * She speaks into silence. Two shapes, and the mix is what stops the nudges
 * reading like a reminder app: sometimes a fragment of her own day
 * (`dialogue.proactive`), sometimes she just opens a whole new topic —
 * which reuses the deflect path so the follow-up thread works identically.
 */
export function proactivePlan(state, dialogue, band) {
  const pool = dialogue.proactive || [];

  // Being ignored changes what she says — but only sometimes. Jumping the
  // queue on every unanswered nudge made 「あれ、いない？」 the thing she says
  // most, which reads as needy rather than as a person with her own evening.
  // Two nudges of grace first, then it's a minority of draws even after that.
  if ((state.unanswered || 0) >= 2 && Math.random() < 0.35) {
    const nag = pick(pool.filter((p) => p.cond?.minUnanswered != null), state);
    if (nag) return { kind: 'proactive', variant: nag };
  }

  // Every so often she leads with a question about him rather than a report
  // about herself — otherwise proactive turns are all monologue and there's
  // nothing to answer.
  if (Math.random() < 0.3) {
    const q = pick(pool.filter((p) => p.ask && (!p.cond?.band || p.cond.band.includes(band))), state);
    if (q) return { kind: 'proactive', variant: q };
  }

  const openTopic = state.turns > 0 && !state.pendingTopic && Math.random() < 0.3;

  if (openTopic) {
    const topic = pick(dialogue.topics, state);
    if (topic) return { kind: 'deflect', variant: null, topic };
  }

  const v = pick(
    pool.filter(
      (p) =>
        p.cond?.minUnanswered == null &&
        !p.ask &&
        (!p.cond?.band || p.cond.band.includes(band))
    ),
    state
  );
  if (v) return { kind: 'proactive', variant: v };

  // Nothing left unseen that fits — fall back to opening a topic rather than
  // going quiet, since going quiet is the one thing this feature exists to fix.
  const topic = pick(dialogue.topics, state);
  return topic ? { kind: 'deflect', variant: null, topic } : null;
}

// Snapshots of her surroundings are cheap and frequent; pictures of herself
// are the rarer, more loaded thing.
const COOLDOWN = { scene: 5, selfie: 9 };

// A 2-character keyword scores 4 — just over the matcher's threshold, and a
// pure guess. Good enough to pick a reply, not good enough to pick a picture:
// 「財布を落として大変だった」 weakly matched work_talk and produced a photo of
// her tidy desk. Photos need a keyword that actually carries the subject.
const PHOTO_INTENT_MIN = 8;

/** Does this photo fit what's being talked about right now? */
function fitsContext(photo, ctx) {
  const w = photo.when;
  if (!w) return false; // ambient photos only ever fire on the random path
  if (w.intent?.includes(ctx.intentId) && (ctx.intentScore ?? 0) >= PHOTO_INTENT_MIN) return true;
  if (w.topic?.includes(ctx.topicId)) return true;
  // `band` means "any time this evening" — ambient flavour, fine alongside an
  // authored line. When the API has just written something specific about what
  // he said, a photo justified only by the hour is a non-sequitur.
  if (w.band?.includes(ctx.band) && !ctx.contextualOnly) return true;
  return false;
}

/**
 * Should a photo ride along with this turn?
 * Context-matched photos fire readily — her sending a bowl of ramen the moment
 * ramen comes up is most of what makes the feature feel alive.
 */
export function photoPlan(state, dialogue, ctx = {}) {
  const { forced = false } = ctx;
  const since = state.turns - state.lastPhotoTurn;

  const eligible = (dialogue.photos || []).filter(
    (p) =>
      state.affection >= p.minAffection &&
      since >= (forced ? 4 : COOLDOWN[p.kind] ?? COOLDOWN.scene)
  );
  if (!eligible.length) return null;

  // Asked directly: she reaches for a picture of herself if she's comfortable
  // enough, otherwise deflects into showing her surroundings instead.
  if (forced) {
    const selfies = eligible.filter((p) => p.kind === 'selfie');
    return pick(selfies, state) || pick(eligible, state);
  }

  const relevant = eligible.filter((p) => fitsContext(p, ctx));
  if (relevant.length && Math.random() < 0.72) return pick(relevant, state);

  // Otherwise, occasionally, unprompted — she just felt like sharing.
  // Not when the API wrote the turn, though: an improvised reply about your
  // new cat followed by an authored caption reading 「朝ごはん、立ったまま」
  // reads as her not listening, which is the exact failure the API is there
  // to fix. Contextual photos still fire; only the random drop is suppressed.
  if (!ctx.contextualOnly && Math.random() < 0.15) return pick(eligible, state);
  return null;
}

/**
 * Should a grammar note be appended? Roughly every 4 turns.
 * A point tagged for the current topic wins — 〜てしかたがない landing on a
 * message about being exhausted teaches far better than a random card.
 */
export function teachPlan(state, grammar, ctx = {}) {
  // Let the conversation breathe before the first grammar note.
  if (state.turns < 3) return null;
  if (state.turns - state.lastTeachTurn < 4) return null;

  const allowed = grammar.filter((g) => !(g.cond?.minAff > state.affection));

  // A point she just used beats everything. Explaining the sentence that is
  // still on screen is the entire value of the card; teaching an unrelated
  // pattern next to it is what made the two feel disconnected.
  const used = (ctx.usedHits || [])
    .map((h) => {
      const g = allowed.find((x) => x.id === h.id);
      return g && { ...g, line: h.line };
    })
    .filter(Boolean);

  // No card unless it explains a sentence that is still on the screen. Falling
  // back to a topical card is what made the grammar feel bolted on: measured,
  // only 1% of cards described anything she had actually said.
  if (!used.length) return null;

  const fresh = used.filter((g) => !state.learned.includes(g.id));
  const from = fresh.length ? fresh : used;
  // Prefer points the learner has used least. Repetition remains possible—and
  // desirable—but a mastered construction no longer crowds out a weak one.
  const score = (g) => {
    const s = state.grammarStats?.[g.id] || {};
    return (s.userUses || 0) * 5 + (s.exposures || 0);
  };
  const min = Math.min(...from.map(score));
  const weakest = from.filter((g) => score(g) === min);
  return { ...weakest[Math.floor(Math.random() * weakest.length)], used: true };
}
