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

// Un bannissement temporaire par Binance ("Way too much request weight used; IP banned
// until <timestamp>") dure jusqu'à une heure fixe, quel que soit le nombre de nouvelles
// tentatives entre-temps - les retenter ne fait que gaspiller des requêtes (et risque de
// prolonger le bannissement une fois levé). 429 plutôt que 502 : le client (voir
// RETRYABLE_STATUSES dans services/api.js du frontend) ne retente pas un 429, il affiche
// l'erreur directement au lieu de marteler l'API pendant ~1 minute pour rien.
function sendBinanceError(res, error, fallbackMessage) {
  console.error(fallbackMessage + ':', error.message);
  const banned = /banned/i.test(error.message);
  res.status(banned ? 429 : 502).json({
    error: banned ? 'Binance a temporairement limité ce serveur (trop de requêtes) - réessaie dans quelques minutes' : fallbackMessage,
    detail: error.message,
  });
}

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

// Cache mémoire, même logique que pour Pionex. Porté à 5 min le 2026-10-16 (était 2 min) :
// /status est désormais aussi appelé depuis Portefeuille Global (en plus de la page RC
// Actifs), et le cumul a déclenché un bannissement temporaire de l'IP par Binance ("Way
// too much request weight used") - un solde affiché n'a pas besoin d'être à la minute près.
let cache = { data: null, expiresAt: 0 };
const CACHE_TTL_MS = 300_000;

// GET /api/binance/status - Solde spot live, converti en $ et FCFA
//
// Correctif 2026-09-19 : la version précédente appelait /api/v3/ticker/price
// SANS filtre, qui renvoie le prix des ~3700 paires cotées sur Binance à
// chaque cache-miss - poids largement plus élevé que nécessaire pour
// afficher 1-2 actifs détenus. Ça a fait bannir temporairement l'IP du
// serveur par Binance ("Way too much request weight used"), cassant le
// widget. On ne demande désormais les prix QUE pour les actifs réellement
// détenus (paramètre `symbols`, poids proportionnel au nombre demandé).
router.get('/status', async (req, res) => {
  try {
    if (cache.data && Date.now() < cache.expiresAt) {
      return res.json(cache.data);
    }

    const account = await binanceSignedGet('/api/v3/account');
    const rawBalances = (account.balances || []).filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0);

    const symbolsNeeded = rawBalances
      .filter(b => !STABLECOINS.has(b.asset))
      .map(b => `${b.asset}USDT`);

    const priceMap = {};
    if (symbolsNeeded.length > 0) {
      const symbolsParam = encodeURIComponent(JSON.stringify(symbolsNeeded));
      const tickersRes = await fetch(`${BINANCE_BASE_URL}/api/v3/ticker/price?symbols=${symbolsParam}`);
      const tickers = await tickersRes.json();
      if (Array.isArray(tickers)) {
        tickers.forEach(t => { priceMap[t.symbol] = parseFloat(t.price); });
      }
      // Symbole sans marché direct vers USDT (ex: actif illiquide/délisté) -
      // ignoré silencieusement (usdValue à 0) plutôt que de faire échouer
      // tout le widget pour un seul actif marginal.
    }

    // Cash vs placement (demande 2026-10-15) : un stablecoin (USDT...) est accroché
    // 1:1 au dollar, sans exposition de marché - c'est de la liquidité, donc "cash".
    // Tout le reste (BTC, ETH...) varie avec le marché - c'est un "placement", au
    // même titre que les fonds FCP (gain/perte latent). isStablecoin par actif
    // permet au frontend d'afficher les deux sous-totaux séparément.
    let totalUsd = 0, cashUsd = 0, placementUsd = 0;
    const holdings = rawBalances.map(b => {
      const amount = parseFloat(b.free) + parseFloat(b.locked);
      const isStablecoin = STABLECOINS.has(b.asset);
      let usdValue;
      if (isStablecoin) {
        usdValue = amount;
      } else {
        const price = priceMap[`${b.asset}USDT`];
        usdValue = price ? amount * price : 0;
      }
      totalUsd += usdValue;
      if (isStablecoin) cashUsd += usdValue; else placementUsd += usdValue;
      return { asset: b.asset, amount, usdValue, isStablecoin };
    }).filter(h => h.usdValue > 0.01).sort((a, b) => b.usdValue - a.usdValue);

    const payload = {
      holdings,
      totalUsd,
      totalFcfa: totalUsd * USD_TO_FCFA,
      cashUsd,
      cashFcfa: cashUsd * USD_TO_FCFA,
      placementUsd,
      placementFcfa: placementUsd * USD_TO_FCFA,
      fetchedAt: new Date().toISOString(),
    };

    cache = { data: payload, expiresAt: Date.now() + CACHE_TTL_MS };
    res.json(payload);
  } catch (error) {
    sendBinanceError(res, error, 'Impossible de récupérer les données Binance');
  }
});

let futuresCache = { data: null, expiresAt: 0 };
// exchangeInfo liste les contrats et leurs échéances - quasi statique
// (change seulement au listage trimestriel d'un nouveau contrat), donc
// mis en cache bien plus longtemps que le reste (voir le correctif
// "poids de requête" du 2026-09-19 sur /status ci-dessus, même cause).
let exchangeInfoCache = { data: null, expiresAt: 0 };
const EXCHANGE_INFO_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function getFuturesExchangeInfo() {
  if (exchangeInfoCache.data && Date.now() < exchangeInfoCache.expiresAt) {
    return exchangeInfoCache.data;
  }
  const res = await fetch(`${BINANCE_FUTURES_URL}/fapi/v1/exchangeInfo`);
  const data = await res.json();
  exchangeInfoCache = { data, expiresAt: Date.now() + EXCHANGE_INFO_CACHE_TTL_MS };
  return data;
}

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

    const [positions, balances, exchangeInfo] = await Promise.all([
      binanceSignedGet('/fapi/v2/positionRisk', {}, BINANCE_FUTURES_URL),
      binanceSignedGet('/fapi/v2/balance', {}, BINANCE_FUTURES_URL),
      getFuturesExchangeInfo(),
    ]);
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
    sendBinanceError(res, error, 'Impossible de récupérer la position futures Binance');
  }
});

module.exports = router;
