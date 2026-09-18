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
const { getDb, admin } = require('../firebase');

const PIONEX_BASE_URL = 'https://api.pionex.com';

// --- Synchronisation automatique vers le grand livre (transactions) ---
//
// Le bot Pionex encaisse du profit réalisé (gridProfit) en continu, mais
// jusqu'ici il fallait le relever à la main sur l'app Pionex et le saisir
// dans l'Excel avant import. Ici on transforme la VARIATION du profit
// réalisé depuis le dernier relevé en une transaction automatique.
//
// Choix volontaire : on synchronise gridProfit (profit RÉALISÉ, encaissé
// par le bot à chaque paire d'ordres bouclée), pas currentProfit (qui
// inclut la part flottante liée au prix du BTC et peut remonter/redescendre
// sans raison comptable - l'enregistrer créerait des transactions qui se
// contrediraient d'un relevé à l'autre). currentProfit reste visible en
// direct sur le widget, mais ne génère jamais de transaction.
//
// Déclenchement : pas de vrai cron (le service Render gratuit s'endort),
// on vérifie plutôt à chaque appel de /grid-bot/status si au moins
// SYNC_MIN_INTERVAL_MS se sont écoulés depuis le dernier relevé - donc ça
// se déclenche naturellement dès qu'une page consultant le widget réveille
// le serveur, avec un espacement mini de 2 jours entre deux transactions.
const SYNC_MIN_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000; // 2 jours
const USD_TO_FCFA = 600; // même taux fixe que les données déjà importées
const SYNC_STATE_DOC = 'grid_bot_trading_compte1';
const SYNC_COMPANY_ID = 'abayili_invest_rc_trading';
const SYNC_EPSILON_USD = 0.01; // ignore le bruit flottant sous 1 centime

async function syncGridProfitToLedger(gridProfit) {
  const db = getDb();
  const stateRef = db.collection('pionex_sync_state').doc(SYNC_STATE_DOC);
  const stateDoc = await stateRef.get();
  const state = stateDoc.exists ? stateDoc.data() : null;

  const now = Date.now();
  const lastSyncedAt = state?.lastSyncedAt?._seconds ? state.lastSyncedAt._seconds * 1000 : 0;

  if (state && now - lastSyncedAt < SYNC_MIN_INTERVAL_MS) {
    return { synced: false, reason: 'trop tôt depuis le dernier relevé', nextSyncAt: new Date(lastSyncedAt + SYNC_MIN_INTERVAL_MS).toISOString() };
  }

  // Premier relevé jamais fait : on initialise la référence sans créer de
  // transaction (on ne connaît pas le profit réalisé avant le début du
  // suivi automatique - il est déjà couvert par les imports manuels passés).
  if (!state) {
    await stateRef.set({
      lastGridProfit: gridProfit,
      lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { synced: false, reason: 'premier relevé, référence initialisée' };
  }

  const delta = gridProfit - state.lastGridProfit;
  if (Math.abs(delta) < SYNC_EPSILON_USD) {
    await stateRef.update({ lastSyncedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { synced: false, reason: 'aucune variation significative' };
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const transaction = {
    companyId: SYNC_COMPANY_ID,
    type: delta >= 0 ? 'revenue' : 'expense',
    category: delta >= 0 ? 'Produits Financiers' : 'Charges Financières',
    amount: Math.round(Math.abs(delta) * USD_TO_FCFA),
    description: `[Sync auto Pionex] Variation du profit réalisé de la grille (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} USDT)`,
    date: todayStr,
    status: delta >= 0 ? 'validated' : 'pending',
    createdBy: 'pionex-auto-sync',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const docRef = await db.collection('transactions').add(transaction);

  await stateRef.update({
    lastGridProfit: gridProfit,
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { synced: true, transactionId: docRef.id, deltaUsd: delta, amountFcfa: transaction.amount };
}

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

    // Synchro auto (best-effort) : ne doit jamais faire échouer l'affichage
    // du widget si elle rate (index manquant, Firestore indisponible, etc.).
    try {
      payload.autoSync = await syncGridProfitToLedger(payload.gridProfit);
    } catch (syncError) {
      console.error('Erreur sync auto Pionex -> transactions:', syncError.message);
      payload.autoSync = { synced: false, reason: 'erreur technique', detail: syncError.message };
    }

    res.json(payload);
  } catch (error) {
    console.error('Erreur GET pionex grid-bot status:', error.message);
    res.status(502).json({ error: 'Impossible de récupérer les données Pionex', detail: error.message });
  }
});

module.exports = router;
