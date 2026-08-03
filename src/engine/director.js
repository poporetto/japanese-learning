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
    // How many unanswered nudges she's already sent — lets a proactive line
    // escalate from 「ねえ」 to 「無視しないでよ」 without new selection code.
    if (c.minUnanswered != null && (state.unanswered || 0) < c.minUnanswered) return false;
    if (c.maxUnanswered != null && (state.unanswered || 0) > c.maxUnanswered) return false;
    // state._band is refreshed each turn by the engine; it's derived, not saved state.
    if (c.band && !c.band.includes(state._band)) return false;
    if (c.flag && !state.flags[c.flag]) return false;
    if (c.notFlag && state.flags[c.notFlag]) return false;
    // Never offer a line — or a quick-reply chip — whose {slots} we can't fill.
    const text = [...(v.b || []), ...(v.sug || [])].map((x) => x.jp).join('');
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

/**
 * She speaks into silence. Two shapes, and the mix is what stops the nudges
 * reading like a reminder app: sometimes a fragment of her own day
 * (`dialogue.proactive`), sometimes she just opens a whole new topic —
 * which reuses the deflect path so the follow-up thread works identically.
 */
export function proactivePlan(state, dialogue, band) {
  const openTopic = state.turns > 0 && !state.pendingTopic && Math.random() < 0.3;

  if (openTopic) {
    const topic = pick(dialogue.topics, state);
    if (topic) return { kind: 'deflect', variant: null, topic };
  }

  const v = pick((dialogue.proactive || []).filter((p) => !p.cond?.band || p.cond.band.includes(band)), state);
  if (v) return { kind: 'proactive', variant: v };

  // Nothing left unseen that fits — fall back to opening a topic rather than
  // going quiet, since going quiet is the one thing this feature exists to fix.
  const topic = pick(dialogue.topics, state);
  return topic ? { kind: 'deflect', variant: null, topic } : null;
}

// Snapshots of her surroundings are cheap and frequent; pictures of herself
// are the rarer, more loaded thing.
const COOLDOWN = { scene: 5, selfie: 12 };

/** Does this photo fit what's being talked about right now? */
function fitsContext(photo, ctx) {
  const w = photo.when;
  if (!w) return false; // ambient photos only ever fire on the random path
  if (w.intent?.includes(ctx.intentId)) return true;
  if (w.topic?.includes(ctx.topicId)) return true;
  if (w.band?.includes(ctx.band)) return true;
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
  if (relevant.length && Math.random() < 0.5) return pick(relevant, state);

  // Otherwise, occasionally, unprompted — she just felt like sharing.
  if (Math.random() < 0.15) return pick(eligible, state);
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

  const unseen = grammar.filter((g) => !state.learned.includes(g.id));
  const pool = unseen.length ? unseen : grammar;

  const relevant = pool.filter((g) => g.when?.intent?.includes(ctx.intentId));
  const from = relevant.length ? relevant : pool;
  return from[Math.floor(Math.random() * from.length)];
}
