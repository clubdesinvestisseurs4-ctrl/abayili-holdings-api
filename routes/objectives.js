/**
 * Routes API - Objectives & Steps
 * Gestion des objectifs et étapes collaboratives
 */

const express = require('express');
const router = express.Router();
const { getDb, admin } = require('../firebase');

// ==================== OBJECTIFS ====================

// GET /api/objectives/:companyId - Liste des objectifs
router.get('/:companyId', async (req, res) => {
  try {
    const db = getDb();
    const snapshot = await db.collection('objectives')
      .where('companyId', '==', req.params.companyId)
      .get();
    
    let objectives = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    // Tri par date de création (plus récent en premier)
    objectives.sort((a, b) => {
      const dateA = a.createdAt?.toDate?.() || new Date(a.createdAt) || 0;
      const dateB = b.createdAt?.toDate?.() || new Date(b.createdAt) || 0;
      return dateB - dateA;
    });

    res.json(objectives);
  } catch (error) {
    console.error('Erreur GET objectives:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/objectives/:companyId/:id - Détail d'un objectif
router.get('/:companyId/:id', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('objectives').doc(req.params.id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Objectif non trouvé' });
    }
    
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error('Erreur GET objective:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/objectives - Créer un objectif (admin/manager uniquement)
router.post('/', async (req, res) => {
  try {
    if (!['admin_treasury', 'project_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Seul le chef de projet peut créer des objectifs' });
    }

    const db = getDb();
    const objective = {
      title: req.body.title,
      description: req.body.description || '',
      deadline: req.body.deadline || null,
      companyId: req.body.companyId,
      status: 'todo',
      steps: [],
      createdBy: req.user.uid,
      createdByName: req.user.name || req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('objectives').add(objective);
    res.status(201).json({ id: docRef.id, ...objective });
  } catch (error) {
    console.error('Erreur POST objective:', error);
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/objectives/:id - Modifier un objectif (admin/manager)
router.put('/:id', async (req, res) => {
  try {
    if (!['admin_treasury', 'project_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const db = getDb();
    const { title, description, deadline, status } = req.body;
    const updateData = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (deadline !== undefined) updateData.deadline = deadline;
    if (status !== undefined) updateData.status = status;

    await db.collection('objectives').doc(req.params.id).update(updateData);
    res.json({ success: true });
  } catch (error) {
    console.error('Erreur PUT objective:', error);
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/objectives/:id - Supprimer un objectif
router.delete('/:id', async (req, res) => {
  try {
    if (!['admin_treasury', 'project_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const db = getDb();
    await db.collection('objectives').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    console.error('Erreur DELETE objective:', error);
    res.status(400).json({ error: error.message });
  }
});

// ==================== ÉTAPES ====================

// POST /api/objectives/:id/steps - Ajouter une étape (TOUS les utilisateurs)
router.post('/:id/steps', async (req, res) => {
  try {
    const db = getDb();
    const objectiveRef = db.collection('objectives').doc(req.params.id);
    const objective = await objectiveRef.get();

    if (!objective.exists) {
      return res.status(404).json({ error: 'Objectif non trouvé' });
    }

    const steps = objective.data().steps || [];
    const newStep = {
      id: `step_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: req.body.title,
      description: req.body.description || '',
      status: 'todo', // todo, in_progress, waiting_validation, done
      order: steps.length + 1,
      reports: [], // Historique des compte-rendus
      createdBy: req.user.uid,
      createdByName: req.user.name || req.user.email,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    steps.push(newStep);

    await objectiveRef.update({
      steps,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).json(newStep);
  } catch (error) {
    console.error('Erreur POST step:', error);
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/objectives/:id/steps/:stepId - Modifier une étape
router.put('/:id/steps/:stepId', async (req, res) => {
  try {
    const db = getDb();
    const { id, stepId } = req.params;
    const { title, description } = req.body;

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

    if (title !== undefined) steps[stepIndex].title = title;
    if (description !== undefined) steps[stepIndex].description = description;
    steps[stepIndex].updatedAt = new Date().toISOString();

    await objectiveRef.update({
      steps,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json(steps[stepIndex]);
  } catch (error) {
    console.error('Erreur PUT step:', error);
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/objectives/:id/steps/:stepId/status - Modifier statut étape
router.put('/:id/steps/:stepId/status', async (req, res) => {
  try {
    const db = getDb();
    const { id, stepId } = req.params;
    const { status } = req.body;

    const validStatuses = ['todo', 'in_progress', 'waiting_validation', 'done'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide. Valeurs acceptées: todo, in_progress, waiting_validation, done' });
    }

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
    steps[stepIndex].updatedAt = new Date().toISOString();
    steps[stepIndex].statusUpdatedBy = req.user.uid;
    steps[stepIndex].statusUpdatedByName = req.user.name || req.user.email;

    // Calculer progression de l'objectif
    const completedSteps = steps.filter(s => s.status === 'done').length;
    const progress = steps.length > 0 ? Math.round((completedSteps / steps.length) * 100) : 0;
    const objectiveStatus = progress === 100 ? 'completed' : (completedSteps > 0 || steps.some(s => s.status === 'in_progress')) ? 'in_progress' : 'todo';

    await objectiveRef.update({
      steps,
      status: objectiveStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ step: steps[stepIndex], progress, objectiveStatus });
  } catch (error) {
    console.error('Erreur PUT step status:', error);
    res.status(400).json({ error: error.message });
  }
});

// POST /api/objectives/:id/steps/:stepId/report - Ajouter un compte-rendu
router.post('/:id/steps/:stepId/report', async (req, res) => {
  try {
    const db = getDb();
    const { id, stepId } = req.params;
    const { content, newStatus } = req.body;

    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Le compte-rendu ne peut pas être vide' });
    }

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

    // Créer le nouveau compte-rendu
    const newReport = {
      id: `report_${Date.now()}`,
      content: content.trim(),
      createdBy: req.user.uid,
      createdByName: req.user.name || req.user.email,
      createdAt: new Date().toISOString(),
      statusAtTime: newStatus || steps[stepIndex].status
    };

    // Ajouter au tableau des compte-rendus
    if (!steps[stepIndex].reports) {
      steps[stepIndex].reports = [];
    }
    steps[stepIndex].reports.push(newReport);
    steps[stepIndex].updatedAt = new Date().toISOString();

    // Mettre à jour le statut si spécifié
    if (newStatus && ['todo', 'in_progress', 'waiting_validation', 'done'].includes(newStatus)) {
      steps[stepIndex].status = newStatus;
      steps[stepIndex].statusUpdatedBy = req.user.uid;
      steps[stepIndex].statusUpdatedByName = req.user.name || req.user.email;
    }

    // Calculer progression de l'objectif
    const completedSteps = steps.filter(s => s.status === 'done').length;
    const progress = steps.length > 0 ? Math.round((completedSteps / steps.length) * 100) : 0;
    const objectiveStatus = progress === 100 ? 'completed' : (completedSteps > 0 || steps.some(s => s.status === 'in_progress')) ? 'in_progress' : 'todo';

    await objectiveRef.update({
      steps,
      status: objectiveStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ step: steps[stepIndex], report: newReport, progress, objectiveStatus });
  } catch (error) {
    console.error('Erreur POST report:', error);
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/objectives/:id/steps/:stepId - Supprimer une étape
router.delete('/:id/steps/:stepId', async (req, res) => {
  try {
    const db = getDb();
    const { id, stepId } = req.params;

    const objectiveRef = db.collection('objectives').doc(id);
    const objective = await objectiveRef.get();

    if (!objective.exists) {
      return res.status(404).json({ error: 'Objectif non trouvé' });
    }

    let steps = objective.data().steps || [];
    const stepIndex = steps.findIndex(s => s.id === stepId);

    if (stepIndex === -1) {
      return res.status(404).json({ error: 'Étape non trouvée' });
    }

    // Vérifier que l'utilisateur peut supprimer (créateur ou admin/manager)
    const step = steps[stepIndex];
    const canDelete = step.createdBy === req.user.uid || 
                     ['admin_treasury', 'project_manager'].includes(req.user.role);

    if (!canDelete) {
      return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres étapes' });
    }

    // Supprimer l'étape
    steps = steps.filter(s => s.id !== stepId);

    // Recalculer l'ordre
    steps = steps.map((s, index) => ({ ...s, order: index + 1 }));

    // Calculer progression
    const completedSteps = steps.filter(s => s.status === 'done').length;
    const progress = steps.length > 0 ? Math.round((completedSteps / steps.length) * 100) : 0;
    const objectiveStatus = steps.length === 0 ? 'todo' : 
                           progress === 100 ? 'completed' : 
                           (completedSteps > 0 || steps.some(s => s.status === 'in_progress')) ? 'in_progress' : 'todo';

    await objectiveRef.update({
      steps,
      status: objectiveStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, progress, objectiveStatus });
  } catch (error) {
    console.error('Erreur DELETE step:', error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
