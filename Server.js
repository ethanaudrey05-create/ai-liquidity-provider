'use strict';

/**
 * AI Liquidity Provider - read-only MCP server (Streamable HTTP, stateless).
 * No dependencies. Requires Node 18+.
 *
 * Tools: search_orca_pools, get_token_info, check_token_risk,
 *        calculate_impermanent_loss, portfolio_risk, discover_new_tokens
 *
 * Data: DexScreener public API + Solana JSON-RPC. Nothing here holds keys
 * or moves funds.
 */

const http = require('http');

const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const DEX = 'https://api.dexscreener.com';
const SERVER_INFO = { name: 'ai-liquidity-provider', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DISCLAIMER =
  'Informational only. Not financial advice. Crypto and liquidity provision carry a high risk of loss.';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------- helpers ----------

async function getJson(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'ai-liquidity-provider-mcp/1.0',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(method, params) {
  const data = await getJson(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

function requireMint(value, name = 'mint') {
  if (typeof value !== 'string' || !BASE58.test(value.trim())) {
    throw new Error(`"${name}" must be a valid Solana address (base58).`);
  }
  return value.trim();
}

function round(n, digits = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function summarizePair(p) {
  const liq = p.liquidity && typeof p.liquidity.usd === 'number' ? p.liquidity.usd : null;
  const vol24 = p.volume && typeof p.volume.h24 === 'number' ? p.volume.h24 : null;
  return {
    pair_address: p.pairAddress,
    dex: p.dexId,
    base: p.baseToken ? { symbol: p.baseToken.symbol, address: p.baseToken.address } : null,
    quote: p.quoteToken ? { symbol: p.quoteToken.symbol, address: p.quoteToken.address } : null,
    price_usd: p.priceUsd ?? null,
    liquidity_usd: liq,
    volume_24h_usd: vol24,
    price_change_24h_pct: p.priceChange ? p.priceChange.h24 ?? null : null,
    volume_to_liquidity_24h: liq && vol24 !== null ? round(vol24 / liq, 3) : null,
    age_hours: p.pairCreatedAt ? round((Date.now() - p.pairCreatedAt) / 3600000, 1) : null,
    url: p.url ?? null,
  };
}

function byLiquidityDesc(a, b) {
  return ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0);
}

async function pairsForToken(mint) {
  const data = await getJson(`${DEX}/token-pairs/v1/solana/${mint}`);
  return Array.isArray(data) ? data : [];
}

// ---------- tools ----------

const tools = [
  {
    name: 'search_orca_pools',
    description:
      'Search Orca liquidity pools on Solana by token name, symbol or address. Returns liquidity, 24h volume, price change and a volume-to-liquidity ratio (a rough activity indicator, not a yield figure).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Token name, symbol or address, e.g. "SOL/USDC"' },
        min_liquidity_usd: { type: 'number', description: 'Minimum pool liquidity in USD (default 10000)' },
        limit: { type: 'integer', description: 'Max results (1-20, default 10)' },
      },
      required: ['query'],
    },
    async run(args) {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('"query" is required.');
      const min = typeof args.min_liquidity_usd === 'number' ? args.min_liquidity_usd : 10000;
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 20);
      const data = await getJson(`${DEX}/latest/dex/search?q=${encodeURIComponent(args.query.trim())}`);
      const pairs = (data.pairs || [])
        .filter((p) => p.chainId === 'solana' && p.dexId === 'orca')
        .filter((p) => ((p.liquidity && p.liquidity.usd) || 0) >= min)
        .sort(byLiquidityDesc)
        .slice(0, limit)
        .map(summarizePair);
      return { query: args.query, count: pairs.length, pools: pairs };
    },
  },
  {
    name: 'get_token_info',
    description:
      'Get trading pairs, price, liquidity and volume for a Solana token mint address (all DEXes, sorted by liquidity).',
    inputSchema: {
      type: 'object',
      properties: {
        mint: { type: 'string', description: 'Solana token mint address' },
        limit: { type: 'integer', description: 'Max pairs (1-10, default 5)' },
      },
      required: ['mint'],
    },
    async run(args) {
      const mint = requireMint(args.mint);
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 10);
      const pairs = (await pairsForToken(mint)).sort(byLiquidityDesc).slice(0, limit).map(summarizePair);
      return { mint, pair_count: pairs.length, pairs };
    },
  },
  {
    name: 'check_token_risk',
    description:
      'Heuristic risk screen for a Solana token: mint authority, freeze authority, holder concentration, liquidity and pair age. Flags common rug-pull warning signs. A low score does not mean a token is safe.',
    inputSchema: {
      type: 'object',
      properties: { mint: { type: 'string', description: 'Solana token mint address' } },
      required: ['mint'],
    },
    async run(args) {
      const mint = requireMint(args.mint);
      const flags = [];
      let points = 0;
      const notes = [];

      // On-chain mint info
      let mintInfo = null;
      try {
        const acc = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
        const info = acc && acc.value && acc.value.data && acc.value.data.parsed && acc.value.data.parsed.info;
        if (info) {
          mintInfo = {
            decimals: info.decimals,
            supply: info.supply,
            mint_authority: info.mintAuthority ?? null,
            freeze_authority: info.freezeAuthority ?? null,
          };
          if (info.mintAuthority) {
            flags.push('Mint authority is still active: supply can be increased.');
            points += 2;
          }
          if (info.freezeAuthority) {
            flags.push('Freeze authority is active: token accounts can be frozen.');
            points += 2;
          }
        } else {
          notes.push('Could not read mint account (not a token mint, or RPC returned no data).');
        }
      } catch (e) {
        notes.push(`Mint lookup failed: ${e.message}`);
      }

      // Holder concentration (includes pool/program accounts, so treat as a rough signal)
      let holders = null;
      try {
        if (mintInfo) {
          const largest = await rpc('getTokenLargestAccounts', [mint]);
          const total = Number(mintInfo.supply);
          const list = (largest.value || []).map((a) => Number(a.amount));
          if (total > 0 && list.length) {
            const top1 = (list[0] / total) * 100;
            const top10 = (list.slice(0, 10).reduce((s, v) => s + v, 0) / total) * 100;
            holders = { top1_pct: round(top1), top10_pct: round(top10) };
            if (top1 > 30) {
              flags.push(`Largest account holds ${round(top1)}% of supply.`);
              points += 2;
            }
            if (top10 > 80) {
              flags.push(`Top 10 accounts hold ${round(top10)}% of supply.`);
              points += 1;
            }
            notes.push('Holder percentages include liquidity pool and program accounts.');
          }
        }
      } catch (e) {
        notes.push(`Holder lookup failed: ${e.message}`);
      }

      // Market data
      let market = null;
      try {
        const pairs = (await pairsForToken(mint)).sort(byLiquidityDesc);
        if (!pairs.length) {
          flags.push('No trading pairs found.');
          points += 3;
        } else {
          const best = pairs[0];
          const liq = (best.liquidity && best.liquidity.usd) || 0;
          const ageH = best.pairCreatedAt ? (Date.now() - best.pairCreatedAt) / 3600000 : null;
          market = {
            top_pair: summarizePair(best),
            total_liquidity_usd: round(pairs.reduce((s, p) => s + ((p.liquidity && p.liquidity.usd) || 0), 0)),
            pair_count: pairs.length,
          };
          if (liq < 10000) {
            flags.push(`Very low liquidity ($${round(liq, 0)}).`);
            points += 3;
          } else if (liq < 50000) {
            flags.push(`Low liquidity ($${round(liq, 0)}).`);
            points += 1;
          }
          if (ageH !== null && ageH < 24) {
            flags.push(`Very new pair (${round(ageH, 1)} hours old).`);
            points += 2;
          }
        }
      } catch (e) {
        notes.push(`Market lookup failed: ${e.message}`);
      }

      const level = points >= 5 ? 'high' : points >= 2 ? 'medium' : 'low';
      return {
        mint,
        risk_level: level,
        risk_points: points,
        flags,
        mint_info: mintInfo,
        holder_concentration: holders,
        market,
        notes,
        caveat:
          'Heuristic only. It cannot detect every scam (e.g. honeypot contracts, hidden holder wallets, unlockable LP).',
      };
    },
  },
  {
    name: 'calculate_impermanent_loss',
    description:
      'Calculate impermanent loss for a standard constant-product (50/50) pool given the price change of one asset relative to the other. Concentrated liquidity positions (e.g. Orca Whirlpools) can lose more or less within their range.',
    inputSchema: {
      type: 'object',
      properties: {
        price_change_pct: {
          type: 'number',
          description: 'Price change of asset A versus asset B in percent, e.g. 50 for +50%, -30 for -30%',
        },
        initial_value_usd: { type: 'number', description: 'Optional starting deposit value in USD' },
      },
      required: ['price_change_pct'],
    },
    async run(args) {
      const pct = Number(args.price_change_pct);
      if (!Number.isFinite(pct) || pct <= -100) throw new Error('"price_change_pct" must be a number greater than -100.');
      const r = 1 + pct / 100;
      const il = (2 * Math.sqrt(r)) / (1 + r) - 1; // negative number
      const out = {
        price_change_pct: pct,
        impermanent_loss_pct: round(il * 100, 3),
        note: 'Compared with simply holding both assets. Trading fees earned are not included.',
      };
      const v = Number(args.initial_value_usd);
      if (Number.isFinite(v) && v > 0) {
        const hold = (v / 2) * (1 + r);
        const lp = hold * (1 + il);
        out.initial_value_usd = v;
        out.value_if_held_usd = round(hold);
        out.value_in_pool_before_fees_usd = round(lp);
        out.loss_vs_hold_usd = round(lp - hold);
      }
      return out;
    },
  },
  {
    name: 'portfolio_risk',
    description:
      'Analyze concentration risk for a list of positions you provide (symbol and USD value). Does not access any wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        positions: {
          type: 'array',
          description: 'List of positions',
          items: {
            type: 'object',
            properties: {
              symbol: { type: 'string' },
              value_usd: { type: 'number' },
            },
            required: ['symbol', 'value_usd'],
          },
        },
      },
      required: ['positions'],
    },
    async run(args) {
      if (!Array.isArray(args.positions) || !args.positions.length) throw new Error('"positions" must be a non-empty array.');
      const clean = args.positions.map((p, i) => {
        const v = Number(p && p.value_usd);
        if (!p || typeof p.symbol !== 'string' || !Number.isFinite(v) || v < 0) {
          throw new Error(`positions[${i}] needs a "symbol" and a non-negative "value_usd".`);
        }
        return { symbol: p.symbol, value: v };
      });
      const total = clean.reduce((s, p) => s + p.value, 0);
      if (total <= 0) throw new Error('Total portfolio value must be greater than 0.');
      const weights = clean
        .map((p) => ({ symbol: p.symbol, value_usd: round(p.value), weight_pct: round((p.value / total) * 100) }))
        .sort((a, b) => b.weight_pct - a.weight_pct);
      const hhi = clean.reduce((s, p) => s + (p.value / total) ** 2, 0);
      const flags = [];
      if (weights[0].weight_pct > 50) flags.push(`${weights[0].symbol} is ${weights[0].weight_pct}% of the portfolio.`);
      if (clean.length < 3) flags.push('Fewer than 3 positions: little diversification.');
      return {
        total_value_usd: round(total),
        position_count: clean.length,
        weights,
        concentration_index_hhi: round(hhi, 3),
        concentration_level: hhi > 0.5 ? 'high' : hhi > 0.25 ? 'medium' : 'low',
        flags,
      };
    },
  },
  {
    name: 'discover_new_tokens',
    description:
      'List Solana tokens whose profiles were recently published on DexScreener, filtered by minimum liquidity. These are newly listed, not necessarily trending, and most new tokens are high risk.',
    inputSchema: {
      type: 'object',
      properties: {
        min_liquidity_usd: { type: 'number', description: 'Minimum liquidity in USD (default 50000)' },
        limit: { type: 'integer', description: 'Max results (1-15, default 8)' },
      },
    },
    async run(args) {
      const min = typeof args.min_liquidity_usd === 'number' ? args.min_liquidity_usd : 50000;
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 15);
      const profiles = await getJson(`${DEX}/token-profiles/latest/v1`);
      const sol = (Array.isArray(profiles) ? profiles : [])
        .filter((p) => p.chainId === 'solana' && BASE58.test(p.tokenAddress || ''))
        .slice(0, 20);
      const results = await Promise.allSettled(sol.map((p) => pairsForToken(p.tokenAddress)));
      const found = [];
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled' || !r.value.length) return;
        const best = r.value.sort(byLiquidityDesc)[0];
        if (((best.liquidity && best.liquidity.usd) || 0) < min) return;
        found.push({ ...summarizePair(best), token_address: sol[i].tokenAddress, profile_url: sol[i].url ?? null });
      });
      found.sort((a, b) => (b.liquidity_usd || 0) - (a.liquidity_usd || 0));
      return {
        min_liquidity_usd: min,
        count: Math.min(found.length, limit),
        tokens: found.slice(0, limit),
        warning: 'New tokens are high risk. Run check_token_risk before acting.',
      };
    },
  },
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

