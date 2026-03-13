/**
 * The Great Game – core simulation engine.
 *
 * A turn-based geopolitical strategy simulation inspired by the 1993 DOS
 * classic *Shadow President*.  The player leads a global power through 20+
 * turns of crises, diplomacy, covert operations, and brinkmanship.
 *
 * Key Shadow President homages:
 *   • **Advisor cabinet** – five advisors offer conflicting briefings each turn.
 *   • **Approval rating** – domestic support rises/falls with player actions;
 *     drop below 15 and you are impeached (game over).
 *   • **DEFCON system** – nuclear readiness escalates from 5 (peace) to 1
 *     (launch); reaching DEFCON 1 triggers nuclear war (game over).
 *   • **Government types** per region that colour action outcomes.
 *   • **Budget allocation** – the player divides spending across five
 *     departments each turn, driving resource regeneration.
 *   • **Covert ops risk** – clandestine actions may be exposed, tanking
 *     approval and regional influence.
 *   • **Cascading effects** – events in one region spill over to neighbours.
 *   • **Sanctions / troop deployment** as persistent toggles per region.
 *
 * The engine is intentionally decoupled from the DOM so it can be unit-tested
 * without a browser environment.
 */

import type {
  GameState,
  GameResources,
  GameBudget,
  GameRegionId,
  GameRegionState,
  GameEvent,
  GameAction,
  GameActionCategory,
  GamePhase,
  GameObjective,
  GameAdvisor,
  GameAdvisorId,
  AdvisorBriefing,
  GovernmentType,
  DefconLevel,
} from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TURNS = 20;

const REGION_DEFS: Record<GameRegionId, {
  name: string;
  influence: number;
  stability: number;
  threatLevel: number;
  governmentType: GovernmentType;
  nuclearCapable: boolean;
}> = {
  northAmerica:     { name: 'North America',          influence: 80,  stability: 85, threatLevel: 10, governmentType: 'democracy',     nuclearCapable: true },
  europe:           { name: 'Europe',                  influence: 60,  stability: 75, threatLevel: 20, governmentType: 'democracy',     nuclearCapable: true },
  eastAsia:         { name: 'East Asia',               influence: 20,  stability: 65, threatLevel: 40, governmentType: 'communist',     nuclearCapable: true },
  southAsia:        { name: 'South Asia',              influence: 10,  stability: 50, threatLevel: 45, governmentType: 'democracy',     nuclearCapable: true },
  mena:             { name: 'Middle East & N. Africa', influence: -10, stability: 35, threatLevel: 65, governmentType: 'theocracy',     nuclearCapable: false },
  subSaharanAfrica: { name: 'Sub-Saharan Africa',      influence:   5, stability: 40, threatLevel: 50, governmentType: 'autocracy',     nuclearCapable: false },
  latam:            { name: 'Latin America',            influence:  30, stability: 55, threatLevel: 30, governmentType: 'democracy',     nuclearCapable: false },
  centralAsia:      { name: 'Central Asia',             influence: -20, stability: 45, threatLevel: 55, governmentType: 'autocracy',     nuclearCapable: true },
  oceania:          { name: 'Oceania',                  influence:  50, stability: 80, threatLevel: 15, governmentType: 'democracy',     nuclearCapable: false },
};

const STARTING_RESOURCES: GameResources = {
  politicalCapital:    100,
  intelligenceAssets:   80,
  militaryReadiness:    70,
  economicInfluence:    90,
  technologyLevel:      60,
};

const DEFAULT_BUDGET: GameBudget = {
  defense:       20,
  intelligence:  20,
  diplomacy:     20,
  economy:       20,
  technology:    20,
};

const ADVISORS: GameAdvisor[] = [
  { id: 'secState',     name: 'Sarah Whitfield',   title: 'Secretary of State',    perspective: 'Favours diplomacy and multilateral engagement.' },
  { id: 'secDef',       name: 'Gen. Marcus Kane',  title: 'Secretary of Defense',  perspective: 'Believes in peace through strength and deterrence.' },
  { id: 'ciaDirector',  name: 'Dr. Elena Voss',    title: 'CIA Director',          perspective: 'Prefers covert action over overt confrontation.' },
  { id: 'econAdvisor',  name: 'James Nakamura',    title: 'Economic Advisor',      perspective: 'Focuses on economic leverage and trade partnerships.' },
  { id: 'jointChiefs',  name: 'Adm. Diane Chen',   title: 'Chair, Joint Chiefs',   perspective: 'Pragmatic strategist; weighs all options by risk.' },
];

const OBJECTIVES: GameObjective[] = [
  { id: 'obj-stability',  description: 'Maintain average global stability above 50',   completed: false },
  { id: 'obj-influence',  description: 'Achieve positive influence in 7+ regions',     completed: false },
  { id: 'obj-approval',   description: 'Keep domestic approval above 50 for 10+ turns', completed: false },
  { id: 'obj-defcon',     description: 'Never let DEFCON drop below 3',                completed: false },
  { id: 'obj-resources',  description: 'End the game with 300+ total resource points', completed: false },
];

// Adjacency for cascade spill-over (Shadow President-style)
const REGION_NEIGHBOURS: Record<GameRegionId, GameRegionId[]> = {
  northAmerica:     ['europe', 'latam', 'oceania'],
  europe:           ['northAmerica', 'mena', 'centralAsia', 'subSaharanAfrica'],
  eastAsia:         ['southAsia', 'centralAsia', 'oceania'],
  southAsia:        ['eastAsia', 'mena', 'centralAsia'],
  mena:             ['europe', 'southAsia', 'subSaharanAfrica', 'centralAsia'],
  subSaharanAfrica: ['europe', 'mena', 'latam'],
  latam:            ['northAmerica', 'subSaharanAfrica'],
  centralAsia:      ['europe', 'eastAsia', 'southAsia', 'mena'],
  oceania:          ['northAmerica', 'eastAsia'],
};

