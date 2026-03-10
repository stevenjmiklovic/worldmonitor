/**
 * The Great Game – core simulation engine.
 *
 * Manages a turn-based geopolitical strategy simulation where the player acts
 * as an intelligence director guiding a global power.  Each turn proceeds
 * through three phases:
 *   1. **briefing** – world events are generated and presented
 *   2. **action**   – the player chooses a strategic action
 *   3. **resolution** – the action resolves and scores are updated
 *
 * The engine is intentionally decoupled from the DOM so it can be unit-tested
 * without a browser environment.
 */

import type {
  GameState,
  GameResources,
  GameRegionId,
  GameRegionState,
  GameEvent,
  GameAction,
  GamePhase,
  GameObjective,
} from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TURNS = 20;

const REGION_DEFS: Record<GameRegionId, { name: string; influence: number; stability: number; threatLevel: number }> = {
  northAmerica:     { name: 'North America',       influence: 80,  stability: 85, threatLevel: 10 },
  europe:           { name: 'Europe',               influence: 60,  stability: 75, threatLevel: 20 },
  eastAsia:         { name: 'East Asia',            influence: 20,  stability: 65, threatLevel: 40 },
  southAsia:        { name: 'South Asia',           influence: 10,  stability: 50, threatLevel: 45 },
  mena:             { name: 'Middle East & N. Africa', influence: -10, stability: 35, threatLevel: 65 },
  subSaharanAfrica: { name: 'Sub-Saharan Africa',   influence:   5, stability: 40, threatLevel: 50 },
  latam:            { name: 'Latin America',         influence:  30, stability: 55, threatLevel: 30 },
  centralAsia:      { name: 'Central Asia',          influence: -20, stability: 45, threatLevel: 55 },
  oceania:          { name: 'Oceania',               influence:  50, stability: 80, threatLevel: 15 },
};

const STARTING_RESOURCES: GameResources = {
  politicalCapital:    100,
  intelligenceAssets:   80,
  militaryReadiness:    70,
  economicInfluence:    90,
  technologyLevel:      60,
};

const OBJECTIVES: GameObjective[] = [
  { id: 'obj-stability',  description: 'Maintain average global stability above 50',   completed: false },
  { id: 'obj-influence',  description: 'Achieve positive influence in 7+ regions',     completed: false },
  { id: 'obj-resources',  description: 'End the game with 300+ total resource points', completed: false },
];

// ---------------------------------------------------------------------------
// Event templates
// ---------------------------------------------------------------------------

interface EventTemplate {
  headline: string;
  description: string;
  regions: GameRegionId[];
  impact: (region: GameRegionId) => GameEvent['impact'];
  resourceDelta?: Partial<GameResources>;
}

