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

// GET /api/transactions/:companyId - Liste des transactions
router.get('/:companyId', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const { type, status, month, startDate, endDate } = req.query;

    // Requête simple sans orderBy pour éviter les index composites
    const snapshot = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .get();
    
    let transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filtres côté serveur
    if (type) {
      transactions = transactions.filter(t => t.type === type);
    }
    if (status) {
      transactions = transactions.filter(t => t.status === status);
    }
    
    // Filtre par mois (YYYY-MM)
    if (month) {
      transactions = transactions.filter(t => {
        if (!t.date) return false;
        return t.date.startsWith(month);
      });
    } else {
      // Filtres par dates si pas de mois spécifié
      if (startDate) {
        transactions = transactions.filter(t => t.date >= startDate);
      }
      if (endDate) {
        transactions = transactions.filter(t => t.date <= endDate);
      }
    }

    // Tri côté serveur (plus récent en premier)
    transactions.sort((a, b) => {
      const dateA = a.date || '';
      const dateB = b.date || '';
      return dateB.localeCompare(dateA);
    });

    // Limiter à 100 résultats
    transactions = transactions.slice(0, 100);

    res.json(transactions);
  } catch (error) {
    console.error('Erreur GET transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/transactions/:companyId/all-months - Liste de tous les mois avec transactions
router.get('/:companyId/all-months', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    
    const snapshot = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .get();
    
    const months = new Set();
    snapshot.docs.forEach(doc => {
      const data = doc.data();
      if (data.date) {
        // Extraire YYYY-MM de la date
        const month = data.date.substring(0, 7);
        months.add(month);
      }
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

    // Mettre à jour le budget si validé
    if (status === 'validated') {
      // Extraire le mois de la date de la transaction
      const month = data.date ? data.date.substring(0, 7) : getCurrentMonth();
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

// DELETE /api/transactions/:id - Supprimer
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.collection('transactions').doc(req.params.id).delete();
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
    
    // Chercher un budget correspondant
    const budgetSnapshot = await db.collection('budgets')
      .where('companyId', '==', companyId)
      .where('name', '==', category)
      .where('type', '==', type)
      .get();

    // Filtrer par mois côté serveur
    const matchingBudget = budgetSnapshot.docs.find(doc => doc.data().month === month);

    if (matchingBudget) {
      await matchingBudget.ref.update({
        spent: admin.firestore.FieldValue.increment(amount)
      });
    }
  } catch (error) {
    console.error('Erreur mise à jour budget:', error);
  }
}

module.exports = router;
