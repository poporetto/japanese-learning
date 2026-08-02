// The director decides WHAT KIND of turn she takes before deciding the words.
// This is the difference between a lookup table and a character with pacing.

import { recall, callbackCandidates, slotsSatisfied } from './memory.js';
import { stageOf } from './state.js';

/** Filter authored variants by their conditions, then prefer unseen ones. */
export function pick(variants, state) {
  const usable = (variants || []).filter((v) => {
    const c = v.cond || {};
    if (c.minAff != null && state.affection < c.minAff) return false;
    if (c.maxAff != null && state.affection >= c.maxAff) return false;
    if (c.stage && stageOf(state).id !== c.stage) return false;
    if (c.needSlot && recall(state, c.needSlot) === null) return false;
    if (c.lacksSlot && recall(state, c.lacksSlot) !== null) return false;
    if (c.minTurns != null && state.turns < c.minTurns) return false;
    if (c.flag && !state.flags[c.flag]) return false;
    if (c.notFlag && state.flags[c.notFlag]) return false;
    // Never offer a line whose {slots} we can't fill.
    const text = (v.b || []).map((x) => x.jp).join('');
    if (!slotsSatisfied(text, state)) return false;
    return true;
  });

  if (!usable.length) return null;

  const min = Math.min(...usable.map((v) => state.seen[v.id] || 0));
  const freshest = usable.filter((v) => (state.seen[v.id] || 0) === min);
  return freshest[Math.floor(Math.random() * freshest.length)];
}

/**
 * Chooses the turn plan. Returns { kind, variant, extra }.
 * Order here IS the personality: she prioritizes her own thread over
 * mechanically answering, which is what stops it feeling like a FAQ bot.
 */
export function direct(ctx) {
  const { state, dialogue, intentId, sessionStart, gapDays, band } = ctx;

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

  // 2. Intents she must never ignore.
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
    const v = topic && pick(topic.follow, state);
    if (v) return { kind: 'topic_follow', variant: v, topic };
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
  const deflect = ctx.justLearned ? null : pick(dialogue.deflect, state);
  return { kind: 'deflect', variant: deflect, topic };
}

/** Should a photo ride along with this turn? */
export function photoPlan(state, dialogue, forced) {
  const since = state.turns - state.lastPhotoTurn;
  const eligible = (dialogue.photos || []).filter(
    (p) => state.affection >= p.minAffection
  );
  if (!eligible.length) return null;
  if (!forced && (since < 14 || Math.random() > 0.22)) return null;
  return pick(eligible, state) || (forced ? eligible[0] : null);
}

/** Should a grammar note be appended? Roughly every 4 turns, never twice in a row. */
export function teachPlan(state, grammar) {
  // Let the conversation breathe before the first grammar note.
  if (state.turns < 3) return null;
  if (state.turns - state.lastTeachTurn < 4) return null;
  const unseen = grammar.filter((g) => !state.learned.includes(g.id));
  const pool = unseen.length ? unseen : grammar;
  return pool[Math.floor(Math.random() * pool.length)];
}