const EVENT_TEMPLATES: EventTemplate[] = [
  {
    headline: 'Cyber attack targets critical infrastructure',
    description: 'State-sponsored hackers breach power-grid SCADA systems, causing rolling blackouts.',
    regions: ['europe', 'eastAsia', 'northAmerica'],
    impact: r => ({ [r]: { stability: -8, threatLevel: 12 } }),
    resourceDelta: { intelligenceAssets: -5 },
  },
  {
    headline: 'Diplomatic summit yields trade agreement',
    description: 'A multilateral trade pact reduces tariffs and boosts economic growth forecasts.',
    regions: ['europe', 'eastAsia', 'latam', 'oceania'],
    impact: r => ({ [r]: { influence: 6, stability: 4 } }),
    resourceDelta: { economicInfluence: 5 },
  },
  {
    headline: 'Military tensions escalate along disputed border',
    description: 'Troop build-ups and live-fire exercises raise the spectre of open conflict.',
    regions: ['mena', 'southAsia', 'centralAsia', 'eastAsia'],
    impact: r => ({ [r]: { stability: -12, threatLevel: 15 } }),
    resourceDelta: { militaryReadiness: -8 },
  },
  {
    headline: 'Protest movement demands democratic reform',
    description: 'Large-scale demonstrations sweep capital cities, calling for transparency and elections.',
    regions: ['mena', 'subSaharanAfrica', 'latam', 'centralAsia'],
    impact: r => ({ [r]: { stability: -10, influence: -5 } }),
  },
  {
    headline: 'Breakthrough in renewable energy technology',
    description: 'A next-generation solar cell achieves 50 % efficiency, reshaping energy markets.',
    regions: ['northAmerica', 'europe', 'eastAsia'],
    impact: r => ({ [r]: { stability: 5, influence: 3 } }),
    resourceDelta: { technologyLevel: 8 },
  },
  {
    headline: 'Commodity supply shock rattles global markets',
    description: 'A major rare-earth mine closure triggers price spikes and supply-chain anxiety.',
    regions: ['subSaharanAfrica', 'centralAsia', 'eastAsia', 'southAsia'],
    impact: r => ({ [r]: { stability: -6, threatLevel: 8 } }),
    resourceDelta: { economicInfluence: -6 },
  },
  {
    headline: 'Intelligence leak exposes covert operations',
    description: 'Classified documents surface online, straining alliances and sparking investigations.',
    regions: ['northAmerica', 'europe', 'mena'],
    impact: r => ({ [r]: { influence: -10, stability: -4 } }),
    resourceDelta: { intelligenceAssets: -10, politicalCapital: -8 },
  },
  {
    headline: 'Humanitarian crisis triggers refugee surge',
    description: 'Flooding and famine displace millions, overwhelming border agencies.',
    regions: ['southAsia', 'subSaharanAfrica', 'mena'],
    impact: r => ({ [r]: { stability: -14, threatLevel: 10 } }),
    resourceDelta: { politicalCapital: -5 },
  },
  {
    headline: 'Space-based surveillance network expanded',
    description: 'New reconnaissance satellites improve early-warning capabilities.',
    regions: ['northAmerica', 'europe', 'eastAsia'],
    impact: r => ({ [r]: { stability: 3, threatLevel: -5 } }),
    resourceDelta: { technologyLevel: 6, intelligenceAssets: 4 },
  },
  {
    headline: 'Narcotics trafficking ring dismantled',
    description: 'Joint international operation seizes record quantities and arrests key figures.',
    regions: ['latam', 'centralAsia', 'subSaharanAfrica'],
    impact: r => ({ [r]: { stability: 6, threatLevel: -8 } }),
    resourceDelta: { intelligenceAssets: 3 },
  },
];

// ---------------------------------------------------------------------------
// Deterministic seeded RNG (xorshift32)
// ---------------------------------------------------------------------------

function xorshift32(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xFFFFFFFF;
  };
}

// ---------------------------------------------------------------------------
// Action catalogue
// ---------------------------------------------------------------------------