// ---------- JSON-RPC / MCP ----------

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, -32600, 'Invalid Request');
  }
  const isNotification = msg.id === undefined;
  if (isNotification) return null; // e.g. notifications/initialized

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params && msg.params.protocolVersion;
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Read-only liquidity, risk and token screening tools for Solana/Orca. This server never holds keys or executes transactions. ' +
            DISCLAIMER,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      };
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const tool = toolMap.get(name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await tool.run((msg.params && msg.params.arguments) || {});
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ ...result, disclaimer: DISCLAIMER }, null, 2) }] },
        };
      } catch (e) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
        };
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// ---------- HTTP server ----------

function send(res, status, body, extra = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type, accept, mcp-session-id, mcp-protocol-version, authorization',
    ...extra,
  });
  res.end(payload);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') return send(res, 204);

  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    return send(res, 200, { status: 'ok', server: SERVER_INFO, mcp_endpoint: '/mcp', tools: tools.map((t) => t.name) });
  }

  if (path === '/mcp') {
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST for MCP requests.' }, { allow: 'POST' });
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, 400, rpcError(null, -32700, 'Parse error'));
    }
    if (Array.isArray(parsed)) {
      const out = (await Promise.all(parsed.map(handleMessage))).filter(Boolean);
      return out.length ? send(res, 200, out) : send(res, 202);
    }
    const out = await handleMessage(parsed);
    return out ? send(res, 200, out) : send(res, 202);
  }

  return send(res, 404, { error: 'Not found' });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`MCP server listening on port ${PORT} (POST /mcp)`));
}

module.exports = { server, handleMessage, tools };