// ---------------------------------------------------------------------------
// Event templates (expanded for Shadow President flavour)
// ---------------------------------------------------------------------------

interface EventTemplate {
  headline: string;
  description: string;
  regions: GameRegionId[];
  impact: (region: GameRegionId) => GameEvent['impact'];
  resourceDelta?: Partial<GameResources>;
  approvalDelta?: number;
  defconDelta?: number;
  /** If true, the event cascades instability to neighbouring regions. */
  cascade?: boolean;
}

const EVENT_TEMPLATES: EventTemplate[] = [
  // -- Crisis events (Shadow President staples) --
  {
    headline: 'Cyber attack targets critical infrastructure',
    description: 'State-sponsored hackers breach power-grid SCADA systems, causing rolling blackouts.',
    regions: ['europe', 'eastAsia', 'northAmerica'],
    impact: r => ({ [r]: { stability: -8, threatLevel: 12 } }),
    resourceDelta: { intelligenceAssets: -5 },
    approvalDelta: -3,
    defconDelta: -1,
  },
  {
    headline: 'Military tensions escalate along disputed border',
    description: 'Troop build-ups and live-fire exercises raise the spectre of open conflict.',
    regions: ['mena', 'southAsia', 'centralAsia', 'eastAsia'],
    impact: r => ({ [r]: { stability: -12, threatLevel: 15 } }),
    resourceDelta: { militaryReadiness: -8 },
    approvalDelta: -4,
    defconDelta: -1,
    cascade: true,
  },
  {
    headline: 'Nuclear test detected by seismic monitors',
    description: 'An underground detonation is confirmed; the Security Council convenes an emergency session.',
    regions: ['eastAsia', 'centralAsia', 'mena'],
    impact: r => ({ [r]: { stability: -15, threatLevel: 20 } }),
    resourceDelta: { politicalCapital: -10 },
    approvalDelta: -6,
    defconDelta: -1,
    cascade: true,
  },
  {
    headline: 'Coup attempt in the capital',
    description: 'Military officers seize the state broadcaster; loyalist forces mobilise.',
    regions: ['mena', 'subSaharanAfrica', 'latam', 'centralAsia'],
    impact: r => ({ [r]: { stability: -20, influence: -10, threatLevel: 12 } }),
    approvalDelta: -3,
    cascade: true,
  },
  {
    headline: 'Terrorist attack on civilian target',
    description: 'A coordinated bombing kills dozens and injures hundreds in a major city.',
    regions: ['europe', 'southAsia', 'mena', 'northAmerica'],
    impact: r => ({ [r]: { stability: -14, threatLevel: 16 } }),
    resourceDelta: { intelligenceAssets: -4 },
    approvalDelta: -5,
    defconDelta: -1,
  },
  {
    headline: 'Intelligence leak exposes covert operations',
    description: 'Classified documents surface online, straining alliances and sparking investigations.',
    regions: ['northAmerica', 'europe', 'mena'],
    impact: r => ({ [r]: { influence: -10, stability: -4 } }),
    resourceDelta: { intelligenceAssets: -10, politicalCapital: -8 },
    approvalDelta: -8,
  },
  {
    headline: 'Humanitarian crisis triggers refugee surge',
    description: 'Flooding and famine displace millions, overwhelming border agencies.',
    regions: ['southAsia', 'subSaharanAfrica', 'mena'],
    impact: r => ({ [r]: { stability: -14, threatLevel: 10 } }),
    resourceDelta: { politicalCapital: -5 },
    approvalDelta: -4,
    cascade: true,
  },
  // -- Positive events --
  {
    headline: 'Diplomatic summit yields trade agreement',
    description: 'A multilateral trade pact reduces tariffs and boosts economic growth forecasts.',
    regions: ['europe', 'eastAsia', 'latam', 'oceania'],
    impact: r => ({ [r]: { influence: 6, stability: 4 } }),
    resourceDelta: { economicInfluence: 5 },
    approvalDelta: 3,
  },
  {
    headline: 'Breakthrough in renewable energy technology',
    description: 'A next-generation solar cell achieves 50% efficiency, reshaping energy markets.',
    regions: ['northAmerica', 'europe', 'eastAsia'],
    impact: r => ({ [r]: { stability: 5, influence: 3 } }),
    resourceDelta: { technologyLevel: 8 },
    approvalDelta: 2,
  },
  {
    headline: 'Space-based surveillance network expanded',
    description: 'New reconnaissance satellites improve early-warning capabilities.',
    regions: ['northAmerica', 'europe', 'eastAsia'],
    impact: r => ({ [r]: { stability: 3, threatLevel: -5 } }),
    resourceDelta: { technologyLevel: 6, intelligenceAssets: 4 },
    approvalDelta: 2,
    defconDelta: 1,
  },
  {
    headline: 'Narcotics trafficking ring dismantled',
    description: 'Joint international operation seizes record quantities and arrests key figures.',
    regions: ['latam', 'centralAsia', 'subSaharanAfrica'],
    impact: r => ({ [r]: { stability: 6, threatLevel: -8 } }),
    resourceDelta: { intelligenceAssets: 3 },
    approvalDelta: 3,
  },
  {
    headline: 'Commodity supply shock rattles global markets',
    description: 'A major rare-earth mine closure triggers price spikes and supply-chain anxiety.',
    regions: ['subSaharanAfrica', 'centralAsia', 'eastAsia', 'southAsia'],
    impact: r => ({ [r]: { stability: -6, threatLevel: 8 } }),
    resourceDelta: { economicInfluence: -6 },
    approvalDelta: -3,
  },
  {
    headline: 'Protest movement demands democratic reform',
    description: 'Large-scale demonstrations sweep capital cities, calling for transparency and elections.',
    regions: ['mena', 'subSaharanAfrica', 'latam', 'centralAsia'],
    impact: r => ({ [r]: { stability: -10, influence: -5 } }),
    approvalDelta: -2,
    cascade: true,
  },
  {
    headline: 'UN peacekeeping mission deployed',
    description: 'Blue helmets arrive to enforce a ceasefire between warring factions.',
    regions: ['subSaharanAfrica', 'mena', 'southAsia'],
    impact: r => ({ [r]: { stability: 8, threatLevel: -6, influence: 4 } }),
    resourceDelta: { politicalCapital: -6 },
    approvalDelta: 2,
    defconDelta: 1,
  },
  {
    headline: 'Pandemic outbreak strains health systems',
    description: 'A novel pathogen spreads rapidly; hospitals declare capacity emergencies.',
    regions: ['southAsia', 'subSaharanAfrica', 'latam', 'eastAsia'],
    impact: r => ({ [r]: { stability: -10, threatLevel: 5 } }),
    resourceDelta: { economicInfluence: -8 },
    approvalDelta: -5,
    cascade: true,
  },
  {
    headline: 'Major arms deal finalised',
    description: 'A multi-billion dollar weapons package reshapes the regional balance of power.',
    regions: ['mena', 'eastAsia', 'southAsia'],
    impact: r => ({ [r]: { threatLevel: 10, stability: -4, influence: 5 } }),
    resourceDelta: { militaryReadiness: 5, economicInfluence: 4 },
    approvalDelta: -2,
    defconDelta: -1,
  },
  // -- Additional event variety --
  {
    headline: 'Election result disputed; rival factions clash in streets',
    description: 'Contested ballot counts trigger urban violence and a wave of international observer criticism.',
    regions: ['latam', 'subSaharanAfrica', 'southAsia', 'mena'],
    impact: r => ({ [r]: { stability: -12, influence: -4, threatLevel: 8 } }),
    approvalDelta: -3,
    cascade: true,
  },
  {
    headline: 'Currency collapses amid hyperinflation spiral',
    description: 'Emergency capital controls imposed as the national currency loses 40% of its value overnight.',
    regions: ['latam', 'subSaharanAfrica', 'centralAsia'],
    impact: r => ({ [r]: { stability: -10, threatLevel: 8 } }),
    resourceDelta: { economicInfluence: -10 },
    approvalDelta: -5,
    cascade: true,
  },
  {
    headline: 'Severe drought triggers regional food security emergency',
    description: 'Failed harvests reduce grain reserves to critical levels; the UN issues an emergency food appeal.',
    regions: ['subSaharanAfrica', 'mena', 'southAsia', 'centralAsia'],
    impact: r => ({ [r]: { stability: -10, threatLevel: 8, influence: -3 } }),
    resourceDelta: { economicInfluence: -6 },
    approvalDelta: -4,
    cascade: true,
  },
  {
    headline: 'Critical energy pipeline destroyed in sabotage attack',
    description: 'A major energy artery is severed, triggering supply shortages and diplomatic finger-pointing.',
    regions: ['europe', 'centralAsia', 'mena'],
    impact: r => ({ [r]: { stability: -8, threatLevel: 14 } }),
    resourceDelta: { politicalCapital: -6, economicInfluence: -8 },
    approvalDelta: -4,
    defconDelta: -1,
  },
  {
    headline: 'Historic peace agreement ends decade-long conflict',
    description: 'Rival factions sign a comprehensive settlement brokered by international mediators.',
    regions: ['mena', 'subSaharanAfrica', 'southAsia', 'centralAsia'],
    impact: r => ({ [r]: { stability: 15, influence: 8, threatLevel: -12 } }),
    resourceDelta: { politicalCapital: 5 },
    approvalDelta: 5,
    defconDelta: 1,
  },
  {
    headline: 'Head of state assassinated; emergency rule declared',
    description: 'A high-profile killing plunges the country into political crisis; security forces mobilise nationwide.',
    regions: ['mena', 'centralAsia', 'subSaharanAfrica', 'latam'],
    impact: r => ({ [r]: { stability: -20, threatLevel: 18, influence: -6 } }),
    approvalDelta: -6,
    defconDelta: -1,
    cascade: true,
  },
  {
    headline: 'Trade war erupts with sweeping retaliatory tariffs',
    description: 'Tit-for-tat measures cascade as major blocs impose unprecedented trade barriers across dozens of sectors.',
    regions: ['northAmerica', 'europe', 'eastAsia'],
    impact: r => ({ [r]: { stability: -6, influence: -5 } }),
    resourceDelta: { economicInfluence: -12 },
    approvalDelta: -4,
    cascade: true,
  },
  {
    headline: 'Pro-democracy protests turn violent after security crackdown',
    description: 'Footage of clashes between demonstrators and riot police spreads globally, prompting calls for intervention.',
    regions: ['mena', 'centralAsia', 'eastAsia', 'latam'],
    impact: r => ({ [r]: { stability: -14, influence: -5, threatLevel: 10 } }),
    approvalDelta: -3,
    cascade: true,
  },
  {
    headline: 'Separatist movement seizes regional capital, declares autonomous zone',
    description: 'A breakaway faction takes control of government buildings and stands up a provisional administration.',
    regions: ['europe', 'mena', 'centralAsia', 'southAsia'],
    impact: r => ({ [r]: { stability: -16, threatLevel: 15, influence: -6 } }),
    approvalDelta: -4,
    defconDelta: -1,
    cascade: true,
  },
  {
    headline: 'G20 summit collapses without communiqué',
    description: 'Major powers fail to reach agreement on core issues, signalling deepening geopolitical fractures.',
    regions: ['northAmerica', 'europe', 'eastAsia'],
    impact: r => ({ [r]: { influence: -6, stability: -3 } }),
    resourceDelta: { politicalCapital: -8 },
    approvalDelta: -3,
  },
  {
    headline: 'State-sponsored disinformation network exposed and dismantled',
    description: 'Intelligence agencies reveal a coordinated foreign operation that targeted elections and public trust for years.',
    regions: ['europe', 'northAmerica', 'latam', 'southAsia'],
    impact: r => ({ [r]: { stability: -5, influence: -8 } }),
    resourceDelta: { intelligenceAssets: -4, politicalCapital: -5 },
    approvalDelta: -4,
  },
  {
    headline: 'Transboundary dam dispute pushes neighbours toward conflict',
    description: 'Upstream construction on a shared river triggers a standoff over water rights and downstream survival.',
    regions: ['mena', 'southAsia', 'subSaharanAfrica', 'centralAsia'],
    impact: r => ({ [r]: { stability: -8, influence: -4, threatLevel: 10 } }),
    approvalDelta: -3,
    cascade: true,
  },
  {
    headline: 'UN declares famine; humanitarian aid corridors blocked',
    description: 'Acute food insecurity reaches catastrophic levels as conflict prevents access for relief organisations.',
    regions: ['subSaharanAfrica', 'mena', 'southAsia'],
    impact: r => ({ [r]: { stability: -14, influence: -4, threatLevel: 8 } }),
    resourceDelta: { economicInfluence: -6, politicalCapital: -5 },
    approvalDelta: -5,
    cascade: true,
  },
  {
    headline: 'IAEA confirms radioactive material missing from storage',
    description: 'International regulators issue an emergency alert; origin and current whereabouts of the material are unknown.',
    regions: ['centralAsia', 'mena', 'eastAsia'],
    impact: r => ({ [r]: { threatLevel: 20, stability: -8 } }),
    resourceDelta: { intelligenceAssets: -8, politicalCapital: -8 },
    approvalDelta: -6,
    defconDelta: -1,
  },
  {
    headline: 'Catastrophic earthquake devastates densely populated coastline',
    description: 'Thousands dead, hundreds of thousands displaced; international rescue teams mobilise.',
    regions: ['southAsia', 'centralAsia', 'mena', 'eastAsia', 'latam'],
    impact: r => ({ [r]: { stability: -12, influence: 3, threatLevel: 4 } }),
    resourceDelta: { economicInfluence: -8, politicalCapital: -4 },
    approvalDelta: 2,
  },
  {
    headline: 'Mass opposition arrests signal authoritarian consolidation',
    description: 'Hundreds of politicians, journalists, and civil society leaders detained in overnight security raids.',
    regions: ['centralAsia', 'mena', 'eastAsia', 'subSaharanAfrica'],
    impact: r => ({ [r]: { stability: -10, influence: -6, threatLevel: 6 } }),
    approvalDelta: -3,
  },
  {
    headline: 'Landmark multi-bloc free trade agreement enters force',
    description: 'A newly ratified pact eliminates tariffs across a combined market of over 800 million consumers.',
    regions: ['subSaharanAfrica', 'latam', 'southAsia', 'oceania'],
    impact: r => ({ [r]: { stability: 6, influence: 8 } }),
    resourceDelta: { economicInfluence: 10 },
    approvalDelta: 3,
  },
  {
    headline: 'Gas supply cutoff triggers continent-wide energy emergency',
    description: 'Emergency rationing imposed as prices reach record highs following an abrupt and unexplained supply halt.',
    regions: ['europe', 'eastAsia', 'southAsia'],
    impact: r => ({ [r]: { stability: -10, influence: -4, threatLevel: 8 } }),
    resourceDelta: { economicInfluence: -10 },
    approvalDelta: -5,
    cascade: true,
  },
  {
    headline: 'Naval blockade imposed on critical shipping strait',
    description: 'Warships intercept commercial traffic, disrupting global commodity flows and spiking marine insurance rates.',
    regions: ['mena', 'eastAsia', 'southAsia'],
    impact: r => ({ [r]: { stability: -8, threatLevel: 16, influence: -5 } }),
    resourceDelta: { militaryReadiness: -6, economicInfluence: -8 },
    approvalDelta: -4,
    defconDelta: -1,
    cascade: true,
  },
  {
    headline: 'Rising power defies international court territorial ruling',
    description: 'Government publicly rejects binding arbitration, spurring solidarity statements and sanction threats.',
    regions: ['eastAsia', 'mena', 'europe', 'southAsia'],
    impact: r => ({ [r]: { influence: -8, stability: -4, threatLevel: 8 } }),
    resourceDelta: { politicalCapital: -6 },
    approvalDelta: -3,
    cascade: true,
  },
  {
    headline: 'Ceasefire collapses; heavy fighting resumes within hours',
    description: 'A fragile truce brokered last week disintegrates as both sides trade accusations of violations.',
    regions: ['mena', 'subSaharanAfrica', 'centralAsia', 'southAsia'],
    impact: r => ({ [r]: { stability: -14, threatLevel: 14, influence: -4 } }),
    resourceDelta: { politicalCapital: -8, militaryReadiness: -6 },
    approvalDelta: -5,
    defconDelta: -1,
    cascade: true,
  },
  {
    headline: 'Sweeping AI regulation framework signed into international law',
    description: 'A landmark multilateral accord restricts autonomous weapons and mandates civilian AI oversight bodies.',
    regions: ['northAmerica', 'europe', 'eastAsia'],
    impact: r => ({ [r]: { stability: 4, influence: 6 } }),
    resourceDelta: { technologyLevel: 6, politicalCapital: -4 },
    approvalDelta: 3,
  },
];

