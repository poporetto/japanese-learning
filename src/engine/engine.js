// Public surface. Everything the UI needs is behind respond() / openSession().
// Swapping in a local LLM later means replacing only the `deflect` branch.

import { detectScript, isQuestion } from './normalize.js';
import { matchIntent } from './match.js';
import { ingest, fillSlots, recall } from './memory.js';
import { direct, pick, photoPlan, teachPlan } from './director.js';
import { bumpAffection, timeBand, touchDay, stageOf } from './state.js';

// Intents where a lexicon word is part of the request, not a fact about him.
const SCAN_BLOCKING = ['ask_photo', 'meaning_question', 'teach_request'];

// Authored bubbles are templates and get reused forever. Slot-filling must
// never write back into the loaded JSON, so every turn works on copies.
const clone = (bubbles) => bubbles.map((b) => ({ ...b }));

export class Companion {
  constructor(content) {
    this.persona = content.persona;
    this.intents = content.intents;
    this.dialogue = content.dialogue;
    this.grammar = content.grammar;
    this.lexicon = content.lexicon;
    this.sprites = content.sprites;
  }

  /** First turn of a session: she speaks first, unprompted. */
  openSession(state) {
    const { gapDays } = touchDay(state);
    const plan = direct({
      state,
      dialogue: this.dialogue,
      intentId: null,
      sessionStart: true,
      gapDays,
      band: timeBand(),
    });
    return this._compose(plan, state, { newMemories: [], script: 'jp' });
  }

  /** Main entry: user said something. */
  respond(raw, state) {
    state.turns += 1;

    const script = detectScript(raw);
    // Match before ingesting: the intent tells us whether a lexicon word is
    // really a fact about him (「写真が趣味」) or part of a request (「写真見せて」).
    const match = matchIntent(raw, this.intents);
    const newMemories = ingest(state, raw, this.lexicon, {
      skipScan: match && SCAN_BLOCKING.includes(match.id),
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
      sessionStart: false,
      gapDays: 0,
      band: timeBand(),
      justLearned: newMemories.length > 0,
    });

    return this._compose(plan, state, {
      newMemories,
      script,
      question: isQuestion(raw),
      intentId: match?.id ?? null,
    });
  }

  _compose(plan, state, meta) {
    const bubbles = [];
    let sprite = 'neutral';
    let photo = null;
    let suggestions = [];

    // Acknowledge anything she just learned about him — before her own line.
    for (const mem of meta.newMemories.slice(0, 1)) {
      const ackSet = this.dialogue.acks[mem.slot] || this.dialogue.acks.default;
      const ack = pick(ackSet, state);
      if (ack) {
        bubbles.push(...clone(ack.b));
        sprite = ack.s || sprite;
        state.seen[ack.id] = (state.seen[ack.id] || 0) + 1;
      }
    }

    // He wrote in English — a nudge, not a scolding, and only occasionally.
    if (meta.script === 'en' && state.turns % 3 === 1) {
      const nudge = pick(this.dialogue.nudges, state);
      if (nudge) bubbles.push(...clone(nudge.b));
    }

    if (plan.kind === 'photo_request') {
      const p = photoPlan(state, this.dialogue, true);
      if (p) {
        bubbles.push(...clone(p.b));
        photo = { file: p.file, alt: p.alt };
        sprite = p.s || 'shy';
        state.lastPhotoTurn = state.turns;
        state.seen[p.id] = (state.seen[p.id] || 0) + 1;
        bumpAffection(state, p.aff ?? 1);
      } else {
        const deny = pick(this.dialogue.photoDeny, state);
        if (deny) {
          bubbles.push(...clone(deny.b));
          sprite = deny.s || 'shy';
        }
      }
    }

    const v = plan.variant;
    if (v) {
      bubbles.push(...clone(v.b));
      sprite = v.s || sprite;
      suggestions = v.sug || suggestions;
      bumpAffection(state, v.aff ?? 0);
      state.seen[v.id] = (state.seen[v.id] || 0) + 1;
      if (v.q) state.pendingSlot = v.q;
      if (v.setFlag) state.flags[v.setFlag] = true;
      if (plan.kind === 'callback') state.lastCallbackTurn = state.turns;
    }

    // Deflect turns chain into a fresh topic so the conversation never stalls.
    if (plan.kind === 'deflect' && plan.topic) {
      const open = pick([plan.topic.open], state) || plan.topic.open;
      bubbles.push(...clone(open.b));
      sprite = open.s || sprite;
      suggestions = open.sug || suggestions;
      if (open.q) state.pendingSlot = open.q;
      state.pendingTopic = plan.topic.id;
      // Count the topic too — that's the key repeat-avoidance picks topics on.
      state.seen[plan.topic.id] = (state.seen[plan.topic.id] || 0) + 1;
      state.seen[plan.topic.open.id] = (state.seen[plan.topic.open.id] || 0) + 1;
    } else if (plan.kind === 'topic_follow') {
      state.pendingTopic = null;
    } else if (plan.kind !== 'greet') {
      state.pendingTopic = null;
    }

    // Unsolicited photo, on her own initiative.
    if (!photo && plan.kind !== 'photo_request') {
      const p = photoPlan(state, this.dialogue, false);
      if (p) {
        bubbles.push(...clone(p.b));
        photo = { file: p.file, alt: p.alt };
        state.lastPhotoTurn = state.turns;
        state.seen[p.id] = (state.seen[p.id] || 0) + 1;
      }
    }

    // Teaching rides along as a side note, never as the main message.
    let teach = null;
    const g = teachPlan(state, this.grammar);
    if (g && bubbles.length) {
      teach = g;
      state.lastTeachTurn = state.turns;
      if (!state.learned.includes(g.id)) state.learned.push(g.id);
    }

    for (const b of bubbles) {
      b.jp = fillSlots(b.jp, state);
      if (b.en) b.en = fillSlots(b.en, state);
    }
    suggestions = suggestions.map((s) => ({
      jp: fillSlots(s.jp, state),
      en: s.en,
    }));

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
