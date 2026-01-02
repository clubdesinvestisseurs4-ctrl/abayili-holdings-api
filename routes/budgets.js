/**
 * Routes API - Budgets
 */

const express = require('express');
const router = express.Router();
const { getDb, admin } = require('../firebase');

// GET /api/budgets/:companyId - Liste des budgets
router.get('/:companyId', async (req, res) => {
  try {
    const db = getDb();
    const snapshot = await db.collection('budgets')
      .where('companyId', '==', req.params.companyId)
      .get();
    
    const budgets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(budgets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/budgets/:companyId/check - Vérifier alerte budget
router.get('/:companyId/check', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const { category, type, amount } = req.query;

    const snapshot = await db.collection('budgets')
      .where('companyId', '==', companyId)
      .where('name', '==', category)
      .where('type', '==', type)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.json({ alert: null });
    }

    const budget = snapshot.docs[0].data();
    const newTotal = (budget.spent || 0) + parseFloat(amount);
    const percentage = (newTotal / budget.amount) * 100;

    let alert = null;
    if (newTotal > budget.amount) {
      alert = { type: 'exceeded', amount: newTotal - budget.amount, percentage };
    } else if (percentage >= 80) {
      alert = { type: 'warning', percentage };
    }

    res.json({ alert });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/budgets - Créer un budget
router.post('/', async (req, res) => {
  try {
    if (req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const db = getDb();
    const budget = {
      ...req.body,
      spent: 0,
      createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('budgets').add(budget);
    res.status(201).json({ id: docRef.id, ...budget });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/budgets/:id - Modifier un budget
router.put('/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const db = getDb();
    await db.collection('budgets').doc(req.params.id).update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/budgets/:id - Supprimer un budget
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const db = getDb();
    await db.collection('budgets').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