// ---------------------------------------------------------------------------
// Advisor briefing templates (Shadow President: each advisor has a POV)
// ---------------------------------------------------------------------------

const ADVISOR_TEMPLATES: Record<GameAdvisorId, (evt: GameEvent, region: GameRegionState) => string> = {
  secState: (evt, region) =>
    `Secretary Whitfield: "The situation in ${region.name} calls for measured diplomacy. ` +
    `${region.stability < 40 ? 'Instability is critical — we must engage multilaterally.' : 'We should reinforce our partnerships.'} ` +
    `I recommend a diplomatic initiative rather than escalation."`,
  secDef: (evt, region) =>
    `General Kane: "${region.name} is ${region.threatLevel > 50 ? 'a serious threat vector' : 'relatively contained'}. ` +
    `${region.troopsDeployed ? 'Our forces on the ground give us leverage.' : 'We have no forward presence — consider deployment.'} ` +
    `Strength deters aggression."`,
  ciaDirector: (evt, region) =>
    `Dr. Voss: "Our assets in ${region.name} report ${region.stability < 40 ? 'growing unrest and power vacuums' : 'stable conditions'}. ` +
    `${region.influence < 0 ? 'Covert influence campaigns could shift sentiment in our favour.' : 'We should protect our existing networks.'} ` +
    `Discretion is advised — exposure would be costly."`,
  econAdvisor: (evt, region) =>
    `Nakamura: "${region.name}'s economy is ${region.stability > 60 ? 'healthy enough for trade expansion' : 'fragile — aid could buy goodwill'}. ` +
    `${region.sanctioned ? 'Current sanctions are biting; consider whether to maintain pressure.' : 'Economic engagement is more productive than isolation.'}"`,
  jointChiefs: (evt, region) =>
    `Admiral Chen: "Risk assessment for ${region.name}: threat level ${region.threatLevel}/100. ` +
    `${region.nuclearCapable ? 'Nuclear capability demands caution. ' : ''}` +
    `${evt.defconDelta && evt.defconDelta < 0 ? 'This incident has raised our alert posture.' : 'No change to force readiness recommended.'} ` +
    `I advise proportional response."`,
};

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
// Action catalogue (Shadow President-style categories)
// ---------------------------------------------------------------------------

