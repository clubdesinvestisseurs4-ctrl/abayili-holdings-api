/**
 * Routes API - Transactions
 */

const express = require('express');
const router = express.Router();
const { getDb, admin } = require('../firebase');

// GET /api/transactions/:companyId - Liste des transactions
router.get('/:companyId', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const { type, status, startDate, endDate } = req.query;

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
    if (startDate) {
      transactions = transactions.filter(t => t.date >= startDate);
    }
    if (endDate) {
      transactions = transactions.filter(t => t.date <= endDate);
    }

    // Tri côté serveur
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
      await updateBudgetSpent(data.companyId, data.category, data.type, data.amount);
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
      await updateBudgetSpent(data.companyId, data.category, data.type, data.amount);
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

// Helper: Mettre à jour le budget
async function updateBudgetSpent(companyId, category, type, amount) {
  try {
    const db = getDb();
    const budgetSnapshot = await db.collection('budgets')
      .where('companyId', '==', companyId)
      .where('name', '==', category)
      .where('type', '==', type)
      .limit(1)
      .get();

    if (!budgetSnapshot.empty) {
      const budgetDoc = budgetSnapshot.docs[0];
      await budgetDoc.ref.update({
        spent: admin.firestore.FieldValue.increment(amount)
      });
    }
  } catch (error) {
    console.error('Erreur mise à jour budget:', error);
  }
}

module.exports = router;
