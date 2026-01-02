/**
 * Routes API - Analytics
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../firebase');

// GET /api/analytics/:companyId/metrics - Métriques financières
router.get('/:companyId/metrics', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const { period = 'month' } = req.query;

    const now = new Date();
    let startDate;

    switch (period) {
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'quarter':
        startDate = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
        break;
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1);
        break;
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const startDateStr = startDate.toISOString().split('T')[0];

    // Requête simple sans filtre de date pour éviter les index composites
    const snapshot = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .get();

    // Filtrer par date côté serveur
    const transactions = snapshot.docs
      .map(doc => doc.data())
      .filter(t => t.date >= startDateStr);

    // Calculer les métriques
    const validatedTransactions = transactions.filter(t => t.status === 'validated');
    
    const totalRevenue = validatedTransactions
      .filter(t => t.type === 'revenue')
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    const totalExpenses = validatedTransactions
      .filter(t => t.type === 'expense')
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    const pendingExpenses = transactions
      .filter(t => t.type === 'expense' && t.status === 'pending')
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    res.json({
      totalRevenue,
      totalExpenses,
      netResult: totalRevenue - totalExpenses,
      pendingExpenses,
      transactionCount: transactions.length,
      period
    });
  } catch (error) {
    console.error('Erreur GET analytics metrics:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/:companyId/chart - Données graphiques
router.get('/:companyId/chart', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const { year = new Date().getFullYear() } = req.query;

    // Requête simple pour éviter les index composites
    const snapshot = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .get();

    // Filtrer côté serveur
    const transactions = snapshot.docs
      .map(doc => doc.data())
      .filter(t => t.status === 'validated');

    const months = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jun', 'Jul', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];

    const chartData = months.map((month, index) => {
      const monthTransactions = transactions.filter(t => {
        if (!t.date) return false;
        const date = new Date(t.date);
        return date.getMonth() === index && date.getFullYear() === parseInt(year);
      });

      return {
        month,
        revenus: monthTransactions
          .filter(t => t.type === 'revenue')
          .reduce((sum, t) => sum + (t.amount || 0), 0),
        depenses: monthTransactions
          .filter(t => t.type === 'expense')
          .reduce((sum, t) => sum + (t.amount || 0), 0)
      };
    });

    res.json(chartData);
  } catch (error) {
    console.error('Erreur GET analytics chart:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
