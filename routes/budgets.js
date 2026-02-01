/**
 * Routes API - Budgets
 * Avec support de navigation mensuelle et renouvellement automatique
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

// GET /api/budgets/:companyId - Liste des budgets (filtré par mois)
router.get('/:companyId', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const { month } = req.query; // Format: YYYY-MM
    
    const targetMonth = month || getCurrentMonth();
    
    const snapshot = await db.collection('budgets')
      .where('companyId', '==', companyId)
      .get();
    
    let budgets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    // Filtrer par mois
    budgets = budgets.filter(b => b.month === targetMonth);
    
    res.json(budgets);
  } catch (error) {
    console.error('Erreur GET budgets:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/budgets/:companyId/all-months - Liste de tous les mois disponibles
router.get('/:companyId/all-months', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    
    const snapshot = await db.collection('budgets')
      .where('companyId', '==', companyId)
      .get();
    
    const months = new Set();
    snapshot.docs.forEach(doc => {
      const data = doc.data();
      if (data.month) {
        months.add(data.month);
      }
    });
    
    // Trier les mois (plus récent en premier)
    const sortedMonths = Array.from(months).sort((a, b) => b.localeCompare(a));
    
    res.json(sortedMonths);
  } catch (error) {
    console.error('Erreur GET all-months:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/budgets/:companyId/check - Vérifier alerte budget
router.get('/:companyId/check', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const { category, type, amount, month } = req.query;
    
    const targetMonth = month || getCurrentMonth();

    let query = db.collection('budgets')
      .where('companyId', '==', companyId)
      .where('name', '==', category)
      .where('type', '==', type);

    const snapshot = await query.limit(10).get();
    
    // Filtrer par mois côté serveur
    const matchingBudget = snapshot.docs.find(doc => doc.data().month === targetMonth);

    if (!matchingBudget) {
      return res.json({ alert: null });
    }

    const budget = matchingBudget.data();
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
    console.error('Erreur GET check budget:', error);
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
    const { month, ...rest } = req.body;
    
    const targetMonth = month || getCurrentMonth();
    
    const budget = {
      ...rest,
      month: targetMonth,
      spent: 0,
      createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('budgets').add(budget);
    res.status(201).json({ id: docRef.id, ...budget });
  } catch (error) {
    console.error('Erreur POST budget:', error);
    res.status(400).json({ error: error.message });
  }
});

// POST /api/budgets/:companyId/renew - Renouveler les budgets pour un nouveau mois
router.post('/:companyId/renew', async (req, res) => {
  try {
    if (req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const db = getDb();
    const { companyId } = req.params;
    const { sourceMonth, targetMonth } = req.body;
    
    if (!sourceMonth || !targetMonth) {
      return res.status(400).json({ error: 'sourceMonth et targetMonth sont requis' });
    }
    
    // Vérifier si des budgets existent déjà pour le mois cible
    const existingSnapshot = await db.collection('budgets')
      .where('companyId', '==', companyId)
      .get();
    
    const existingBudgets = existingSnapshot.docs
      .map(doc => doc.data())
      .filter(b => b.month === targetMonth);
    
    if (existingBudgets.length > 0) {
      return res.status(400).json({ 
        error: 'Des budgets existent déjà pour ce mois',
        existingCount: existingBudgets.length
      });
    }
    
    // Récupérer les budgets du mois source
    const sourceBudgets = existingSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(b => b.month === sourceMonth);
    
    if (sourceBudgets.length === 0) {
      return res.status(404).json({ error: 'Aucun budget trouvé pour le mois source' });
    }
    
    // Créer les nouveaux budgets
    const batch = db.batch();
    const newBudgets = [];
    
    for (const source of sourceBudgets) {
      const newBudgetRef = db.collection('budgets').doc();
      const newBudget = {
        companyId: source.companyId,
        name: source.name,
        type: source.type,
        amount: source.amount,
        period: source.period,
        month: targetMonth,
        spent: 0,
        renewedFrom: source.id,
        createdBy: req.user.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      
      batch.set(newBudgetRef, newBudget);
      newBudgets.push({ id: newBudgetRef.id, ...newBudget });
    }
    
    await batch.commit();
    
    res.status(201).json({ 
      message: `${newBudgets.length} budgets renouvelés pour ${targetMonth}`,
      budgets: newBudgets
    });
  } catch (error) {
    console.error('Erreur POST renew budgets:', error);
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
    const { id } = req.params;
    
    // Ne pas permettre de modifier le mois
    const { month, ...updateData } = req.body;
    
    await db.collection('budgets').doc(id).update({
      ...updateData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Erreur PUT budget:', error);
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
    console.error('Erreur DELETE budget:', error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
