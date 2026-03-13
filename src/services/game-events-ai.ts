/**
 * AI-driven game event generation.
 *
 * Calls the GenerateGameEvents endpoint with recent news headlines and maps the
 * server response into GameEvent objects that the engine can apply directly.
 * All values are clamped to safe ranges so the engine's invariants hold even
 * if the LLM returns unexpected numbers.
 *
 * Uses a direct fetch call because the GenerateGameEvents RPC is not yet part
 * of the proto service definition (will be added in a follow-up).
 *
 * Returns null on any error so callers can fall back to template-based
 * event generation without crashing.
 */

import { getApiBaseUrl } from './runtime';
import type { GameState, GameEvent, GameRegionId } from '@/types';

interface GeneratedGameEventResponse {
  headline: string;
  description: string;
  region: string;
  stabilityDelta: number;
  influenceDelta: number;
  threatDelta: number;
  approvalDelta: number;
  defconDelta: number;
}

interface GenerateGameEventsResponse {
  events: GeneratedGameEventResponse[];
  provider: string;
  fallback: boolean;
}

const VALID_REGIONS = new Set<GameRegionId>([
  'northAmerica', 'europe', 'eastAsia', 'southAsia',
  'mena', 'subSaharanAfrica', 'latam', 'centralAsia', 'oceania',
]);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n) || 0));
}

/**
 * Attempt to generate this turn's world events from live news headlines.
 *
 * @param state   Current game state (used for turn number and event ID seeding).
 * @param headlines  Recent news titles from ctx.allNews (plain strings).
 * @returns Array of GameEvent objects, or null if the server is unavailable
 *          or has no LLM provider configured.
 */
export async function generateEventsFromNews(
  state: GameState,
  headlines: string[],
): Promise<GameEvent[] | null> {
  if (headlines.length < 2) return null;

  const count = 1 + Math.floor(Math.random() * 3);

  try {
    const url = `${getApiBaseUrl()}/api/intelligence/v1/generate-game-events`;
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headlines: headlines.slice(0, 10), turn: state.turn, count }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) return null;

    const resp = (await res.json()) as GenerateGameEventsResponse;

    if (resp.fallback || !resp.events.length) return null;

    return resp.events.map((e: GeneratedGameEventResponse, i: number): GameEvent => {
      const region = (VALID_REGIONS.has(e.region as GameRegionId)
        ? e.region
        : 'mena') as GameRegionId;

      const stabilityDelta  = clamp(e.stabilityDelta,  -20, 10);
      const influenceDelta  = clamp(e.influenceDelta,  -15, 15);
      const threatDelta     = clamp(e.threatDelta,     -10, 20);
      const approvalDelta   = clamp(e.approvalDelta,   -8,  4);
      const defconDelta     = clamp(e.defconDelta,     -1,  1);

      return {
        id: `ai-${state.turn}-${i}`,
        turn: state.turn,
        headline: e.headline || 'Intelligence Update',
        description: e.description || '',
        region,
        impact: {
          [region]: {
            stability:  stabilityDelta,
            influence:  influenceDelta,
            threatLevel: threatDelta,
          },
        },
        approvalDelta: approvalDelta !== 0 ? approvalDelta : undefined,
        defconDelta:   defconDelta   !== 0 ? defconDelta   : undefined,
      };
    });
  } catch {
    // Network error, timeout, or no LLM credentials — caller falls back to templates.
    return null;
  }
}