export function getAvailableActions(state: GameState): GameAction[] {
  const regions = Object.keys(state.regions) as GameRegionId[];
  const actions: GameAction[] = [];

  for (const region of regions) {
    actions.push(
      {
        type: 'deployAgent',
        label: `Deploy Agent → ${state.regions[region].name}`,
        description: 'Insert a field operative to gather intelligence and build local contacts.',
        targetRegion: region,
        cost: { intelligenceAssets: 10, politicalCapital: 5 },
      },
      {
        type: 'economicAid',
        label: `Economic Aid → ${state.regions[region].name}`,
        description: 'Send financial aid to improve stability and earn diplomatic goodwill.',
        targetRegion: region,
        cost: { economicInfluence: 15 },
      },
      {
        type: 'diplomaticSummit',
        label: `Diplomatic Summit → ${state.regions[region].name}`,
        description: 'Convene a diplomatic summit to strengthen ties.',
        targetRegion: region,
        cost: { politicalCapital: 12 },
      },
      {
        type: 'militaryExercise',
        label: `Military Exercise → ${state.regions[region].name}`,
        description: 'Conduct joint military exercises to project strength and deter threats.',
        targetRegion: region,
        cost: { militaryReadiness: 12, politicalCapital: 5 },
      },
      {
        type: 'cyberOperation',
        label: `Cyber Operation → ${state.regions[region].name}`,
        description: 'Launch a covert cyber campaign to disrupt adversary networks.',
        targetRegion: region,
        cost: { technologyLevel: 10, intelligenceAssets: 8 },
      },
      {
        type: 'covertInfluence',
        label: `Covert Influence → ${state.regions[region].name}`,
        description: 'Run a covert influence campaign through media and civil society channels.',
        targetRegion: region,
        cost: { intelligenceAssets: 12, politicalCapital: 8 },
      },
    );
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

export function createInitialState(seed?: number): GameState {
  const rand = xorshift32(seed ?? Date.now());
  // small jitter per region
  const regions = {} as Record<GameRegionId, GameRegionState>;
  for (const [id, def] of Object.entries(REGION_DEFS) as [GameRegionId, typeof REGION_DEFS[GameRegionId]][]) {
    regions[id] = {
      id,
      name: def.name,
      influence:   clamp(def.influence   + Math.round((rand() - 0.5) * 10), -100, 100),
      stability:   clamp(def.stability   + Math.round((rand() - 0.5) * 10), 0, 100),
      threatLevel: clamp(def.threatLevel + Math.round((rand() - 0.5) * 10), 0, 100),
    };
  }

  return {
    turn: 1,
    maxTurns: MAX_TURNS,
    phase: 'briefing',
    resources: { ...STARTING_RESOURCES },
    regions,
    log: [],
    objectives: OBJECTIVES.map(o => ({ ...o })),
    score: 0,
  };
}

/**
 * Generate 1-3 world events for the current turn.
 * Events are chosen from templates with light randomisation.
 */
export function generateTurnEvents(state: GameState, seed?: number): GameEvent[] {
  const rand = xorshift32(seed ?? state.turn * 9973 + 42);
  const count = 1 + Math.floor(rand() * 3); // 1-3 events
  const events: GameEvent[] = [];

  for (let i = 0; i < count; i++) {
    const tmpl = EVENT_TEMPLATES[Math.floor(rand() * EVENT_TEMPLATES.length)];
    const region = tmpl.regions[Math.floor(rand() * tmpl.regions.length)];
    events.push({
      id: `evt-${state.turn}-${i}`,
      turn: state.turn,
      headline: tmpl.headline,
      description: tmpl.description,
      region,
      impact: tmpl.impact(region),
      resourceDelta: tmpl.resourceDelta,
    });
  }
  return events;
}

/**
 * Apply world events to the state, mutating regions and resources.
 * Returns the updated state (same reference) for convenience.
 */
export function applyEvents(state: GameState, events: GameEvent[]): GameState {
  for (const evt of events) {
    state.log.push(evt);

    // region impacts
    if (evt.impact) {
      for (const [rId, delta] of Object.entries(evt.impact) as [GameRegionId, Partial<GameRegionState>][]) {
        const r = state.regions[rId];
        if (!r) continue;
        if (delta.influence   != null) r.influence   = clamp(r.influence   + delta.influence,   -100, 100);
        if (delta.stability   != null) r.stability   = clamp(r.stability   + delta.stability,   0, 100);
        if (delta.threatLevel != null) r.threatLevel = clamp(r.threatLevel + delta.threatLevel, 0, 100);
      }
    }

    // resource impacts
    if (evt.resourceDelta) {
      applyResourceDelta(state.resources, evt.resourceDelta);
    }
  }
  return state;
}

/**
 * Resolve a player action.  Deducts costs, adjusts the target region, and
 * generates a resolution event recorded in the log.
 */
export function resolveAction(state: GameState, action: GameAction): GameEvent {
  // deduct costs
  for (const [k, v] of Object.entries(action.cost) as [keyof GameResources, number][]) {
    state.resources[k] = Math.max(0, state.resources[k] - v);
  }

  // resolve effects on the target region
  const region = state.regions[action.targetRegion];
  const effects = actionEffects(action, region);

  region.influence   = clamp(region.influence   + effects.influence,   -100, 100);
  region.stability   = clamp(region.stability   + effects.stability,   0, 100);
  region.threatLevel = clamp(region.threatLevel + effects.threatLevel, 0, 100);

  const evt: GameEvent = {
    id: `act-${state.turn}`,
    turn: state.turn,
    headline: `Action: ${action.label}`,
    description: action.description,
    region: action.targetRegion,
    impact: { [action.targetRegion]: { influence: effects.influence, stability: effects.stability, threatLevel: effects.threatLevel } },
  };
  state.log.push(evt);
  return evt;
}

/**
 * Advance the game phase.  Returns the new phase.
 *
 * Typical cycle:  briefing → action → resolution → (next turn) briefing
 */
export function advancePhase(state: GameState): GamePhase {
  if (state.phase === 'briefing') {
    state.phase = 'action';
  } else if (state.phase === 'action') {
    state.phase = 'resolution';
  } else if (state.phase === 'resolution') {
    regenerateResources(state.resources);
    updateObjectives(state);
    state.score = computeScore(state);

    if (state.turn >= state.maxTurns) {
      state.phase = 'gameOver';
    } else {
      state.turn += 1;
      state.phase = 'briefing';
    }
  }
  return state.phase;
}

// ---------------------------------------------------------------------------
// Scoring & objectives
// ---------------------------------------------------------------------------

export function computeScore(state: GameState): number {
  const regions = Object.values(state.regions);
  const avgStability = regions.reduce((s, r) => s + r.stability, 0) / regions.length;
  const avgInfluence = regions.reduce((s, r) => s + r.influence, 0) / regions.length;
  const resourceTotal = Object.values(state.resources).reduce((a, b) => a + b, 0);
  const objectiveBonus = state.objectives.filter(o => o.completed).length * 50;

  return Math.round(avgStability + avgInfluence + resourceTotal / 5 + objectiveBonus);
}

function updateObjectives(state: GameState): void {
  const regions = Object.values(state.regions);
  const avgStability = regions.reduce((s, r) => s + r.stability, 0) / regions.length;
  const positiveCount = regions.filter(r => r.influence > 0).length;
  const totalResources = Object.values(state.resources).reduce((a, b) => a + b, 0);

  for (const obj of state.objectives) {
    if (obj.id === 'obj-stability')  obj.completed = avgStability > 50;
    if (obj.id === 'obj-influence')  obj.completed = positiveCount >= 7;
    if (obj.id === 'obj-resources')  obj.completed = totalResources >= 300;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function applyResourceDelta(resources: GameResources, delta: Partial<GameResources>): void {
  for (const [k, v] of Object.entries(delta) as [keyof GameResources, number][]) {
    resources[k] = Math.max(0, resources[k] + v);
  }
}

function actionEffects(action: GameAction, _region: GameRegionState): { influence: number; stability: number; threatLevel: number } {
  switch (action.type) {
    case 'deployAgent':       return { influence:  5, stability:  2, threatLevel: -3 };
    case 'economicAid':       return { influence: 10, stability:  8, threatLevel: -2 };
    case 'diplomaticSummit':  return { influence: 12, stability:  5, threatLevel: -4 };
    case 'militaryExercise':  return { influence:  3, stability: -2, threatLevel: -10 };
    case 'cyberOperation':    return { influence: -2, stability: -3, threatLevel: -8 };
    case 'covertInfluence':   return { influence:  8, stability:  0, threatLevel: -2 };
    case 'formAlliance':      return { influence: 15, stability:  5, threatLevel: -6 };
    case 'imposeSanctions':   return { influence: -5, stability: -8, threatLevel: -4 };
    case 'fundCoup':          return { influence: 20, stability: -20, threatLevel: 10 };
    case 'tradeAgreement':    return { influence:  8, stability:  6, threatLevel: -3 };
    default:                  return { influence:  0, stability:  0, threatLevel:  0 };
  }
}

/** Small per-turn resource regeneration to keep the game flowing. */
function regenerateResources(resources: GameResources): void {
  resources.politicalCapital    = Math.min(200, resources.politicalCapital    + 8);
  resources.intelligenceAssets  = Math.min(200, resources.intelligenceAssets  + 5);
  resources.militaryReadiness   = Math.min(200, resources.militaryReadiness   + 4);
  resources.economicInfluence   = Math.min(200, resources.economicInfluence   + 6);
  resources.technologyLevel     = Math.min(200, resources.technologyLevel     + 3);
}
