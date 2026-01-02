/**
 * Routes API - Objectives
 */

const express = require('express');
const router = express.Router();
const { db, admin, storage } = require('../firebase');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// GET /api/objectives/:companyId - Liste des objectifs
router.get('/:companyId', async (req, res) => {
  try {
    const snapshot = await db.collection('objectives')
      .where('companyId', '==', req.params.companyId)
      .orderBy('createdAt', 'desc')
      .get();
    
    const objectives = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(objectives);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/objectives - Créer un objectif
router.post('/', async (req, res) => {
  try {
    if (!['admin_treasury', 'project_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const objective = {
      ...req.body,
      steps: [],
      updates: [],
      createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('objectives').add(objective);
    res.status(201).json({ id: docRef.id, ...objective });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/objectives/:id - Modifier un objectif
router.put('/:id', async (req, res) => {
  try {
    await db.collection('objectives').doc(req.params.id).update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/objectives/:id/steps - Ajouter une étape
router.post('/:id/steps', async (req, res) => {
  try {
    if (!['admin_treasury', 'project_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const objectiveRef = db.collection('objectives').doc(req.params.id);
    const objective = await objectiveRef.get();

    if (!objective.exists) {
      return res.status(404).json({ error: 'Objectif non trouvé' });
    }

    const steps = objective.data().steps || [];
    const newStep = {
      id: `step_${Date.now()}`,
      ...req.body,
      status: 'todo',
      order: steps.length + 1,
      report: null,
      createdAt: new Date().toISOString()
    };

    await objectiveRef.update({
      steps: admin.firestore.FieldValue.arrayUnion(newStep),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).json(newStep);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/objectives/:id/steps/:stepId/status - Modifier statut étape
router.put('/:id/steps/:stepId/status', async (req, res) => {
  try {
    const { id, stepId } = req.params;
    const { status } = req.body;

    const objectiveRef = db.collection('objectives').doc(id);
    const objective = await objectiveRef.get();

    if (!objective.exists) {
      return res.status(404).json({ error: 'Objectif non trouvé' });
    }

    const steps = objective.data().steps || [];
    const stepIndex = steps.findIndex(s => s.id === stepId);

    if (stepIndex === -1) {
      return res.status(404).json({ error: 'Étape non trouvée' });
    }

    steps[stepIndex].status = status;

    await objectiveRef.update({
      steps,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json(steps[stepIndex]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/objectives/:id/steps/:stepId/report - Soumettre compte-rendu
router.post('/:id/steps/:stepId/report', upload.single('file'), async (req, res) => {
  try {
    const { id, stepId } = req.params;
    const { content, companyId } = req.body;

    const objectiveRef = db.collection('objectives').doc(id);
    const objective = await objectiveRef.get();

    if (!objective.exists) {
      return res.status(404).json({ error: 'Objectif non trouvé' });
    }

    let fileUrl = null;

    // Upload fichier si présent
    if (req.file) {
      const filename = `${companyId || 'general'}/reports/${Date.now()}_${req.file.originalname}`;
      const bucket = storage.bucket();
      const file = bucket.file(filename);

      await file.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype }
      });

      await file.makePublic();
      fileUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
    }

    const steps = objective.data().steps || [];
    const stepIndex = steps.findIndex(s => s.id === stepId);

    if (stepIndex === -1) {
      return res.status(404).json({ error: 'Étape non trouvée' });
    }

    steps[stepIndex].report = {
      content,
      fileUrl,
      fileName: req.file?.originalname || null,
      submittedBy: req.user.uid,
      date: new Date().toISOString()
    };
    steps[stepIndex].status = 'in_progress';

    await objectiveRef.update({
      steps,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json(steps[stepIndex]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/objectives/:id/steps/:stepId/validate - Valider étape
router.put('/:id/steps/:stepId/validate', async (req, res) => {
  try {
    if (req.user.role !== 'project_manager') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const { id, stepId } = req.params;
    const objectiveRef = db.collection('objectives').doc(id);
    const objective = await objectiveRef.get();

    if (!objective.exists) {
      return res.status(404).json({ error: 'Objectif non trouvé' });
    }

    const steps = objective.data().steps || [];
    const stepIndex = steps.findIndex(s => s.id === stepId);

    if (stepIndex === -1) {
      return res.status(404).json({ error: 'Étape non trouvée' });
    }

    steps[stepIndex].status = 'completed';
    steps[stepIndex].validatedBy = req.user.uid;
    steps[stepIndex].validatedAt = new Date().toISOString();

    // Calculer progression
    const completedSteps = steps.filter(s => s.status === 'completed').length;
    const progress = Math.round((completedSteps / steps.length) * 100);

    // Mettre à jour le statut de l'objectif si terminé
    const status = progress === 100 ? 'completed' : objective.data().status;

    await objectiveRef.update({
      steps,
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ step: steps[stepIndex], progress, status });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
