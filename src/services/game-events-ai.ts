/**
 * AI-driven game event generation.
 *
 * Calls the GenerateGameEvents RPC with recent news headlines and maps the
 * server response into GameEvent objects that the engine can apply directly.
 * All values are clamped to safe ranges so the engine's invariants hold even
 * if the LLM returns unexpected numbers.
 *
 * Returns null on any error so callers can fall back to template-based
 * event generation without crashing.
 */

import { IntelligenceServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { getApiBaseUrl } from './runtime';
import type { GameState, GameEvent, GameRegionId } from '@/types';

const VALID_REGIONS = new Set<GameRegionId>([
  'northAmerica', 'europe', 'eastAsia', 'southAsia',
  'mena', 'subSaharanAfrica', 'latam', 'centralAsia', 'oceania',
]);

let _client: IntelligenceServiceClient | null = null;

function getClient(): IntelligenceServiceClient {
  if (!_client) {
    _client = new IntelligenceServiceClient(getApiBaseUrl(), {
      fetch: (...args) => globalThis.fetch(...args),
    });
  }
  return _client;
}

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
    const resp = await getClient().generateGameEvents(
      { headlines: headlines.slice(0, 10), turn: state.turn, count },
      { signal: AbortSignal.timeout(12_000) },
    );

    if (resp.fallback || !resp.events.length) return null;

    return resp.events.map((e, i): GameEvent => {
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
