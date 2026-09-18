/**
 * Routes API - Portefeuille MetaMask (solde ETH en direct, Réseau Cryptos - Actifs)
 *
 * MetaMask n'est qu'une interface pour une adresse sur la blockchain
 * Ethereum - pas d'API "MetaMask" à proprement parler. On interroge donc
 * directement la blockchain via un noeud RPC public et gratuit (aucune clé
 * requise pour une lecture de solde). L'adresse est publique (pas un
 * secret), mais vit quand même en variable d'environnement (METAMASK_ADDRESS)
 * pour rester configurable sans toucher au code.
 *
 * Limite connue : ne remonte que l'ETH natif, pas les jetons ERC20 (USDC,
 * etc.) - ça demanderait un service d'indexation (Etherscan/Alchemy) avec
 * sa propre clé API, pas encore configuré.
 */

const express = require('express');
const router = express.Router();

// cloudflare-eth.com renvoyait une erreur interne pour cette adresse
// (constaté le 2026-09-18) - publicnode.com s'est montré fiable en test,
// avec un repli sur un deuxième noeud public si le premier échoue.
const ETH_RPC_URLS = ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'];

async function getEthBalanceWei(address) {
  let lastError;
  for (const url of ETH_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: [address, 'latest'], id: 1 }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
      return BigInt(body.result);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`RPC Ethereum: ${lastError?.message || 'tous les noeuds ont échoué'}`);
}

async function getEthPriceUsd() {
  const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
  const body = await res.json();
  return parseFloat(body.price);
}

let cache = { data: null, expiresAt: 0 };
const CACHE_TTL_MS = 60_000;

// GET /api/wallet/status - Solde ETH natif du wallet MetaMask, live
router.get('/status', async (req, res) => {
  try {
    if (cache.data && Date.now() < cache.expiresAt) {
      return res.json(cache.data);
    }

    const address = process.env.METAMASK_ADDRESS;
    if (!address) {
      return res.status(503).json({ error: 'METAMASK_ADDRESS non configurée' });
    }

    const [weiBalance, ethPrice] = await Promise.all([getEthBalanceWei(address), getEthPriceUsd()]);
    const ethBalance = Number(weiBalance) / 1e18;
    const usdValue = ethBalance * ethPrice;

    const payload = {
      address,
      ethBalance,
      ethPrice,
      usdValue,
      fcfaValue: usdValue * USD_TO_FCFA,
      note: 'Solde ETH natif uniquement - jetons ERC20 non inclus (nécessiterait une clé Etherscan)',
      fetchedAt: new Date().toISOString(),
    };

    cache = { data: payload, expiresAt: Date.now() + CACHE_TTL_MS };
    res.json(payload);
  } catch (error) {
    console.error('Erreur GET wallet status:', error.message);
    res.status(502).json({ error: 'Impossible de récupérer le solde du wallet', detail: error.message });
  }
});

module.exports = router;
