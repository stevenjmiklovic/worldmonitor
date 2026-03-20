/**
 * ListPredictionMarkets RPC -- reads Railway-seeded prediction market data
 * from Redis. All external API calls (Polymarket Gamma, Kalshi) happen on
 * Railway seed scripts, never on Vercel.
 */

import {
  type MarketSource,
  type PredictionServiceHandler,
  type ServerContext,
  type ListPredictionMarketsRequest,
  type ListPredictionMarketsResponse,
  type PredictionMarket,
} from '../../../../src/generated/server/worldmonitor/prediction/v1/service_server';

import { clampInt } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';

const BOOTSTRAP_KEY = 'prediction:markets-bootstrap:v1';

const TECH_CATEGORY_TAGS = ['ai', 'tech', 'crypto', 'science'];
const FINANCE_CATEGORY_TAGS = ['economy', 'fed', 'inflation', 'interest-rates', 'recession', 'trade', 'tariffs', 'debt-ceiling'];

interface BootstrapMarket {
  title: string;
  yesPrice: number;
  volume: number;
  url: string;
  endDate?: string;
  source?: 'kalshi' | 'polymarket';
}

interface BootstrapData {
  geopolitical?: BootstrapMarket[];
  tech?: BootstrapMarket[];
  finance?: BootstrapMarket[];
}

function toProtoMarket(m: BootstrapMarket, category: string): PredictionMarket {
  return {
    id: m.url?.split('/').pop() || '',
    title: m.title,
    yesPrice: (m.yesPrice ?? 50) / 100,
    volume: m.volume ?? 0,
    url: m.url || '',
    closesAt: m.endDate ? Date.parse(m.endDate) : 0,
    category,
    source: m.source === 'kalshi' ? 'MARKET_SOURCE_KALSHI' as MarketSource : 'MARKET_SOURCE_POLYMARKET' as MarketSource,
  };
}

/** Map a GammaMarket to a proto PredictionMarket. */
function mapMarket(market: GammaMarket): PredictionMarket {
  const closesAtMs = market.endDate ? Date.parse(market.endDate) : 0;
  return {
    id: market.slug || '',
    title: market.question,
    yesPrice: parseYesPrice(market),
    volume: (market.volumeNum ?? (market.volume ? parseFloat(market.volume) : 0)) || 0,
    url: `https://polymarket.com/market/${market.slug}`,
    closesAt: Number.isFinite(closesAtMs) ? closesAtMs : 0,
    category: '',
    source: 'MARKET_SOURCE_POLYMARKET' as MarketSource,
  };
}

/** Map a KalshiMarket to a proto PredictionMarket. Caller must pre-filter for active binary markets. */
function mapKalshiMarket(market: KalshiMarket, category: string, eventTitle?: string): PredictionMarket {
  const closesAtMs = market.close_time ? Date.parse(market.close_time) : 0;
  const yesPrice = parseFloat(market.last_price_dollars || '0.5');
  return {
    id: market.ticker,
    title: market.yes_sub_title || market.title || eventTitle || '',
    yesPrice: Number.isFinite(yesPrice) ? yesPrice : 0.5,
    volume: parseFloat(market.volume_fp || '0'),
    url: `https://kalshi.com/markets/${market.ticker}`,
    closesAt: Number.isFinite(closesAtMs) ? closesAtMs : 0,
    category: category || '',
    source: 'MARKET_SOURCE_KALSHI' as MarketSource,
  };
}

/** Fetch open markets from the Kalshi API. Returns null on failure. */
async function fetchKalshiMarkets(): Promise<PredictionMarket[] | null> {
  if (!KALSHI_ENABLED) return null;
  try {
    const result = await cachedFetchJson<PredictionMarket[]>(
      KALSHI_CACHE_KEY,
      REDIS_CACHE_TTL,
      async () => {
        const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': CHROME_UA };
        if (KALSHI_API_KEY) headers.Authorization = `Bearer ${KALSHI_API_KEY}`;
        const response = await fetch(
          `${KALSHI_BASE}/events?status=open&with_nested_markets=true&limit=40`,
          {
            headers,
            signal: AbortSignal.timeout(FETCH_TIMEOUT),
          },
        );
        if (!response.ok) return null;

        const data = (await response.json()) as { events: KalshiEvent[]; cursor: string };
        const markets: PredictionMarket[] = [];
        for (const event of data.events) {
          if (!event.markets) continue;
          if (isExcluded(event.title)) continue;
          let topMarket: KalshiMarket | null = null;
          let topVol = 0;
          for (const m of event.markets) {
            if (m.market_type !== 'binary' || m.status !== 'active') continue;
            const vol = parseFloat(m.volume_fp || '0');
            if (vol > topVol) { topMarket = m; topVol = vol; }
          }
          if (topMarket && topVol > KALSHI_VOLUME_THRESHOLD) {
            markets.push(mapKalshiMarket(topMarket, event.category || '', event.title));
          }
        }
        return markets.length > 0 ? markets : null;
      },
    );
    return result || null;
  } catch {
    return null;
  }
}

// ---------- RPC ----------

export const listPredictionMarkets: PredictionServiceHandler['listPredictionMarkets'] = async (
  _ctx: ServerContext,
  req: ListPredictionMarketsRequest,
): Promise<ListPredictionMarketsResponse> => {
  try {
    const category = (req.category || '').slice(0, 50);
    const query = (req.query || '').slice(0, 100);
    const limit = clampInt(req.pageSize, 50, 1, 100);

    const bootstrap = await getCachedJson(BOOTSTRAP_KEY) as BootstrapData | null;
    if (!bootstrap) return { markets: [], pagination: undefined };

    const isTech = category && TECH_CATEGORY_TAGS.includes(category);
    const isFinance = !isTech && category && FINANCE_CATEGORY_TAGS.includes(category);
    const variant = isTech ? bootstrap.tech
      : isFinance ? (bootstrap.finance ?? bootstrap.geopolitical)
      : bootstrap.geopolitical;

    if (!variant || variant.length === 0) return { markets: [], pagination: undefined };

    let markets = variant.map((m) => toProtoMarket(m, category));

    if (query) {
      const q = query.toLowerCase();
      markets = markets.filter((m) => m.title.toLowerCase().includes(q));
    }

    return { markets: markets.slice(0, limit), pagination: undefined };
  } catch {
    return { markets: [], pagination: undefined };
  }
};