export function getAvailableActions(state: GameState): GameAction[] {
  const regions = Object.keys(state.regions) as GameRegionId[];
  const actions: GameAction[] = [];

  for (const regionId of regions) {
    const region = state.regions[regionId];
    const n = region.name;

    // ── Diplomatic ──────────────────────────────────────────────────
    actions.push(
      { type: 'diplomaticPraise',  category: 'diplomatic', label: `Praise ${n}`,           description: 'Publicly commend the region\'s leadership to improve relations.',           targetRegion: regionId, cost: { politicalCapital: 4 },  risk: 0,  approvalImpact: 1 },
      { type: 'diplomaticWarn',    category: 'diplomatic', label: `Warn ${n}`,             description: 'Issue a formal warning, signalling displeasure with current policy.',       targetRegion: regionId, cost: { politicalCapital: 6 },  risk: 5,  approvalImpact: 0 },
      { type: 'diplomaticThreaten', category: 'diplomatic', label: `Threaten ${n}`,        description: 'Deliver a public ultimatum backed by implied consequences.',                targetRegion: regionId, cost: { politicalCapital: 10 }, risk: 15, approvalImpact: -2 },
      { type: 'proposeTreaty',     category: 'diplomatic', label: `Propose Treaty → ${n}`, description: 'Offer a formal treaty of cooperation and mutual security guarantees.',     targetRegion: regionId, cost: { politicalCapital: 15, economicInfluence: 5 }, risk: 5, approvalImpact: 3 },
      { type: 'diplomaticSummit',  category: 'diplomatic', label: `Summit → ${n}`,         description: 'Convene a high-level summit with regional leaders.',                       targetRegion: regionId, cost: { politicalCapital: 12 }, risk: 0,  approvalImpact: 2 },
    );

    // ── Economic ────────────────────────────────────────────────────
    actions.push(
      { type: 'economicAid',    category: 'economic', label: `Send Aid → ${n}`,           description: 'Deliver financial aid and humanitarian assistance.',                        targetRegion: regionId, cost: { economicInfluence: 15 },                       risk: 0,  approvalImpact: 2 },
      { type: 'tradeAgreement', category: 'economic', label: `Trade Deal → ${n}`,         description: 'Negotiate a bilateral trade agreement to open markets.',                    targetRegion: regionId, cost: { economicInfluence: 10, politicalCapital: 5 },  risk: 0,  approvalImpact: 2 },
    );
    if (!region.sanctioned) {
      actions.push(
        { type: 'imposeSanctions', category: 'economic', label: `Impose Sanctions → ${n}`, description: 'Enact economic sanctions to pressure the regime.',                        targetRegion: regionId, cost: { politicalCapital: 8, economicInfluence: 5 },   risk: 10, approvalImpact: -1 },
      );
    } else {
      actions.push(
        { type: 'liftSanctions', category: 'economic', label: `Lift Sanctions → ${n}`,     description: 'Remove existing sanctions as a goodwill gesture.',                       targetRegion: regionId, cost: { politicalCapital: 6 },                         risk: 5,  approvalImpact: 0 },
      );
    }

    // ── Military ────────────────────────────────────────────────────
    actions.push(
      { type: 'militaryExercise', category: 'military', label: `Exercise → ${n}`,         description: 'Conduct joint military exercises to project strength.',                    targetRegion: regionId, cost: { militaryReadiness: 12, politicalCapital: 5 },  risk: 10, approvalImpact: -1 },
    );
    if (!region.troopsDeployed) {
      actions.push(
        { type: 'deployTroops', category: 'military', label: `Deploy Troops → ${n}`,       description: 'Station ground forces to deter threats and stabilise the region.',        targetRegion: regionId, cost: { militaryReadiness: 20, politicalCapital: 10 }, risk: 20, approvalImpact: -4 },
      );
    } else {
      actions.push(
        { type: 'withdrawTroops', category: 'military', label: `Withdraw Troops ← ${n}`,   description: 'Pull out deployed forces — may destabilise the region.',                 targetRegion: regionId, cost: { politicalCapital: 8 },                         risk: 15, approvalImpact: 2 },
      );
    }
    actions.push(
      { type: 'nuclearPosture', category: 'military', label: `Nuclear Posture → ${n}`,     description: 'Shift nuclear readiness posture to signal resolve. Extremely high risk.', targetRegion: regionId, cost: { militaryReadiness: 10, politicalCapital: 15 }, risk: 50, approvalImpact: -6 },
    );

    // ── Covert ──────────────────────────────────────────────────────
    actions.push(
      { type: 'deployAgent',       category: 'covert', label: `Deploy Agent → ${n}`,       description: 'Insert a field operative to gather intelligence.',                        targetRegion: regionId, cost: { intelligenceAssets: 10, politicalCapital: 3 }, risk: 20, approvalImpact: -2 },
      { type: 'covertInfluence',   category: 'covert', label: `Influence Op → ${n}`,       description: 'Run a covert media and civil-society influence campaign.',                targetRegion: regionId, cost: { intelligenceAssets: 12, politicalCapital: 5 }, risk: 30, approvalImpact: -4 },
      { type: 'covertDestabilise', category: 'covert', label: `Destabilise → ${n}`,        description: 'Covertly fund opposition groups to undermine the regime.',                targetRegion: regionId, cost: { intelligenceAssets: 18, politicalCapital: 8 }, risk: 45, approvalImpact: -8 },
      { type: 'cyberOperation',    category: 'covert', label: `Cyber Op → ${n}`,           description: 'Launch a covert cyber campaign against adversary networks.',              targetRegion: regionId, cost: { technologyLevel: 10, intelligenceAssets: 8 },  risk: 35, approvalImpact: -5 },
      { type: 'fundCoup',          category: 'covert', label: `Fund Coup → ${n}`,          description: 'Finance and coordinate a regime-change operation. Extreme risk.',         targetRegion: regionId, cost: { intelligenceAssets: 25, politicalCapital: 15 }, risk: 60, approvalImpact: -12 },
    );
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

export function createInitialState(seed?: number): GameState {
  const rand = xorshift32(seed ?? Date.now());
  const regions = {} as Record<GameRegionId, GameRegionState>;
  for (const [id, def] of Object.entries(REGION_DEFS) as [GameRegionId, typeof REGION_DEFS[GameRegionId]][]) {
    regions[id] = {
      id,
      name: def.name,
      influence:      clamp(def.influence   + Math.round((rand() - 0.5) * 10), -100, 100),
      stability:      clamp(def.stability   + Math.round((rand() - 0.5) * 10), 0, 100),
      threatLevel:    clamp(def.threatLevel + Math.round((rand() - 0.5) * 10), 0, 100),
      governmentType: def.governmentType,
      nuclearCapable: def.nuclearCapable,
      sanctioned:     false,
      troopsDeployed: false,
    };
  }

  // Track objective state (obj-defcon starts true — you haven't broken it yet)
  const objectives = OBJECTIVES.map(o => ({ ...o }));
  const defconObj = objectives.find(o => o.id === 'obj-defcon');
  if (defconObj) defconObj.completed = true;

  return {
    turn: 1,
    maxTurns: MAX_TURNS,
    phase: 'briefing',
    resources: { ...STARTING_RESOURCES },
    budget: { ...DEFAULT_BUDGET },
    regions,
    log: [],
    objectives,
    score: 0,
    approval: 65,
    defcon: 5 as DefconLevel,
    advisors: ADVISORS.map(a => ({ ...a })),
  };
}

/**
 * Generate 1-3 world events for the current turn.
 */
export function generateTurnEvents(state: GameState, seed?: number): GameEvent[] {
  const rand = xorshift32(seed ?? state.turn * 9973 + 42);
  const count = 1 + Math.floor(rand() * 3);
  const events: GameEvent[] = [];

  for (let i = 0; i < count; i++) {
    const tmpl = EVENT_TEMPLATES[Math.floor(rand() * EVENT_TEMPLATES.length)];
    const region = tmpl.regions[Math.floor(rand() * tmpl.regions.length)];

    // Build advisor briefings for this event
    const regionState = state.regions[region];
    const briefings: AdvisorBriefing[] = state.advisors.map(a => ({
      advisorId: a.id,
      text: ADVISOR_TEMPLATES[a.id]({ ...placeholderEvent(state.turn, i, tmpl, region), defconDelta: tmpl.defconDelta }, regionState),
    }));

    events.push({
      id: `evt-${state.turn}-${i}`,
      turn: state.turn,
      headline: tmpl.headline,
      description: tmpl.description,
      region,
      impact: tmpl.impact(region),
      resourceDelta: tmpl.resourceDelta,
      approvalDelta: tmpl.approvalDelta,
      defconDelta: tmpl.defconDelta,
      advisorBriefings: briefings,
    });
  }
  return events;
}

/** Lightweight event stub used during briefing generation. */
function placeholderEvent(turn: number, idx: number, tmpl: EventTemplate, region: GameRegionId): GameEvent {
  return {
    id: `evt-${turn}-${idx}`,
    turn,
    headline: tmpl.headline,
    description: tmpl.description,
    region,
    impact: tmpl.impact(region),
    resourceDelta: tmpl.resourceDelta,
    approvalDelta: tmpl.approvalDelta,
    defconDelta: tmpl.defconDelta,
  };
}

/**
 * Apply world events to the state (mutates in place).
 */
export function applyEvents(state: GameState, events: GameEvent[]): GameState {
  for (const evt of events) {
    state.log.push(evt);

    // Region impacts
    if (evt.impact) {
      for (const [rId, delta] of Object.entries(evt.impact) as [GameRegionId, Partial<GameRegionState>][]) {
        const r = state.regions[rId];
        if (!r) continue;
        if (delta.influence   != null) r.influence   = clamp(r.influence   + delta.influence,   -100, 100);
        if (delta.stability   != null) r.stability   = clamp(r.stability   + delta.stability,   0, 100);
        if (delta.threatLevel != null) r.threatLevel = clamp(r.threatLevel + delta.threatLevel, 0, 100);
      }
    }

    // Resource impacts
    if (evt.resourceDelta) {
      applyResourceDelta(state.resources, evt.resourceDelta);
    }

    // Approval (Shadow President)
    if (evt.approvalDelta) {
      state.approval = clamp(state.approval + evt.approvalDelta, 0, 100);
    }

    // DEFCON (Shadow President)
    if (evt.defconDelta) {
      state.defcon = clamp(state.defcon + evt.defconDelta, 1, 5) as DefconLevel;
    }

    // Cascade to neighbours (Shadow President-style spill-over)
    const evtRegion = evt.region;
    const neighbours = REGION_NEIGHBOURS[evtRegion];
    if (neighbours) {
      const primaryStabDelta = (evt.impact[evtRegion] as { stability?: number } | undefined)?.stability;
      if (primaryStabDelta != null && primaryStabDelta < -8) {
        const spillover = Math.round(primaryStabDelta * 0.3);
        for (const nId of neighbours) {
          const nr = state.regions[nId];
          if (nr) nr.stability = clamp(nr.stability + spillover, 0, 100);
        }
      }
    }
  }
  return state;
}

/**
 * Resolve a player action.
 */
export function resolveAction(state: GameState, action: GameAction, seed?: number): GameEvent {
  const rand = xorshift32(seed ?? state.turn * 7919 + 13);

  // Deduct costs
  for (const [k, v] of Object.entries(action.cost) as [keyof GameResources, number][]) {
    state.resources[k] = Math.max(0, state.resources[k] - v);
  }

  const region = state.regions[action.targetRegion];
  const effects = actionEffects(action, region);

  region.influence   = clamp(region.influence   + effects.influence,   -100, 100);
  region.stability   = clamp(region.stability   + effects.stability,   0, 100);
  region.threatLevel = clamp(region.threatLevel + effects.threatLevel, 0, 100);

  // Persistent toggles
  if (action.type === 'imposeSanctions') region.sanctioned = true;
  if (action.type === 'liftSanctions')   region.sanctioned = false;
  if (action.type === 'deployTroops')    region.troopsDeployed = true;
  if (action.type === 'withdrawTroops')  region.troopsDeployed = false;

  // DEFCON shift for nuclear posture action
  if (action.type === 'nuclearPosture') {
    state.defcon = clamp(state.defcon - 1, 1, 5) as DefconLevel;
  }

  // Covert ops exposure risk (Shadow President).
  // Higher technologyLevel reduces exposure chance: each 10 TL shaves 1% off the risk floor.
  const techBonus = Math.floor(state.resources.technologyLevel / 10);
  const effectiveRisk = Math.max(0, action.risk - techBonus);
  let exposureText = '';
  if (action.category === 'covert' && rand() * 100 < effectiveRisk) {
    // Exposed!
    state.approval = clamp(state.approval + action.approvalImpact, 0, 100);
    region.influence = clamp(region.influence - 8, -100, 100);
    exposureText = ' ⚠️ Operation EXPOSED — approval and influence damaged.';
  } else if (action.category !== 'covert') {
    // Non-covert actions always affect approval
    state.approval = clamp(state.approval + action.approvalImpact, 0, 100);
  }

  // Cascade: military/aggressive actions raise threat in neighbours
  if (action.category === 'military' && action.type !== 'withdrawTroops') {
    for (const nId of REGION_NEIGHBOURS[action.targetRegion] ?? []) {
      const nr = state.regions[nId];
      if (nr) nr.threatLevel = clamp(nr.threatLevel + 3, 0, 100);
    }
  }

  const evt: GameEvent = {
    id: `act-${state.turn}`,
    turn: state.turn,
    headline: `Action: ${action.label}`,
    description: action.description + exposureText,
    region: action.targetRegion,
    impact: { [action.targetRegion]: { influence: effects.influence, stability: effects.stability, threatLevel: effects.threatLevel } },
    approvalDelta: action.approvalImpact,
  };
  state.log.push(evt);
  return evt;
}

/**
 * Advance the game phase. Returns the new phase.
 */
export function advancePhase(state: GameState): GamePhase {
  if (state.phase === 'briefing') {
    state.phase = 'action';
  } else if (state.phase === 'action') {
    state.phase = 'resolution';
  } else if (state.phase === 'resolution') {
    regenerateResources(state.resources, state.budget);
    updateObjectives(state);
    state.score = computeScore(state);

    // Shadow President game-over conditions
    if (state.approval < 15) {
      state.phase = 'gameOver'; // Impeached!
    } else if (state.defcon <= 1) {
      state.phase = 'gameOver'; // Nuclear war
    } else if (state.turn >= state.maxTurns) {
      state.phase = 'gameOver';
    } else {
      state.turn += 1;
      state.phase = 'briefing';
    }
  }
  return state.phase;
}

/**
 * Apply a new budget allocation. Entries must sum to 100.
 */
export function setBudget(state: GameState, budget: GameBudget): void {
  const total = budget.defense + budget.intelligence + budget.diplomacy + budget.economy + budget.technology;
  if (total !== 100) return; // silently reject invalid budgets
  state.budget = { ...budget };
}

// ---------------------------------------------------------------------------
// Scoring & objectives
// ---------------------------------------------------------------------------

export function computeScore(state: GameState): number {
  const regions = Object.values(state.regions);
  const avgStability = regions.reduce((s, r) => s + r.stability, 0) / regions.length;
  const avgInfluence = regions.reduce((s, r) => s + r.influence, 0) / regions.length;
  const objectiveBonus = state.objectives.filter(o => o.completed).length * 50;
  const approvalBonus = state.approval;
  const defconBonus = (state.defcon - 1) * 10; // DEFCON 5 = 40 pts, DEFCON 2 = 10 pts

  // Resources are intentionally excluded from score: spending them is the game.
  return Math.round(avgStability + avgInfluence + objectiveBonus + approvalBonus / 2 + defconBonus);
}

function updateObjectives(state: GameState): void {
  const regions = Object.values(state.regions);
  const avgStability = regions.reduce((s, r) => s + r.stability, 0) / regions.length;
  const positiveCount = regions.filter(r => r.influence > 0).length;
  const totalResources = Object.values(state.resources).reduce((a, b) => a + b, 0);

  for (const obj of state.objectives) {
    if (obj.id === 'obj-stability')  obj.completed = avgStability > 50;
    if (obj.id === 'obj-influence')  obj.completed = positiveCount >= 7;
    if (obj.id === 'obj-approval')   obj.completed = state.approval >= 50;
    if (obj.id === 'obj-defcon')     obj.completed = obj.completed && state.defcon >= 3; // stays true unless broken
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

function actionEffects(action: GameAction, region: GameRegionState): { influence: number; stability: number; threatLevel: number } {
  // Government-type multiplier (Shadow President: democracies respond better to diplomacy, autocracies to force)
  const govMod = governmentModifier(region.governmentType, action.category);

  const base = baseActionEffects(action.type);
  return {
    influence:   Math.round(base.influence   * govMod),
    stability:   Math.round(base.stability   * govMod),
    threatLevel: Math.round(base.threatLevel * govMod), // same direction: receptive governments respond more to all effects
  };
}

function baseActionEffects(type: GameAction['type']): { influence: number; stability: number; threatLevel: number } {
  switch (type) {
    // Diplomatic
    case 'diplomaticPraise':    return { influence:  6, stability:  2, threatLevel: -1 };
    case 'diplomaticWarn':      return { influence: -2, stability: -4, threatLevel: -5 };
    case 'diplomaticThreaten':  return { influence: -5, stability: -2, threatLevel: -6 };
    case 'proposeTreaty':       return { influence: 15, stability:  5, threatLevel: -6 };
    case 'diplomaticSummit':    return { influence: 12, stability:  5, threatLevel: -4 };
    // Economic
    case 'economicAid':         return { influence: 10, stability:  8, threatLevel: -2 };
    case 'tradeAgreement':      return { influence:  8, stability:  6, threatLevel: -3 };
    case 'imposeSanctions':     return { influence: -8, stability: -6, threatLevel: -4 };
    case 'liftSanctions':       return { influence:  6, stability:  3, threatLevel: -1 };
    // Military
    case 'militaryExercise':    return { influence:  3, stability: -2, threatLevel: -10 };
    case 'deployTroops':        return { influence: -4, stability:  4, threatLevel: -14 };
    case 'withdrawTroops':      return { influence:  5, stability: -6, threatLevel:  8 };
    case 'nuclearPosture':      return { influence: -8, stability: -5, threatLevel: -15 };
    // Covert
    case 'deployAgent':         return { influence:  5, stability:  2, threatLevel: -3 };
    case 'covertInfluence':     return { influence:  8, stability:  0, threatLevel: -2 };
    case 'covertDestabilise':   return { influence:  0, stability: -12, threatLevel:  4 };
    case 'cyberOperation':      return { influence:  0, stability: -3, threatLevel: -8 };
    case 'fundCoup':            return { influence: 20, stability: -20, threatLevel: 10 };
    default:                    return { influence:  0, stability:  0, threatLevel:  0 };
  }
}

/**
 * Government-type modifier (Shadow President).
 * Democracies respond well to diplomacy/economy; autocracies to military/covert.
 */
function governmentModifier(gov: GovernmentType, category: GameActionCategory): number {
  const table: Record<GovernmentType, Record<GameActionCategory, number>> = {
    democracy:     { diplomatic: 1.3, economic: 1.2, military: 0.8, covert: 0.7 },
    autocracy:     { diplomatic: 0.7, economic: 0.9, military: 1.2, covert: 1.3 },
    monarchy:      { diplomatic: 1.1, economic: 1.0, military: 1.0, covert: 0.9 },
    theocracy:     { diplomatic: 0.6, economic: 0.8, military: 1.1, covert: 1.2 },
    communist:     { diplomatic: 0.5, economic: 0.7, military: 1.3, covert: 1.1 },
    militaryJunta: { diplomatic: 0.4, economic: 0.8, military: 1.4, covert: 1.3 },
  };
  return table[gov]?.[category] ?? 1.0;
}

/** Budget-driven per-turn resource regeneration (Shadow President budget mechanic). */
function regenerateResources(resources: GameResources, budget: GameBudget): void {
  // Base regen scaled by budget allocation (each point of budget = 0.5 regen)
  const scale = 0.5;
  resources.militaryReadiness   = Math.min(200, resources.militaryReadiness   + Math.round(budget.defense * scale));
  resources.intelligenceAssets  = Math.min(200, resources.intelligenceAssets  + Math.round(budget.intelligence * scale));
  resources.politicalCapital    = Math.min(200, resources.politicalCapital    + Math.round(budget.diplomacy * scale));
  resources.economicInfluence   = Math.min(200, resources.economicInfluence   + Math.round(budget.economy * scale));
  resources.technologyLevel     = Math.min(200, resources.technologyLevel     + Math.round(budget.technology * scale));
}
