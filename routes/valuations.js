/**
 * Routes API - Relevés de valeur manuels (valuation snapshots)
 *
 * Pour les placements gérés par un tiers sans API disponible (ex: FCP via
 * Jamo/NSIA) - contrairement au bot Pionex, impossible de récupérer la
 * valeur en direct. L'utilisateur entre donc lui-même, de temps en temps,
 * "à telle date, ma position vaut tel montant total", et l'app calcule le
 * rendement automatiquement à partir de ça (valeur - capital net apporté,
 * capital net calculé depuis les transactions "Apport Capital" déjà dans le
 * grand livre) plutôt que de faire deviner le calcul à l'utilisateur.
 */

const express = require('express');
const router = express.Router();
const { getDb, admin } = require('../firebase');

// GET /api/valuations/:companyId - Tous les relevés, triés par date croissante
router.get('/:companyId', async (req, res) => {
  try {
    const db = getDb();
    const { companyId } = req.params;
    const snapshot = await db.collection('valuation_snapshots').where('companyId', '==', companyId).get();
    const snapshots = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    res.json(snapshots);
  } catch (error) {
    console.error('Erreur GET valuations:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/valuations - Ajouter un relevé {companyId, date, value, note?}
router.post('/', async (req, res) => {
  try {
    const db = getDb();
    const { companyId, date, value, note } = req.body;
    if (!companyId || !date || typeof value !== 'number') {
      return res.status(400).json({ error: 'companyId, date et value (nombre) sont requis' });
    }
    const doc = {
      companyId,
      date,
      value,
      note: note || '',
      createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const docRef = await db.collection('valuation_snapshots').add(doc);
    res.status(201).json({ id: docRef.id, ...doc });
  } catch (error) {
    console.error('Erreur POST valuation:', error);
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/valuations/:id - Retirer un relevé saisi par erreur
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.collection('valuation_snapshots').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    console.error('Erreur DELETE valuation:', error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
