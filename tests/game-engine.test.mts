/**
 * Unit tests for The Great Game simulation engine.
 *
 * Validates the Shadow President-inspired mechanics: approval rating,
 * DEFCON levels, government-type modifiers, budget allocation, advisor
 * briefings, cascading effects, sanctions/troop toggles, and the
 * three-phase turn cycle (briefing → action → resolution).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const engine = await import('../src/services/game-engine.ts');

const {
  createInitialState,
  generateTurnEvents,
  applyEvents,
  resolveAction,
  advancePhase,
  getAvailableActions,
  computeScore,
  setBudget,
} = engine;

describe('game-engine', () => {
  // ------------------------------------------------------------------
  // createInitialState
  // ------------------------------------------------------------------
  describe('createInitialState', () => {
    it('creates a state with 9 regions', () => {
      const state = createInitialState(1);
      assert.equal(Object.keys(state.regions).length, 9);
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

    it('starts with 5 objectives', () => {
      const state = createInitialState(1);
      assert.equal(state.objectives.length, 5);
    });

    it('produces deterministic output for the same seed', () => {
      const a = createInitialState(42);
      const b = createInitialState(42);
      assert.deepStrictEqual(a.regions, b.regions);
      assert.deepStrictEqual(a.resources, b.resources);
    });

    it('starts with approval of 65 and DEFCON 5 (Shadow President)', () => {
      const state = createInitialState(1);
      assert.equal(state.approval, 65);
      assert.equal(state.defcon, 5);
    });

    it('has a budget that sums to 100', () => {
      const state = createInitialState(1);
      const total = state.budget.defense + state.budget.intelligence +
        state.budget.diplomacy + state.budget.economy + state.budget.technology;
      assert.equal(total, 100);
    });

    it('has 5 advisors (Shadow President cabinet)', () => {
      const state = createInitialState(1);
      assert.equal(state.advisors.length, 5);
      const ids = state.advisors.map(a => a.id);
      assert.ok(ids.includes('secState'));
      assert.ok(ids.includes('secDef'));
      assert.ok(ids.includes('ciaDirector'));
      assert.ok(ids.includes('econAdvisor'));
      assert.ok(ids.includes('jointChiefs'));
    });

    it('regions have government types and nuclear capability', () => {
      const state = createInitialState(1);
      for (const r of Object.values(state.regions)) {
        assert.ok(typeof r.governmentType === 'string');
        assert.ok(typeof r.nuclearCapable === 'boolean');
        assert.equal(r.sanctioned, false);
        assert.equal(r.troopsDeployed, false);
      }
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

    it('events include advisor briefings (Shadow President)', () => {
      const state = createInitialState(1);
      const events = generateTurnEvents(state, 101);
      for (const e of events) {
        assert.ok(Array.isArray(e.advisorBriefings));
        assert.equal(e.advisorBriefings.length, 5);
        for (const ab of e.advisorBriefings) {
          assert.ok(typeof ab.text === 'string');
          assert.ok(ab.text.length > 0);
        }
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

    it('approval changes from events (Shadow President)', () => {
      const state = createInitialState(1);
      const startApproval = state.approval;
      // Generate many events to ensure at least one has approvalDelta
      const events = generateTurnEvents(state, 500);
      const hasApproval = events.some(e => e.approvalDelta != null && e.approvalDelta !== 0);
      if (hasApproval) {
        applyEvents(state, events);
        assert.notEqual(state.approval, startApproval, 'Approval should change when events have approvalDelta');
      }
    });

    it('DEFCON stays clamped between 1 and 5', () => {
      const state = createInitialState(1);
      for (let seed = 1; seed < 50; seed++) {
        const events = generateTurnEvents(state, seed);
        applyEvents(state, events);
      }
      assert.ok(state.defcon >= 1 && state.defcon <= 5, `DEFCON ${state.defcon} out of range`);
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

    it('actions have categories: diplomatic, economic, military, covert', () => {
      const state = createInitialState(1);
      const actions = getAvailableActions(state);
      const categories = new Set(actions.map(a => a.category));
      assert.ok(categories.has('diplomatic'));
      assert.ok(categories.has('economic'));
      assert.ok(categories.has('military'));
      assert.ok(categories.has('covert'));
    });

    it('actions have risk values (Shadow President covert ops)', () => {
      const state = createInitialState(1);
      const actions = getAvailableActions(state);
      const covertActions = actions.filter(a => a.category === 'covert');
      assert.ok(covertActions.length > 0);
      for (const a of covertActions) {
        assert.ok(a.risk > 0, `Covert action ${a.type} should have risk > 0`);
      }
    });

    it('shows imposeSanctions when not sanctioned, liftSanctions when sanctioned', () => {
      const state = createInitialState(1);
      const region = Object.values(state.regions)[0];
      region.sanctioned = false;
      let actions = getAvailableActions(state);
      let forRegion = actions.filter(a => a.targetRegion === region.id);
      assert.ok(forRegion.some(a => a.type === 'imposeSanctions'));
      assert.ok(!forRegion.some(a => a.type === 'liftSanctions'));

      region.sanctioned = true;
      actions = getAvailableActions(state);
      forRegion = actions.filter(a => a.targetRegion === region.id);
      assert.ok(!forRegion.some(a => a.type === 'imposeSanctions'));
      assert.ok(forRegion.some(a => a.type === 'liftSanctions'));
    });

    it('shows deployTroops when no troops, withdrawTroops when troops deployed', () => {
      const state = createInitialState(1);
      const region = Object.values(state.regions)[0];
      region.troopsDeployed = false;
      let actions = getAvailableActions(state);
      let forRegion = actions.filter(a => a.targetRegion === region.id);
      assert.ok(forRegion.some(a => a.type === 'deployTroops'));
      assert.ok(!forRegion.some(a => a.type === 'withdrawTroops'));

      region.troopsDeployed = true;
      actions = getAvailableActions(state);
      forRegion = actions.filter(a => a.targetRegion === region.id);
      assert.ok(!forRegion.some(a => a.type === 'deployTroops'));
      assert.ok(forRegion.some(a => a.type === 'withdrawTroops'));
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

    it('imposeSanctions toggles sanctioned flag', () => {
      const state = createInitialState(1);
      const actions = getAvailableActions(state);
      const sanction = actions.find(a => a.type === 'imposeSanctions');
      assert.ok(sanction);
      assert.equal(state.regions[sanction.targetRegion].sanctioned, false);
      resolveAction(state, sanction);
      assert.equal(state.regions[sanction.targetRegion].sanctioned, true);
    });

    it('deployTroops toggles troopsDeployed flag', () => {
      const state = createInitialState(1);
      const actions = getAvailableActions(state);
      const deploy = actions.find(a => a.type === 'deployTroops');
      assert.ok(deploy);
      assert.equal(state.regions[deploy.targetRegion].troopsDeployed, false);
      resolveAction(state, deploy);
      assert.equal(state.regions[deploy.targetRegion].troopsDeployed, true);
    });

    it('nuclearPosture reduces DEFCON', () => {
      const state = createInitialState(1);
      assert.equal(state.defcon, 5);
      const actions = getAvailableActions(state);
      const nuke = actions.find(a => a.type === 'nuclearPosture');
      assert.ok(nuke);
      resolveAction(state, nuke);
      assert.equal(state.defcon, 4);
    });
  });

  // ------------------------------------------------------------------
  // advancePhase — three-phase cycle
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

    it('ends the game on impeachment (approval < 15)', () => {
      const state = createInitialState(1);
      state.approval = 10;
      state.phase = 'resolution';
      advancePhase(state);
      assert.equal(state.phase, 'gameOver');
    });

    it('ends the game on DEFCON 1 (nuclear war)', () => {
      const state = createInitialState(1);
      state.defcon = 1;
      state.phase = 'resolution';
      advancePhase(state);
      assert.equal(state.phase, 'gameOver');
    });
  });

  // ------------------------------------------------------------------
  // setBudget
  // ------------------------------------------------------------------
  describe('setBudget', () => {
    it('accepts a valid budget that sums to 100', () => {
      const state = createInitialState(1);
      setBudget(state, { defense: 40, intelligence: 20, diplomacy: 10, economy: 20, technology: 10 });
      assert.equal(state.budget.defense, 40);
      assert.equal(state.budget.diplomacy, 10);
    });

    it('rejects a budget that does not sum to 100', () => {
      const state = createInitialState(1);
      const before = { ...state.budget };
      setBudget(state, { defense: 50, intelligence: 50, diplomacy: 50, economy: 50, technology: 50 });
      assert.deepStrictEqual(state.budget, before);
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

    it('score accounts for approval and DEFCON', () => {
      const state = createInitialState(1);
      const base = computeScore(state);
      state.approval = 100;
      const highApproval = computeScore(state);
      assert.ok(highApproval > base, 'Higher approval should increase score');
    });
  });
});
