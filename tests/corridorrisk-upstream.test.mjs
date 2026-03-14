import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = readFileSync(resolve(root, 'server/worldmonitor/supply-chain/v1/_corridorrisk-upstream.ts'), 'utf-8');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf-8');

describe('CorridorRisk type exports', () => {
  it('exports CorridorRiskEntry interface', () => {
    assert.match(src, /export\s+interface\s+CorridorRiskEntry/);
  });

  it('exports CorridorRiskData interface', () => {
    assert.match(src, /export\s+interface\s+CorridorRiskData/);
  });

  it('does not contain fetch logic (moved to relay)', () => {
    assert.doesNotMatch(src, /cachedFetchJson/);
    assert.doesNotMatch(src, /getCorridorRiskData/);
    assert.doesNotMatch(src, /fetchCorridorRiskData/);
  });
});

describe('CorridorRisk relay seed loop', () => {
  it('reads CORRIDOR_RISK_API_KEY from env', () => {
    assert.match(relaySrc, /CORRIDOR_RISK_API_KEY.*process\.env\.CORRIDOR_RISK_API_KEY/);
  });

  it('uses corridorrisk.io API', () => {
    assert.match(relaySrc, /api\.corridorrisk\.io/);
  });

  it('uses Bearer token authentication', () => {
    assert.match(relaySrc, /Authorization.*Bearer.*CORRIDOR_RISK_API_KEY/);
  });

  it('writes to supply_chain:corridorrisk:v1 Redis key', () => {
    assert.match(relaySrc, /supply_chain:corridorrisk:v1/);
  });

  it('writes seed-meta for corridorrisk', () => {
    assert.match(relaySrc, /seed-meta:supply_chain:corridorrisk/);
  });

  it('defines startCorridorRiskSeedLoop', () => {
    assert.match(relaySrc, /function startCorridorRiskSeedLoop/);
  });

  it('skips when API key is not configured', () => {
    assert.match(relaySrc, /if\s*\(\s*!CORRIDOR_RISK_API_KEY\s*\)\s*return/);
  });

  it('uses 10s timeout', () => {
    assert.match(relaySrc, /AbortSignal\.timeout\(10000\)/);
  });

  it('logs only status code on HTTP error', () => {
    assert.match(relaySrc, /\[CorridorRisk\] HTTP \$\{resp\.status\}/);
  });
});
