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

// Helper: Extraire le mois d'un budget (depuis month ou createdAt)
const getBudgetMonth = (budget) => {
  // Si le budget a déjà un champ month, l'utiliser
  if (budget.month) {
    return budget.month;
  }
  
  // Sinon, extraire le mois depuis createdAt
  if (budget.createdAt) {
    let date;
    if (budget.createdAt._seconds) {
      // Timestamp Firestore
      date = new Date(budget.createdAt._seconds * 1000);
    } else if (budget.createdAt.toDate) {
      // Firestore Timestamp object
      date = budget.createdAt.toDate();
    } else {
      date = new Date(budget.createdAt);
    }
    return formatMonth(date);
  }
  
  // Par défaut, retourner le mois courant
  return getCurrentMonth();
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
    
    // Filtrer par mois (en utilisant getBudgetMonth pour les anciens budgets)
    budgets = budgets.filter(b => getBudgetMonth(b) === targetMonth);
    
    // Ajouter le mois calculé aux budgets qui n'en ont pas
    budgets = budgets.map(b => ({
      ...b,
      month: b.month || getBudgetMonth(b)
    }));
    
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
      // Utiliser getBudgetMonth pour inclure les anciens budgets
      const budgetMonth = getBudgetMonth(data);
      if (budgetMonth) {
        months.add(budgetMonth);
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
    
    // Filtrer par mois côté serveur (utiliser getBudgetMonth pour les anciens budgets)
    const matchingBudget = snapshot.docs.find(doc => getBudgetMonth(doc.data()) === targetMonth);

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
    
    console.log(`[RENEW] Renouvellement budgets: companyId=${companyId}, source=${sourceMonth}, target=${targetMonth}`);
    
    if (!sourceMonth || !targetMonth) {
      return res.status(400).json({ error: 'sourceMonth et targetMonth sont requis' });
    }
    
    // Vérifier si des budgets existent déjà pour le mois cible
    const existingSnapshot = await db.collection('budgets')
      .where('companyId', '==', companyId)
      .get();
    
    const existingBudgets = existingSnapshot.docs
      .map(doc => doc.data())
      .filter(b => getBudgetMonth(b) === targetMonth);
    
    if (existingBudgets.length > 0) {
      return res.status(400).json({ 
        error: 'Des budgets existent déjà pour ce mois',
        existingCount: existingBudgets.length
      });
    }
    
    // Récupérer les budgets du mois source
    const sourceBudgets = existingSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(b => getBudgetMonth(b) === sourceMonth);
    
    console.log(`[RENEW] Budgets source trouvés: ${sourceBudgets.length}`);
    sourceBudgets.forEach(b => console.log(`[RENEW] - ${b.name} (${b.type}): ${b.amount}`));
    
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
      
      console.log(`[RENEW] Création budget: ${newBudget.name} pour ${targetMonth}`);
      
      batch.set(newBudgetRef, newBudget);
      newBudgets.push({ id: newBudgetRef.id, ...newBudget });
    }
    
    await batch.commit();
    console.log(`[RENEW] ${newBudgets.length} budgets créés avec succès`);
    
    res.status(201).json({ 
      message: `${newBudgets.length} budgets renouvelés pour ${targetMonth}`,
      budgets: newBudgets
    });
  } catch (error) {
    console.error('Erreur POST renew budgets:', error);
    res.status(400).json({ error: error.message });
  }
});

// POST /api/budgets/migrate - Migrer les anciens budgets (ajouter champ month)
router.post('/migrate', async (req, res) => {
  try {
    if (req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const db = getDb();
    
    // Récupérer tous les budgets sans champ month
    const snapshot = await db.collection('budgets').get();
    
    const budgetsToMigrate = snapshot.docs.filter(doc => !doc.data().month);
    
    if (budgetsToMigrate.length === 0) {
      return res.json({ message: 'Aucun budget à migrer', count: 0 });
    }
    
    const batch = db.batch();
    let migratedCount = 0;
    
    for (const doc of budgetsToMigrate) {
      const data = doc.data();
      const budgetMonth = getBudgetMonth(data);
      
      batch.update(doc.ref, { 
        month: budgetMonth,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      migratedCount++;
    }
    
    await batch.commit();
    
    res.json({ 
      message: `${migratedCount} budgets migrés avec succès`,
      count: migratedCount
    });
  } catch (error) {
    console.error('Erreur POST migrate budgets:', error);
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
