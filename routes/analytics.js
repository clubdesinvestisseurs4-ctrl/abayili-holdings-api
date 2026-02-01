/**
 * Routes API - Analytics
 * Avec support de navigation mensuelle
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../firebase');

// Helper: Obtenir le mois courant au format YYYY-MM
const getCurrentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

// GET /api/analytics/:companyId/metrics - Métriques financières
router.get('/:companyId/metrics', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const { month, period = 'month' } = req.query;

    // Si un mois spécifique est fourni, l'utiliser
    let startDateStr, endDateStr;
    
    if (month) {
      // Format: YYYY-MM
      startDateStr = `${month}-01`;
      // Calculer le dernier jour du mois
      const [year, monthNum] = month.split('-').map(Number);
      const lastDay = new Date(year, monthNum, 0).getDate();
      endDateStr = `${month}-${String(lastDay).padStart(2, '0')}`;
    } else {
      // Comportement par défaut basé sur la période
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

      startDateStr = startDate.toISOString().split('T')[0];
      endDateStr = now.toISOString().split('T')[0];
    }

    // Requête simple sans filtre de date pour éviter les index composites
    const snapshot = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .get();

    // Filtrer par date côté serveur
    const transactions = snapshot.docs
      .map(doc => doc.data())
      .filter(t => t.date >= startDateStr && t.date <= endDateStr);

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
      period: month || period,
      month: month || getCurrentMonth()
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

    const months = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

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

// GET /api/analytics/:companyId/monthly-summary - Résumé par mois
router.get('/:companyId/monthly-summary', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const { year = new Date().getFullYear() } = req.query;

    const snapshot = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .get();

    const transactions = snapshot.docs
      .map(doc => doc.data())
      .filter(t => {
        if (!t.date) return false;
        return t.date.startsWith(String(year)) && t.status === 'validated';
      });

    const months = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
    
    const summary = months.map((monthName, index) => {
      const monthStr = `${year}-${String(index + 1).padStart(2, '0')}`;
      const monthTxs = transactions.filter(t => t.date.startsWith(monthStr));
      
      const revenue = monthTxs
        .filter(t => t.type === 'revenue')
        .reduce((sum, t) => sum + (t.amount || 0), 0);
      
      const expenses = monthTxs
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + (t.amount || 0), 0);

      return {
        month: monthStr,
        monthName,
        revenue,
        expenses,
        net: revenue - expenses,
        transactionCount: monthTxs.length
      };
    });

    res.json(summary);
  } catch (error) {
    console.error('Erreur GET monthly-summary:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
