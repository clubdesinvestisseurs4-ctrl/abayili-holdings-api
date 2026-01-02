/**
 * Routes API - Users
 */

const express = require('express');
const router = express.Router();
const { db, auth, admin } = require('../firebase');

// GET /api/users - Liste des utilisateurs (admin uniquement)
router.get('/', async (req, res) => {
  try {
    if (req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/users - Créer un utilisateur (admin uniquement)
router.post('/', async (req, res) => {
  try {
    if (req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const { email, password, name, role, companies } = req.body;

    // Créer dans Firebase Auth
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: name,
      disabled: false
    });

    // Sauvegarder dans Firestore
    const userData = {
      email,
      name,
      role: role || 'collaborator',
      companies: companies || [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('users').doc(userRecord.uid).set(userData);

    // Définir les custom claims
    await auth.setCustomUserClaims(userRecord.uid, {
      role: userData.role,
      companies: userData.companies
    });

    res.status(201).json({ uid: userRecord.uid, ...userData });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/users/:uid/role - Modifier le rôle (admin uniquement)
router.put('/:uid/role', async (req, res) => {
  try {
    if (req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const { uid } = req.params;
    const { role, companies } = req.body;

    await db.collection('users').doc(uid).update({
      role,
      companies,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await auth.setCustomUserClaims(uid, { role, companies });

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
