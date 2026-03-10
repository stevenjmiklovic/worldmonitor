/**
 * Unit tests for The Great Game simulation engine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import of the game engine (it uses @/ path alias so we import the
// source directly via relative path from the tests/ directory).
const engine = await import('../src/services/game-engine.ts');

const {
  createInitialState,
  generateTurnEvents,
  applyEvents,
  resolveAction,
  advancePhase,
  getAvailableActions,
  computeScore,
} = engine;

describe('game-engine', () => {
  // ------------------------------------------------------------------
  // createInitialState
  // ------------------------------------------------------------------
  describe('createInitialState', () => {
    it('creates a state with 9 regions', () => {
      const state = createInitialState(1);
      const regionIds = Object.keys(state.regions);
      assert.equal(regionIds.length, 9);
    });

    it('starts on turn 1 in briefing phase', () => {
      const state = createInitialState(1);
      assert.equal(state.turn, 1);
      assert.equal(state.phase, 'briefing');
    });

    it('has non-negative starting resources', () => {
      const state = createInitialState(1);
      for (const val of Object.values(state.resources)) {
        assert.ok(val >= 0, `Resource value ${val} should be >= 0`);
      }
    });

    it('starts with 3 objectives, all incomplete', () => {
      const state = createInitialState(1);
      assert.equal(state.objectives.length, 3);
      assert.ok(state.objectives.every(o => !o.completed));
    });

    it('produces deterministic output for the same seed', () => {
      const a = createInitialState(42);
      const b = createInitialState(42);
      assert.deepStrictEqual(a.regions, b.regions);
      assert.deepStrictEqual(a.resources, b.resources);
    });
  });

  // ------------------------------------------------------------------
  // generateTurnEvents
  // ------------------------------------------------------------------
  describe('generateTurnEvents', () => {
    it('generates 1-3 events', () => {
      const state = createInitialState(1);
      const events = generateTurnEvents(state, 99);
      assert.ok(events.length >= 1 && events.length <= 3, `Expected 1-3 events, got ${events.length}`);
    });

    it('each event has required fields', () => {
      const state = createInitialState(1);
      const events = generateTurnEvents(state, 100);
      for (const e of events) {
        assert.ok(e.id);
        assert.ok(e.headline);
        assert.ok(e.description);
        assert.ok(e.region);
        assert.equal(e.turn, state.turn);
      }
    });
  });

  // ------------------------------------------------------------------
  // applyEvents
  // ------------------------------------------------------------------
  describe('applyEvents', () => {
    it('adds events to the log', () => {
      const state = createInitialState(1);
      const events = generateTurnEvents(state, 200);
      const before = state.log.length;
      applyEvents(state, events);
      assert.equal(state.log.length, before + events.length);
    });

    it('stability stays clamped to 0-100', () => {
      const state = createInitialState(1);
      const events = generateTurnEvents(state, 300);
      applyEvents(state, events);
      for (const r of Object.values(state.regions)) {
        assert.ok(r.stability >= 0 && r.stability <= 100, `Stability ${r.stability} out of range`);
      }
    });
  });

  // ------------------------------------------------------------------
  // getAvailableActions
  // ------------------------------------------------------------------
  describe('getAvailableActions', () => {
    it('returns actions for every region', () => {
      const state = createInitialState(1);
      const actions = getAvailableActions(state);
      const regionIds = Object.keys(state.regions);
      for (const rId of regionIds) {
        const has = actions.some(a => a.targetRegion === rId);
        assert.ok(has, `No action for region ${rId}`);
      }
    });

    it('every action has a cost', () => {
      const state = createInitialState(1);
      const actions = getAvailableActions(state);
      for (const a of actions) {
        assert.ok(Object.keys(a.cost).length > 0, `Action ${a.type} has no cost`);
      }
    });
  });

  // ------------------------------------------------------------------
  // resolveAction
  // ------------------------------------------------------------------
  describe('resolveAction', () => {
    it('deducts action cost from resources', () => {
      const state = createInitialState(1);
      const actions = getAvailableActions(state);
      const aidAction = actions.find(a => a.type === 'economicAid');
      assert.ok(aidAction);

      const before = state.resources.economicInfluence;
      resolveAction(state, aidAction);
      assert.ok(state.resources.economicInfluence < before);
    });

    it('creates a log entry', () => {
      const state = createInitialState(1);
      const actions = getAvailableActions(state);
      resolveAction(state, actions[0]);
      const last = state.log[state.log.length - 1];
      assert.ok(last.id.startsWith('act-'));
    });
  });

  // ------------------------------------------------------------------
  // advancePhase
  // ------------------------------------------------------------------
  describe('advancePhase', () => {
    it('cycles briefing → action → resolution → briefing', () => {
      const state = createInitialState(1);
      assert.equal(state.phase, 'briefing');

      advancePhase(state);
      assert.equal(state.phase, 'action');

      advancePhase(state);
      assert.equal(state.phase, 'resolution');

      advancePhase(state);
      assert.equal(state.phase, 'briefing');
      assert.equal(state.turn, 2);
    });

    it('ends the game after maxTurns', () => {
      const state = createInitialState(1);
      state.turn = state.maxTurns;
      state.phase = 'resolution';
      advancePhase(state);
      assert.equal(state.phase, 'gameOver');
    });
  });

  // ------------------------------------------------------------------
  // computeScore
  // ------------------------------------------------------------------
  describe('computeScore', () => {
    it('returns a number', () => {
      const state = createInitialState(1);
      const score = computeScore(state);
      assert.equal(typeof score, 'number');
    });

    it('score increases when an objective is completed', () => {
      const state = createInitialState(1);
      const baseLine = computeScore(state);
      state.objectives[0].completed = true;
      const boosted = computeScore(state);
      assert.ok(boosted > baseLine, 'Score should increase with completed objectives');
    });
  });
});
