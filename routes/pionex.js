/**
 * Routes API - Pionex (bot de trading en grille Réseau Cryptos - Trading)
 *
 * Calcule un PnL dynamique du bot en direct : la valeur actuelle de la
 * position (BTC détenu converti au prix du marché + USDT en attente) moins
 * l'investissement initial, exactement comme l'affiche l'app Pionex.
 * Formule vérifiée le 2026-09-17 contre une capture d'écran réelle (-7,40
 * USDT retombé exactement).
 *
 * La clé API Pionex (permission "Bot Reading" uniquement, lecture seule) et
 * l'identifiant du bot vivent UNIQUEMENT dans les variables d'environnement
 * du serveur (PIONEX_API_KEY, PIONEX_API_SECRET, PIONEX_BOT_ORDER_ID) -
 * jamais envoyées au frontend, jamais committées.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const PIONEX_BASE_URL = 'https://api.pionex.com';

function sign(method, path, params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const queryString = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
  const pathUrl = `${path}?${queryString}`;
  const strToSign = `${method}${pathUrl}`;
  const signature = crypto.createHmac('sha256', secret).update(strToSign).digest('hex');
  return { queryString, signature };
}

async function pionexPrivateGet(path, params) {
  const apiKey = process.env.PIONEX_API_KEY;
  const apiSecret = process.env.PIONEX_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('PIONEX_API_KEY/PIONEX_API_SECRET non configurées');
  }
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const { queryString, signature } = sign('GET', path, allParams, apiSecret);
  const res = await fetch(`${PIONEX_BASE_URL}${path}?${queryString}`, {
    headers: { 'PIONEX-KEY': apiKey, 'PIONEX-SIGNATURE': signature },
  });
  const body = await res.json();
  if (!body.result) {
    throw new Error(`Pionex API: ${body.message || body.code || 'erreur inconnue'}`);
  }
  return body;
}

async function pionexPublicGet(path, params) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${PIONEX_BASE_URL}${path}?${query}`);
  return res.json();
}

// Cache mémoire très court (60s) : évite de solliciter Pionex à chaque
// re-render, et lisse un éventuel taux de limitation de leur API.
let cache = { data: null, expiresAt: 0 };
const CACHE_TTL_MS = 60_000;

// GET /api/pionex/grid-bot/status - Etat live du bot Réseau Cryptos - Trading
router.get('/grid-bot/status', async (req, res) => {
  try {
    if (cache.data && Date.now() < cache.expiresAt) {
      return res.json(cache.data);
    }

    const buOrderId = process.env.PIONEX_BOT_ORDER_ID;
    if (!buOrderId) {
      return res.status(503).json({ error: 'PIONEX_BOT_ORDER_ID non configuré' });
    }

    const [orderRes, tickerRes] = await Promise.all([
      pionexPrivateGet('/api/v1/bot/orders/spotGrid/order', { buOrderId }),
      pionexPublicGet('/api/v1/market/tickers', { symbol: 'BTC_USDT' }),
    ]);

    const d = orderRes.data.buOrderData;
    const btcPrice = parseFloat(tickerRes.data.tickers[0].close);
    const baseAmount = parseFloat(d.baseAmount);
    const quoteAmount = parseFloat(d.quoteAmount);
    const investment = parseFloat(d.quoteTotalInvestment);
    const currentValue = baseAmount * btcPrice + quoteAmount;
    const currentProfit = currentValue - investment;

    const payload = {
      buOrderId,
      btcPrice,
      investment,
      currentValue,
      currentProfit,
      currentProfitPct: investment > 0 ? (currentProfit / investment) * 100 : 0,
      gridProfit: parseFloat(d.gridProfit),
      realizedProfit: parseFloat(d.realizedProfit),
      baseAmount,
      quoteAmount,
      gridRange: { top: parseFloat(d.top), bottom: parseFloat(d.bottom), rows: d.row },
      pairedOrderCount: d.exchangeOrderPairedCount,
      createdAt: d.createTime,
      fetchedAt: new Date().toISOString(),
    };

    cache = { data: payload, expiresAt: Date.now() + CACHE_TTL_MS };
    res.json(payload);
  } catch (error) {
    console.error('Erreur GET pionex grid-bot status:', error.message);
    res.status(502).json({ error: 'Impossible de récupérer les données Pionex', detail: error.message });
  }
});

module.exports = router;
