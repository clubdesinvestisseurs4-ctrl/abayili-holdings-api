/**
 * Routes API - Binance (solde spot en direct, Réseau Cryptos - Actifs)
 *
 * Même principe que routes/pionex.js : clé API en lecture seule
 * uniquement (permission "Lire" activée, "Trading"/"Retraits" désactivés
 * côté Binance), vit uniquement dans les variables d'environnement du
 * serveur (BINANCE_API_KEY, BINANCE_API_SECRET) - jamais envoyée au
 * frontend, jamais committée.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const BINANCE_BASE_URL = 'https://api.binance.com';
const BINANCE_FUTURES_URL = 'https://fapi.binance.com';
const USD_TO_FCFA = 600; // même taux fixe que le reste de l'app
const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'TUSD']);

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function binanceSignedGet(path, params = {}, baseUrl = BINANCE_BASE_URL) {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('BINANCE_API_KEY/BINANCE_API_SECRET non configurées');
  }
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 10000 }).toString();
  const signature = sign(query, apiSecret);
  const res = await fetch(`${baseUrl}${path}?${query}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  const body = await res.json();
  if (body.code && body.code < 0) {
    throw new Error(`Binance API: ${body.msg || body.code}`);
  }
  return body;
}

// Cache mémoire court (60s), même logique que pour Pionex.
let cache = { data: null, expiresAt: 0 };
const CACHE_TTL_MS = 60_000;

// GET /api/binance/status - Solde spot live, converti en $ et FCFA
router.get('/status', async (req, res) => {
  try {
    if (cache.data && Date.now() < cache.expiresAt) {
      return res.json(cache.data);
    }

    const [account, tickersRes] = await Promise.all([
      binanceSignedGet('/api/v3/account'),
      fetch(`${BINANCE_BASE_URL}/api/v3/ticker/price`),
    ]);
    const tickers = await tickersRes.json();
    const priceMap = {};
    tickers.forEach(t => { priceMap[t.symbol] = parseFloat(t.price); });

    const rawBalances = (account.balances || []).filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0);
    let totalUsd = 0;
    const holdings = rawBalances.map(b => {
      const amount = parseFloat(b.free) + parseFloat(b.locked);
      let usdValue;
      if (STABLECOINS.has(b.asset)) {
        usdValue = amount;
      } else {
        const price = priceMap[`${b.asset}USDT`];
        usdValue = price ? amount * price : 0;
      }
      totalUsd += usdValue;
      return { asset: b.asset, amount, usdValue };
    }).filter(h => h.usdValue > 0.01).sort((a, b) => b.usdValue - a.usdValue);

    const payload = {
      holdings,
      totalUsd,
      totalFcfa: totalUsd * USD_TO_FCFA,
      fetchedAt: new Date().toISOString(),
    };

    cache = { data: payload, expiresAt: Date.now() + CACHE_TTL_MS };
    res.json(payload);
  } catch (error) {
    console.error('Erreur GET binance status:', error.message);
    res.status(502).json({ error: 'Impossible de récupérer les données Binance', detail: error.message });
  }
});

let futuresCache = { data: null, expiresAt: 0 };

// GET /api/binance/carry-status - Position(s) futures ouvertes + solde du
// wallet Futures, pour suivre le cash-and-carry (spot déjà couvert par
// /status ci-dessus - jambe futures via l'API USDⓈ-M, un compte Binance
// séparé du spot). Enrichit chaque position d'une échéance trimestrielle
// si le symbole en est une (ex: BTCUSDT_261225).
router.get('/carry-status', async (req, res) => {
  try {
    if (futuresCache.data && Date.now() < futuresCache.expiresAt) {
      return res.json(futuresCache.data);
    }

    const [positions, balances, exchangeInfoRes] = await Promise.all([
      binanceSignedGet('/fapi/v2/positionRisk', {}, BINANCE_FUTURES_URL),
      binanceSignedGet('/fapi/v2/balance', {}, BINANCE_FUTURES_URL),
      fetch(`${BINANCE_FUTURES_URL}/fapi/v1/exchangeInfo`),
    ]);
    const exchangeInfo = await exchangeInfoRes.json();
    const deliveryDateBySymbol = {};
    (exchangeInfo.symbols || []).forEach(s => { deliveryDateBySymbol[s.symbol] = s.deliveryDate; });

    const openPositions = (Array.isArray(positions) ? positions : [])
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => {
        const deliveryDate = deliveryDateBySymbol[p.symbol];
        const daysToExpiry = deliveryDate && deliveryDate > 0
          ? (deliveryDate - Date.now()) / (1000 * 60 * 60 * 24)
          : null;
        return {
          symbol: p.symbol,
          positionAmt: parseFloat(p.positionAmt),
          entryPrice: parseFloat(p.entryPrice),
          markPrice: parseFloat(p.markPrice),
          unrealizedProfit: parseFloat(p.unRealizedProfit ?? p.unrealizedProfit ?? 0),
          leverage: parseFloat(p.leverage),
          notionalUsd: Math.abs(parseFloat(p.notional || (p.positionAmt * p.markPrice))),
          daysToExpiry,
        };
      });

    const usdtBalance = (Array.isArray(balances) ? balances : []).find(b => b.asset === 'USDT');

    const payload = {
      positions: openPositions,
      futuresBalanceUsd: usdtBalance ? parseFloat(usdtBalance.balance) : 0,
      futuresAvailableUsd: usdtBalance ? parseFloat(usdtBalance.availableBalance) : 0,
      fetchedAt: new Date().toISOString(),
    };

    futuresCache = { data: payload, expiresAt: Date.now() + CACHE_TTL_MS };
    res.json(payload);
  } catch (error) {
    console.error('Erreur GET binance carry-status:', error.message);
    res.status(502).json({ error: 'Impossible de récupérer la position futures Binance', detail: error.message });
  }
});

module.exports = router;
