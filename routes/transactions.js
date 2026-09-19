/**
 * Routes API - Transactions
 * Avec support de navigation mensuelle
 */

const express = require('express');
const router = express.Router();
const { getDb, admin } = require('../firebase');

// Helper: Obtenir le mois courant au format YYYY-MM
const getCurrentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

// Helper: Formater une date en YYYY-MM
const formatMonth = (date) => {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

// Helper: Extraire le mois d'un budget (depuis month ou createdAt)
const getBudgetMonth = (budget) => {
  if (budget.month) {
    return budget.month;
  }
  
  if (budget.createdAt) {
    let date;
    if (budget.createdAt._seconds) {
      date = new Date(budget.createdAt._seconds * 1000);
    } else if (budget.createdAt.toDate) {
      date = budget.createdAt.toDate();
    } else {
      date = new Date(budget.createdAt);
    }
    return formatMonth(date);
  }
  
  return getCurrentMonth();
};

// Cache mémoire court pour la lecture "historique complet" (aucun filtre de
// mois/date) - optimisation 2026-09-19 : plusieurs widgets sur une même
// page (Rendement, Évolution, Relevés manuels, Portefeuille Global...)
// appellent chacun TransactionAPI.getAll(companyId) sans filtre en
// parallèle. Sans ce cache, chacun déclenchait son propre scan complet
// Firestore - sur une entité à 175+ transactions consultée par 3-4 widgets
// à la fois, ça remultiplie vite le coût qui avait déjà vidé le quota
// gratuit une fois. Invalidé explicitement à chaque écriture (POST/PUT/
// DELETE) sur l'entité concernée, en plus du TTL court.
const fullHistoryCache = new Map(); // companyId -> { data, expiresAt }
const FULL_HISTORY_CACHE_TTL_MS = 45_000;
function invalidateFullHistoryCache(companyId) {
  if (companyId) fullHistoryCache.delete(companyId);
}

// GET /api/transactions/:companyId - Liste des transactions
//
// Optimisation 2026-09-17 : l'ancienne version lisait TOUJOURS l'intégralité
// de l'historique d'une entité (`.where('companyId','==',companyId).get()`)
// puis filtrait par mois/date en mémoire - donc consulter un seul mois sur
// une entité qui a 175 transactions coûtait 175 lectures Firestore, à chaque
// chargement de page. C'est ce qui a vidé le quota gratuit quotidien en une
// journée. Le cas le plus fréquent (mois précis, ou plage de dates) filtre
// maintenant au niveau Firestore (index composite companyId+date requis,
// voir docs/firestore-indexes ou la console Firebase) - ne lit que les
// documents du mois demandé. Le cas "tout l'historique" (aucun filtre,
// utilisé par Total Global / Portefeuille Global / les widgets Rendement,
// Évolution, Relevés manuels) reste un scan complet mais passe maintenant
// par le cache court ci-dessus (voir 2026-09-19).
router.get('/:companyId', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const { type, status, month, startDate, endDate } = req.query;
    const isFullHistory = !month && !startDate && !endDate;

    let transactions;

    if (isFullHistory && fullHistoryCache.has(companyId) && Date.now() < fullHistoryCache.get(companyId).expiresAt) {
      transactions = fullHistoryCache.get(companyId).data;
    } else {
      let query = db.collection('transactions').where('companyId', '==', companyId);
      let usedIndexedRange = false;

      if (month) {
        // Bornes de date en string (format YYYY-MM-DD, comparable lexicalement)
        const [y, m] = month.split('-').map(Number);
        const startStr = `${month}-01`;
        const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
        const endStr = `${nextMonth}-01`;
        query = query.where('date', '>=', startStr).where('date', '<', endStr);
        usedIndexedRange = true;
      } else if (startDate || endDate) {
        if (startDate) query = query.where('date', '>=', startDate);
        if (endDate) query = query.where('date', '<=', endDate);
        usedIndexedRange = true;
      }

      try {
        const snapshot = await query.get();
        transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } catch (queryError) {
        // Repli automatique si l'index composite n'existe pas encore (Firestore
        // renvoie FAILED_PRECONDITION avec un lien pour le créer) - au moins la
        // page continue de fonctionner (comme avant) pendant que l'index se
        // construit, au prix du coût en lecture qu'on cherche justement à éviter.
        if (usedIndexedRange && queryError.code === 9 /* FAILED_PRECONDITION */) {
          console.warn('Index composite manquant pour transactions(companyId,date), repli sur lecture complète + filtre mémoire:', queryError.message);
          const snapshot = await db.collection('transactions').where('companyId', '==', companyId).get();
          transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          if (month) {
            transactions = transactions.filter(t => t.date && t.date.startsWith(month));
          } else {
            if (startDate) transactions = transactions.filter(t => t.date >= startDate);
            if (endDate) transactions = transactions.filter(t => t.date <= endDate);
          }
        } else {
          throw queryError;
        }
      }

      if (isFullHistory) {
        fullHistoryCache.set(companyId, { data: transactions, expiresAt: Date.now() + FULL_HISTORY_CACHE_TTL_MS });
      }
    }

    const usedIndexedRange = !isFullHistory;

    // Filtres additionnels (rarement combinés avec month/dates, faible volume)
    if (type) {
      transactions = transactions.filter(t => t.type === type);
    }
    if (status) {
      transactions = transactions.filter(t => t.status === status);
    }

    // Tri côté serveur (plus récent en premier)
    transactions.sort((a, b) => {
      const dateA = a.date || '';
      const dateB = b.date || '';
      return dateB.localeCompare(dateA);
    });

    // Limite de sécurité : généreuse pour une requête filtrée (déjà petite),
    // beaucoup plus haute pour une requête "historique complet" (Total
    // Global / Portefeuille Global).
    transactions = transactions.slice(0, usedIndexedRange ? 500 : 5000);

    res.json(transactions);
  } catch (error) {
    console.error('Erreur GET transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/transactions/:companyId/all-months - Liste de tous les mois avec transactions
// Réutilise le même cache "historique complet" que GET /:companyId - c'est
// un scan complet équivalent, pas la peine de payer deux fois le même coût.
router.get('/:companyId/all-months', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;

    let allTransactions;
    if (fullHistoryCache.has(companyId) && Date.now() < fullHistoryCache.get(companyId).expiresAt) {
      allTransactions = fullHistoryCache.get(companyId).data;
    } else {
      const snapshot = await db.collection('transactions').where('companyId', '==', companyId).get();
      allTransactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      fullHistoryCache.set(companyId, { data: allTransactions, expiresAt: Date.now() + FULL_HISTORY_CACHE_TTL_MS });
    }

    const months = new Set();
    allTransactions.forEach(t => {
      if (t.date) months.add(t.date.substring(0, 7));
    });

    // Trier les mois (plus récent en premier)
    const sortedMonths = Array.from(months).sort((a, b) => b.localeCompare(a));

    res.json(sortedMonths);
  } catch (error) {
    console.error('Erreur GET all-months transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/transactions - Créer une transaction
router.post('/', async (req, res) => {
  try {
    const db = getDb();
    const data = req.body;
    
    console.log('[POST transaction] Données reçues:', JSON.stringify(data, null, 2));
    
    // Définir le statut selon le type et le rôle
    let status = 'pending';
    if (data.type === 'revenue') {
      status = 'validated';
    } else if (req.user.role === 'admin_treasury') {
      status = 'validated';
    }

    const transaction = {
      ...data,
      status,
      createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('transactions').add(transaction);
    console.log('[POST transaction] Transaction créée:', docRef.id, 'status:', status);
    invalidateFullHistoryCache(data.companyId);

    // Mettre à jour le budget si validé
    if (status === 'validated') {
      // Extraire le mois de la date de la transaction
      const month = data.date ? data.date.substring(0, 7) : getCurrentMonth();
      console.log('[POST transaction] Mise à jour budget pour mois:', month);
      await updateBudgetSpent(data.companyId, data.category, data.type, data.amount, month);
    }

    res.status(201).json({ id: docRef.id, ...transaction, status });
  } catch (error) {
    console.error('Erreur POST transaction:', error);
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/transactions/:id/status - Valider/Rejeter
router.put('/:id/status', async (req, res) => {
  try {
    if (req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const db = getDb();
    const { id } = req.params;
    const { status } = req.body;

    if (!['validated', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }

    const transactionRef = db.collection('transactions').doc(id);
    const transaction = await transactionRef.get();

    if (!transaction.exists) {
      return res.status(404).json({ error: 'Transaction non trouvée' });
    }

    await transactionRef.update({
      status,
      validatedBy: req.user.uid,
      validatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    invalidateFullHistoryCache(transaction.data().companyId);

    // Mettre à jour le budget si validé
    if (status === 'validated') {
      const data = transaction.data();
      const month = data.date ? data.date.substring(0, 7) : getCurrentMonth();
      await updateBudgetSpent(data.companyId, data.category, data.type, data.amount, month);
    }

    res.json({ id, status });
  } catch (error) {
    console.error('Erreur PUT transaction status:', error);
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/transactions/:id - Modifier une transaction
router.put('/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const db = getDb();
    const { id } = req.params;
    const { type, category, amount, description, date } = req.body;

    const transactionRef = db.collection('transactions').doc(id);
    const transaction = await transactionRef.get();

    if (!transaction.exists) {
      return res.status(404).json({ error: 'Transaction non trouvée' });
    }

    const oldData = transaction.data();
    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Mettre à jour les champs fournis
    if (type !== undefined) updateData.type = type;
    if (category !== undefined) updateData.category = category;
    if (amount !== undefined) updateData.amount = parseFloat(amount);
    if (description !== undefined) updateData.description = description;
    if (date !== undefined) updateData.date = date;

    await transactionRef.update(updateData);
    invalidateFullHistoryCache(oldData.companyId);

    // Si la transaction était validée et que le montant/catégorie a changé,
    // on doit ajuster les budgets (soustraire l'ancien, ajouter le nouveau)
    if (oldData.status === 'validated') {
      const oldMonth = oldData.date ? oldData.date.substring(0, 7) : getCurrentMonth();
      const newMonth = (date || oldData.date).substring(0, 7);
      
      // Soustraire l'ancien montant du budget
      await updateBudgetSpent(oldData.companyId, oldData.category, oldData.type, -(oldData.amount || 0), oldMonth);
      
      // Ajouter le nouveau montant au budget
      const newCategory = category || oldData.category;
      const newType = type || oldData.type;
      const newAmount = amount !== undefined ? parseFloat(amount) : oldData.amount;
      await updateBudgetSpent(oldData.companyId, newCategory, newType, newAmount, newMonth);
    }

    console.log(`[PUT transaction] Transaction ${id} modifiée`);
    res.json({ id, success: true });
  } catch (error) {
    console.error('Erreur PUT transaction:', error);
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/transactions/:id - Supprimer
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    
    const transactionRef = db.collection('transactions').doc(id);
    const transaction = await transactionRef.get();
    
    if (!transaction.exists) {
      return res.status(404).json({ error: 'Transaction non trouvée' });
    }
    
    const data = transaction.data();
    
    // Si la transaction était validée, soustraire du budget
    if (data.status === 'validated' && data.amount) {
      const month = data.date ? data.date.substring(0, 7) : getCurrentMonth();
      await updateBudgetSpent(data.companyId, data.category, data.type, -(data.amount), month);
      console.log(`[DELETE transaction] Budget ajusté: -${data.amount} pour ${data.category}`);
    }
    
    await transactionRef.delete();
    console.log(`[DELETE transaction] Transaction ${id} supprimée`);
    invalidateFullHistoryCache(data.companyId);

    res.json({ success: true });
  } catch (error) {
    console.error('Erreur DELETE transaction:', error);
    res.status(400).json({ error: error.message });
  }
});

// Helper: Mettre à jour le budget (avec support du mois)
async function updateBudgetSpent(companyId, category, type, amount, month) {
  try {
    const db = getDb();
    
    console.log(`[updateBudgetSpent] Recherche budget: companyId=${companyId}, category=${category}, type=${type}, month=${month}`);
    
    // Chercher tous les budgets de cette entreprise et de ce type
    const budgetSnapshot = await db.collection('budgets')
      .where('companyId', '==', companyId)
      .where('type', '==', type)
      .get();

    console.log(`[updateBudgetSpent] Budgets trouvés pour type ${type}: ${budgetSnapshot.docs.length}`);
    
    // Lister tous les budgets trouvés pour debug
    budgetSnapshot.docs.forEach(doc => {
      const data = doc.data();
      console.log(`[updateBudgetSpent] Budget: id=${doc.id}, name=${data.name}, month=${data.month || getBudgetMonth(data)}`);
    });

    // Filtrer par mois ET par catégorie (avec correspondance flexible)
    const categoryLower = category ? category.toLowerCase().trim() : '';
    
    const matchingBudget = budgetSnapshot.docs.find(doc => {
      const data = doc.data();
      const budgetMonth = data.month || getBudgetMonth(data);
      
      // Vérifier le mois
      if (budgetMonth !== month) {
        return false;
      }
      
      // Correspondance flexible de la catégorie (insensible à la casse)
      const budgetNameLower = data.name ? data.name.toLowerCase().trim() : '';
      
      // Vérifier correspondance exacte ou partielle
      const isMatch = budgetNameLower === categoryLower || 
                      budgetNameLower.includes(categoryLower) || 
                      categoryLower.includes(budgetNameLower);
      
      if (isMatch) {
        console.log(`[updateBudgetSpent] Correspondance trouvée: "${data.name}" ↔ "${category}"`);
      }
      
      return isMatch;
    });

    if (matchingBudget) {
      console.log(`[updateBudgetSpent] Budget correspondant: ${matchingBudget.id}, mise à jour spent +${amount}`);
      await matchingBudget.ref.update({
        spent: admin.firestore.FieldValue.increment(amount)
      });
      console.log(`[updateBudgetSpent] Budget mis à jour avec succès`);
    } else {
      console.log(`[updateBudgetSpent] ⚠️ Aucun budget correspondant trouvé pour catégorie="${category}" et mois=${month}`);
    }
  } catch (error) {
    console.error('[updateBudgetSpent] Erreur:', error);
  }
}

module.exports = router;
