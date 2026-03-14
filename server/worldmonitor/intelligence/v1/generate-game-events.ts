import type {
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { callLlm } from '../../../_shared/llm';

// Types defined locally — GenerateGameEvents RPC is not yet registered in
// the IntelligenceService proto service definition, so these aren't generated.
interface GenerateGameEventsRequest {
  headlines?: string[];
  count?: number;
  turn?: number;
}

interface GeneratedGameEvent {
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
  events: GeneratedGameEvent[];
  provider: string;
  fallback: boolean;
}

const VALID_REGIONS = new Set([
  'northAmerica', 'europe', 'eastAsia', 'southAsia',
  'mena', 'subSaharanAfrica', 'latam', 'centralAsia', 'oceania',
]);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n) || 0));
}

export async function generateGameEvents(
  _ctx: ServerContext,
  req: GenerateGameEventsRequest,
): Promise<GenerateGameEventsResponse> {
  const headlines = (req.headlines ?? [])
    .slice(0, 10)
    .filter(h => typeof h === 'string' && h.trim().length > 0);
  const count = Math.min(3, Math.max(1, req.count || 2));

  if (headlines.length < 2) {
    return { events: [], provider: 'skipped', fallback: true };
  }

  const headlineList = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');

  const systemPrompt =
    'You are a creative game master for a geopolitical strategy game called "The Great Game," ' +
    'inspired by the 1993 DOS classic Shadow President. ' +
    'Your role is to generate concise, dramatic world events grounded in current real-world news. ' +
    'Never fabricate specific names of real leaders or claim real events have specific outcomes.';

  const userPrompt =
    `Based on the headlines below, generate exactly ${count} distinct world events for game turn ${req.turn ?? 1}.\n\n` +
    `Headlines:\n${headlineList}\n\n` +
    `Available regions: northAmerica, europe, eastAsia, southAsia, mena, subSaharanAfrica, latam, centralAsia, oceania\n\n` +
    `Respond with ONLY a valid JSON array (no markdown fences, no explanation) containing exactly ${count} objects. ` +
    `Each object must have these exact fields:\n` +
    `  "headline"        — string, punchy event title under 80 chars\n` +
    `  "description"     — string, 1-2 sentences under 200 chars\n` +
    `  "region"          — one of the 9 region IDs above\n` +
    `  "stability_delta" — integer from -20 to 10 (negative = destabilising)\n` +
    `  "influence_delta" — integer from -15 to 15\n` +
    `  "threat_delta"    — integer from -10 to 20 (positive = more threatening)\n` +
    `  "approval_delta"  — integer from -8 to 4\n` +
    `  "defcon_delta"    — integer: -1 (escalation), 0 (no change), or 1 (de-escalation)\n\n` +
    `Rules: crises have negative stability_delta; nuclear/WMD events use defcon_delta -1; ` +
    `most events use defcon_delta 0; base events on the actual headlines provided.`;

  const result = await callLlm({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.75,
    maxTokens: 900,
    timeoutMs: 14_000,
    validate: (content) => {
      try {
        const parsed = JSON.parse(content.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim());
        return Array.isArray(parsed) && parsed.length > 0;
      } catch {
        return false;
      }
    },
  });

  if (!result) {
    return { events: [], provider: 'failed', fallback: true };
  }

  let raw: unknown;
  try {
    const cleaned = result.content
      .replace(/^```[a-z]*\n?/gi, '')
      .replace(/```$/gi, '')
      .trim();
    raw = JSON.parse(cleaned);
    if (!Array.isArray(raw)) throw new Error('not array');
  } catch {
    return { events: [], provider: result.provider, fallback: true };
  }

  const events: GeneratedGameEvent[] = (raw as unknown[])
    .slice(0, count)
    .flatMap((item: unknown): GeneratedGameEvent[] => {
      if (typeof item !== 'object' || item === null) return [];
      const e = item as Record<string, unknown>;
      const rawRegion = typeof e.region === 'string' ? e.region : '';
      const region = VALID_REGIONS.has(rawRegion) ? rawRegion : 'mena';
      return [{
        headline: String(e.headline ?? 'Intelligence Update').slice(0, 80),
        description: String(e.description ?? '').slice(0, 200),
        region,
        stabilityDelta: clamp(Number(e.stability_delta ?? 0), -20, 10),
        influenceDelta: clamp(Number(e.influence_delta ?? 0), -15, 15),
        threatDelta:    clamp(Number(e.threat_delta    ?? 0), -10, 20),
        approvalDelta:  clamp(Number(e.approval_delta  ?? 0), -8,  4),
        defconDelta:    clamp(Number(e.defcon_delta    ?? 0), -1,  1),
      }];
    });

  if (events.length === 0) {
    return { events: [], provider: result.provider, fallback: true };
  }

  return { events, provider: result.provider, fallback: false };
}
