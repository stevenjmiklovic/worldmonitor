#!/usr/bin/env node

/**
 * Seed USNI Fleet Tracker data to Redis.
 * Extracted from ais-relay.cjs to run as standalone cron with proxy support.
 * USNI's Cloudflare blocks Railway IPs (JA3 fingerprinting).
 *
 * Proxy: uses RESIDENTIAL_PROXY_AUTH (user:pass@host:port) for HTTP CONNECT tunnel.
 * Falls back to direct fetch if no proxy configured.
 */

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKey } from './_seed-utils.mjs';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'usni-fleet:sebuf:v1';
const STALE_KEY = 'usni-fleet:sebuf:stale:v1';
const TTL = 25200; // 7h (covers 6h cron interval + cold start)
const STALE_TTL = 604800; // 7 days
const USNI_URL = 'https://news.usni.org/wp-json/wp/v2/posts?categories=4137&per_page=1';

// ─── Proxy fetch ───

// Use curl for proxy — Node.js TLS fingerprint (JA3) gets blocked,
// but curl's fingerprint passes. Same pattern as relay's orefCurlFetch.
function fetchViaCurl(url, proxyAuth) {
  const args = ['-sS', '--compressed', '--max-time', '15',
    '-H', 'Accept: application/json', '-H', `User-Agent: ${CHROME_UA}`];
  if (proxyAuth) args.push('-x', `http://${proxyAuth}`);
  args.push(url);
  const result = execFileSync('curl', args, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(result);
}

function fetchDirect(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', 'Accept-Encoding': 'gzip' },
      timeout: 15000,
    }, (resp) => {
      const chunks = [];
      const stream = resp.headers['content-encoding'] === 'gzip' ? resp.pipe(zlib.createGunzip()) : resp;
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const trimmed = body.trimStart().toLowerCase();
        if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
          reject(new Error('Cloudflare block (HTML response)'));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed (direct): ${e.message}`)); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Direct fetch timeout')); });
  });
}

function fetchViaHttpProxy(url, proxyAuth) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(`http://${proxyAuth}`);
    const targetUrl = new URL(url);

    const connectReq = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || 3128,
      method: 'CONNECT',
      path: `${targetUrl.hostname}:443`,
      headers: proxyUrl.username
        ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64') }
        : {},
      timeout: 15000,
    });

    connectReq.on('connect', (_res, socket) => {
      const req = https.get(url, {
        socket,
        headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', 'Accept-Encoding': 'gzip' },
        timeout: 15000,
      }, (resp) => {
        const chunks = [];
        const stream = resp.headers['content-encoding'] === 'gzip' ? resp.pipe(zlib.createGunzip()) : resp;
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          const trimmed = body.trimStart().toLowerCase();
          if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
            reject(new Error('Cloudflare block via proxy (HTML response)'));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse failed (proxy): ${e.message}`)); }
        });
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Proxy fetch timeout')); });
    });

    connectReq.on('error', (e) => reject(new Error(`HTTP CONNECT failed: ${e.message}`)));
    connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('Proxy connect timeout')); });
    connectReq.end();
  });
}

// ─── USNI parsing (ported from ais-relay.cjs) ───

const HULL_TYPE_MAP = {
  CVN: 'carrier', CV: 'carrier',
  DDG: 'destroyer', CG: 'destroyer',
  LHD: 'amphibious', LHA: 'amphibious', LPD: 'amphibious', LSD: 'amphibious', LCC: 'amphibious',
  SSN: 'submarine', SSBN: 'submarine', SSGN: 'submarine',
  FFG: 'frigate', LCS: 'frigate',
  MCM: 'patrol', PC: 'patrol',
  AS: 'auxiliary', ESB: 'auxiliary', ESD: 'auxiliary',
  'T-AO': 'auxiliary', 'T-AKE': 'auxiliary', 'T-AOE': 'auxiliary',
  'T-ARS': 'auxiliary', 'T-ESB': 'auxiliary', 'T-EPF': 'auxiliary',
  'T-AGOS': 'research', 'T-AGS': 'research', 'T-AGM': 'research', AGOS: 'research',
};

const REGION_COORDS = {
  'Philippine Sea': { lat: 18.0, lon: 130.0 }, 'South China Sea': { lat: 14.0, lon: 115.0 },
  'East China Sea': { lat: 28.0, lon: 125.0 }, 'Sea of Japan': { lat: 40.0, lon: 135.0 },
  'Arabian Sea': { lat: 18.0, lon: 63.0 }, 'Red Sea': { lat: 20.0, lon: 38.0 },
  'Mediterranean Sea': { lat: 35.0, lon: 18.0 }, 'Eastern Mediterranean': { lat: 34.5, lon: 33.0 },
  'Western Mediterranean': { lat: 37.0, lon: 3.0 }, 'Persian Gulf': { lat: 26.5, lon: 52.0 },
  'Gulf of Oman': { lat: 24.5, lon: 58.5 }, 'Gulf of Aden': { lat: 12.0, lon: 47.0 },
  'Caribbean Sea': { lat: 15.0, lon: -73.0 }, 'North Atlantic': { lat: 45.0, lon: -30.0 },
  'Atlantic Ocean': { lat: 30.0, lon: -40.0 }, 'Western Atlantic': { lat: 30.0, lon: -60.0 },
  'Pacific Ocean': { lat: 20.0, lon: -150.0 }, 'Eastern Pacific': { lat: 18.0, lon: -125.0 },
  'Western Pacific': { lat: 20.0, lon: 140.0 }, 'Indian Ocean': { lat: -5.0, lon: 75.0 },
  Antarctic: { lat: -70.0, lon: 20.0 }, 'Baltic Sea': { lat: 58.0, lon: 20.0 },
  'Black Sea': { lat: 43.5, lon: 34.0 }, 'Bay of Bengal': { lat: 14.0, lon: 87.0 },
  Yokosuka: { lat: 35.29, lon: 139.67 }, Japan: { lat: 35.29, lon: 139.67 },
  Sasebo: { lat: 33.16, lon: 129.72 }, Guam: { lat: 13.45, lon: 144.79 },
  'Pearl Harbor': { lat: 21.35, lon: -157.95 }, 'San Diego': { lat: 32.68, lon: -117.15 },
  Norfolk: { lat: 36.95, lon: -76.30 }, Mayport: { lat: 30.39, lon: -81.40 },
  Bahrain: { lat: 26.23, lon: 50.55 }, Rota: { lat: 36.63, lon: -6.35 },
  'Diego Garcia': { lat: -7.32, lon: 72.42 }, Djibouti: { lat: 11.55, lon: 43.15 },
  Singapore: { lat: 1.35, lon: 103.82 }, 'Souda Bay': { lat: 35.49, lon: 24.08 },
  Naples: { lat: 40.84, lon: 14.25 },
};

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"').replace(/&#8211;/g, '\u2013')
    .replace(/\s+/g, ' ').trim();
}

function hullToType(hull) {
  if (!hull) return 'unknown';
  for (const [prefix, type] of Object.entries(HULL_TYPE_MAP)) { if (hull.startsWith(prefix)) return type; }
  return 'unknown';
}

function detectStatus(text) {
  if (!text) return 'unknown';
  const l = text.toLowerCase();
  if (l.includes('deployed') || l.includes('deployment')) return 'deployed';
  if (l.includes('underway') || l.includes('transiting')) return 'underway';
  if (l.includes('homeport') || l.includes('in port') || l.includes('pierside')) return 'in-port';
  return 'unknown';
}

function extractHomePort(text) {
  const m = text.match(/homeported (?:at|in) ([^.,]+)/i);
  return m ? m[1].trim() : '';
}

function getRegionCoords(regionText) {
  const norm = regionText.replace(/^(In the|In|The)\s+/i, '').trim();
  if (REGION_COORDS[norm]) return REGION_COORDS[norm];
  const lower = norm.toLowerCase();
  for (const [key, coords] of Object.entries(REGION_COORDS)) {
    if (key.toLowerCase() === lower || lower.includes(key.toLowerCase())) return coords;
  }
  return null;
}

function parseLeadingInt(text) {
  const m = text.match(/\d{1,3}(?:,\d{3})*/);
  return m ? parseInt(m[0].replace(/,/g, ''), 10) : undefined;
}

function extractBattleForceSummary(tableHtml) {
  const rows = Array.from(tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
  if (rows.length < 2) return undefined;
  const headers = Array.from(rows[0][1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(m => stripHtml(m[1]).toLowerCase());
  const values = Array.from(rows[1][1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(m => parseLeadingInt(stripHtml(m[1])));
  const summary = { totalShips: 0, deployed: 0, underway: 0 };
  let matched = false;
  for (let i = 0; i < headers.length; i++) {
    const label = headers[i] || '';
    const val = values[i];
    if (!Number.isFinite(val)) continue;
    if (label.includes('battle force') || label.includes('total')) { summary.totalShips = val; matched = true; }
    else if (label.includes('deployed')) { summary.deployed = val; matched = true; }
    else if (label.includes('underway')) { summary.underway = val; matched = true; }
  }
  return matched ? summary : undefined;
}

function parseArticle(html, articleUrl, articleDate, articleTitle) {
  const warnings = [];
  const vessels = [];
  const vesselByKey = new Map();
  const strikeGroups = [];
  const regionsSet = new Set();

  let battleForceSummary;
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (tableMatch) battleForceSummary = extractBattleForceSummary(tableMatch[1]);

  const h2Parts = html.split(/<h2[^>]*>/i);
  for (let i = 1; i < h2Parts.length; i++) {
    const part = h2Parts[i];
    const h2End = part.indexOf('</h2>');
    if (h2End === -1) continue;
    const regionName = stripHtml(part.substring(0, h2End)).replace(/^(In the|In|The)\s+/i, '').trim();
    if (!regionName) continue;
    regionsSet.add(regionName);
    const coords = getRegionCoords(regionName);
    if (!coords) warnings.push(`Unknown region: "${regionName}"`);
    const regionLat = coords?.lat ?? 0;
    const regionLon = coords?.lon ?? 0;
    const regionContent = part.substring(h2End + 5);
    const h3Parts = regionContent.split(/<h3[^>]*>/i);
    let currentSG = null;
    for (let j = 0; j < h3Parts.length; j++) {
      const section = h3Parts[j];
      if (j > 0) {
        const h3End = section.indexOf('</h3>');
        if (h3End !== -1) {
          const sgName = stripHtml(section.substring(0, h3End));
          if (sgName) { currentSG = { name: sgName, carrier: '', airWing: '', destroyerSquadron: '', escorts: [] }; strikeGroups.push(currentSG); }
        }
      }
      const shipRegex = /(USS|USNS)\s+(?:<[^>]+>)?([^<(]+?)(?:<\/[^>]+>)?\s*\(([^)]+)\)/gi;
      let match;
      const sectionText = stripHtml(section);
      const deploymentStatus = detectStatus(sectionText);
      const homePort = extractHomePort(sectionText);
      const activityDesc = sectionText.length > 10 ? sectionText.substring(0, 200).trim() : '';
      while ((match = shipRegex.exec(section)) !== null) {
        const prefix = match[1].toUpperCase();
        const shipName = match[2].trim();
        const hullNumber = match[3].trim();
        const vesselType = hullToType(hullNumber);
        if (prefix === 'USS' && vesselType === 'carrier' && currentSG) currentSG.carrier = `USS ${shipName} (${hullNumber})`;
        if (currentSG) currentSG.escorts.push(`${prefix} ${shipName} (${hullNumber})`);
        const key = `${regionName}|${hullNumber.toUpperCase()}`;
        if (!vesselByKey.has(key)) {
          const v = { name: `${prefix} ${shipName}`, hullNumber, vesselType, region: regionName, regionLat, regionLon, deploymentStatus, homePort, strikeGroup: currentSG?.name || '', activityDescription: activityDesc, articleUrl, articleDate };
          vessels.push(v);
          vesselByKey.set(key, v);
        }
      }
    }
  }

  for (const sg of strikeGroups) {
    const wingMatch = html.match(new RegExp(sg.name + '[\\s\\S]{0,500}Carrier Air Wing\\s*(\\w+)', 'i'));
    if (wingMatch) sg.airWing = `Carrier Air Wing ${wingMatch[1]}`;
    const desronMatch = html.match(new RegExp(sg.name + '[\\s\\S]{0,500}Destroyer Squadron\\s*(\\w+)', 'i'));
    if (desronMatch) sg.destroyerSquadron = `Destroyer Squadron ${desronMatch[1]}`;
    sg.escorts = [...new Set(sg.escorts)];
  }

  return {
    articleUrl, articleDate, articleTitle,
    battleForceSummary: battleForceSummary || { totalShips: 0, deployed: 0, underway: 0 },
    vessels, strikeGroups, regions: [...regionsSet],
    parsingWarnings: warnings,
    timestamp: Date.now(),
  };
}

// ─── Main ───

async function fetchAll() {
  // Fallback chain: curl direct -> curl+proxy -> Node.js+proxy -> Node.js direct
  let wpData;
  const proxyAuth = process.env.RESIDENTIAL_PROXY_AUTH || process.env.OREF_PROXY_AUTH || '';

  // 1. Try curl direct (best TLS fingerprint for Cloudflare bypass)
  try {
    console.log('  Trying curl direct...');
    wpData = fetchViaCurl(USNI_URL, null);
  } catch (e) {
    console.warn(`  curl direct failed: ${e.message}`);
    wpData = null;
  }

  // 2. Try curl + residential proxy
  if (!wpData && proxyAuth) {
    try {
      const host = proxyAuth.substring(proxyAuth.lastIndexOf('@') + 1);
      console.log(`  Trying curl via proxy: ${host}`);
      wpData = fetchViaCurl(USNI_URL, proxyAuth);
    } catch (e) {
      console.warn(`  curl+proxy failed: ${e.message}`);
    }
  }

  // 3. Try Node.js + HTTP CONNECT proxy (no curl needed)
  if (!wpData && proxyAuth) {
    try {
      const host = proxyAuth.substring(proxyAuth.lastIndexOf('@') + 1);
      console.log(`  Trying Node.js via proxy: ${host}`);
      wpData = await fetchViaHttpProxy(USNI_URL, proxyAuth);
    } catch (e) {
      console.warn(`  Node.js+proxy failed: ${e.message}`);
    }
  }

  // 4. Try Node.js direct (last resort, likely Cloudflare blocked)
  if (!wpData) {
    try {
      console.log('  Trying Node.js direct...');
      wpData = await fetchDirect(USNI_URL);
    } catch (e) {
      throw new Error(`FETCH FAILED: ${e.message}`);
    }
  }

  if (!Array.isArray(wpData) || !wpData.length) throw new Error('No fleet tracker articles');

  const post = wpData[0];
  const articleUrl = post.link || `https://news.usni.org/?p=${post.id}`;
  const articleDate = post.date || new Date().toISOString();
  const articleTitle = stripHtml(post.title?.rendered || 'USNI Fleet Tracker');
  const htmlContent = post.content?.rendered || '';
  if (!htmlContent) throw new Error('Empty article content');

  const report = parseArticle(htmlContent, articleUrl, articleDate, articleTitle);
  console.log(`  ${report.vessels.length} vessels, ${report.strikeGroups.length} CSGs, ${report.regions.length} regions`);
  if (report.parsingWarnings.length > 0) console.warn('  Warnings:', report.parsingWarnings.join('; '));

  // Write stale backup before returning (runSeed calls process.exit after primary write)
  await writeExtraKey(STALE_KEY, report, STALE_TTL);

  return report;
}

function validate(data) {
  return Array.isArray(data?.vessels) && data.vessels.length > 0;
}

runSeed('military', 'usni-fleet', CANONICAL_KEY, fetchAll, {
  validateFn: validate,
  ttlSeconds: TTL,
  sourceVersion: 'usni-wp-json',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
