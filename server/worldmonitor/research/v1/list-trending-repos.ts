/**
 * RPC: listTrendingRepos
 *
 * Fetches trending GitHub repos from OSSInsight API (PingCAP-backed)
 * with GitHub Search API fallback. Returns empty array on any failure.
 */

import type {
  ServerContext,
  ListTrendingReposRequest,
  ListTrendingReposResponse,
  GithubRepo,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';

import { CHROME_UA, clampInt } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'research:trending:v1';
const REDIS_CACHE_TTL = 3600; // 1 hr — daily trending data

const OSSINSIGHT_LANG: Record<string, string> = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript',
  go: 'Go', rust: 'Rust', java: 'Java', 'c++': 'C++', c: 'C',
};

const OSSINSIGHT_PERIOD: Record<string, string> = {
  daily: 'past_24_hours', weekly: 'past_week', monthly: 'past_month',
};

// ---------- Fetch ----------

async function fetchFromOSSInsight(language: string, period: string, pageSize: number): Promise<GithubRepo[] | null> {
  const ossLang = OSSINSIGHT_LANG[language] || language;
  const ossPeriod = OSSINSIGHT_PERIOD[period] || 'past_24_hours';
  const resp = await fetch(
    `https://api.ossinsight.io/v1/trends/repos/?language=${ossLang}&period=${ossPeriod}`,
    { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(10_000) },
  );
  if (!resp.ok) return null;
  const json = await resp.json() as any;
  const rows = json?.data?.rows;
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, pageSize).map((r: any): GithubRepo => ({
    fullName: r.repo_name || '', description: r.description || '',
    language: r.primary_language || language, stars: r.stars || 0,
    starsToday: 0, forks: r.forks || 0,
    url: r.repo_name ? `https://github.com/${r.repo_name}` : '',
  }));
}

const GH_SEARCH_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };

async function fetchFromGitHubSearch(language: string, period: string, pageSize: number): Promise<GithubRepo[] | null> {
  const days = GH_SEARCH_DAYS[period] || 7;
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const resp = await fetch(
    `https://api.github.com/search/repositories?q=language:${language}+created:>${since}&sort=stars&order=desc&per_page=${pageSize}`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(10_000) },
  );
  if (!resp.ok) return null;
  const data = await resp.json() as any;
  if (!Array.isArray(data?.items)) return null;
  return data.items.map((r: any): GithubRepo => ({
    fullName: r.full_name, description: r.description || '',
    language: r.language || '', stars: r.stargazers_count || 0,
    starsToday: 0, forks: r.forks_count || 0,
    url: r.html_url,
  }));
}

async function fetchTrendingRepos(req: ListTrendingReposRequest): Promise<GithubRepo[]> {
  const language = req.language || 'python';
  const period = req.period || 'daily';
  const pageSize = clampInt(req.pageSize, 50, 1, 100);

  try {
    const repos = await fetchFromOSSInsight(language, period, pageSize);
    if (repos && repos.length > 0) return repos;
  } catch { /* fall through */ }

  try {
    const repos = await fetchFromGitHubSearch(language, period, pageSize);
    if (repos && repos.length > 0) return repos;
  } catch { /* fall through */ }

  return [];
}

// ---------- Handler ----------

export async function listTrendingRepos(
  _ctx: ServerContext,
  req: ListTrendingReposRequest,
): Promise<ListTrendingReposResponse> {
  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${req.language || 'python'}:${req.period || 'daily'}:${clampInt(req.pageSize, 50, 1, 100)}`;
    const result = await cachedFetchJson<ListTrendingReposResponse>(cacheKey, REDIS_CACHE_TTL, async () => {
      const repos = await fetchTrendingRepos(req);
      return repos.length > 0 ? { repos, pagination: undefined } : null;
    });
    return result || { repos: [], pagination: undefined };
  } catch {
    return { repos: [], pagination: undefined };
  }
}
