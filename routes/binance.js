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
const USD_TO_FCFA = 600; // même taux fixe que le reste de l'app
const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'TUSD']);

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function binanceSignedGet(path, params = {}) {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('BINANCE_API_KEY/BINANCE_API_SECRET non configurées');
  }
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 10000 }).toString();
  const signature = sign(query, apiSecret);
  const res = await fetch(`${BINANCE_BASE_URL}${path}?${query}&signature=${signature}`, {
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

module.exports = router;
