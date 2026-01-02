/**
 * Routes API - Analytics
 */

const express = require('express');
const router = express.Router();
const { db } = require('../firebase');

// GET /api/analytics/:companyId/metrics - Métriques financières
router.get('/:companyId/metrics', async (req, res) => {
  try {
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

    // Récupérer les transactions
    const snapshot = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .where('date', '>=', startDateStr)
      .get();

    const transactions = snapshot.docs.map(doc => doc.data());

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
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/:companyId/chart - Données graphiques
router.get('/:companyId/chart', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { year = new Date().getFullYear() } = req.query;

    const snapshot = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .where('status', '==', 'validated')
      .get();

    const transactions = snapshot.docs.map(doc => doc.data());

    const months = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jun', 'Jul', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];

    const chartData = months.map((month, index) => {
      const monthTransactions = transactions.filter(t => {
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
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
