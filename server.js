/**
 * Abayili Holdings - Backend Server
 * Déployé sur Render.com
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');

const { initializeFirebase, db, auth, storage } = require('./firebase');
const transactionRoutes = require('./routes/transactions');
const budgetRoutes = require('./routes/budgets');
const objectiveRoutes = require('./routes/objectives');
const userRoutes = require('./routes/users');
const analyticsRoutes = require('./routes/analytics');

const app = express();
const PORT = process.env.PORT || 3001;

// ==================== MIDDLEWARE ====================

// Sécurité
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS - Autoriser le frontend Vercel
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  process.env.FRONTEND_URL,
  /\.vercel\.app$/
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = allowedOrigins.some(o => 
      o instanceof RegExp ? o.test(origin) : o === origin
    );
    callback(null, allowed);
  },
  credentials: true
}));

// Logging
app.use(morgan('combined'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Multer pour upload de fichiers
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ==================== AUTH MIDDLEWARE ====================

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  try {
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await auth.verifyIdToken(token);
    
    // Récupérer les données utilisateur
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      ...(userDoc.exists ? userDoc.data() : { role: 'collaborator', companies: [] })
    };
    
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(401).json({ error: 'Token invalide' });
  }
};

// Vérification des rôles
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Accès non autorisé' });
  }
  next();
};

// Vérification accès entreprise
const requireCompanyAccess = (req, res, next) => {
  const companyId = req.params.companyId || req.body.companyId;
  if (!companyId) return next();
  
  if (req.user.companies?.length && !req.user.companies.includes(companyId)) {
    return res.status(403).json({ error: 'Accès non autorisé à cette entreprise' });
  }
  next();
};

// Exporter les middlewares
app.locals.authMiddleware = authMiddleware;
app.locals.requireRole = requireRole;
app.locals.requireCompanyAccess = requireCompanyAccess;
app.locals.upload = upload;

// ==================== ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Routes API
app.use('/api/transactions', authMiddleware, transactionRoutes);
app.use('/api/budgets', authMiddleware, budgetRoutes);
app.use('/api/objectives', authMiddleware, objectiveRoutes);
app.use('/api/users', authMiddleware, userRoutes);
app.use('/api/analytics', authMiddleware, analyticsRoutes);

// Route utilisateur actuel
app.get('/api/users/:uid', authMiddleware, async (req, res) => {
  try {
    if (req.params.uid !== req.user.uid && req.user.role !== 'admin_treasury') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    
    const userDoc = await db.collection('users').doc(req.params.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    
    res.json({ id: userDoc.id, ...userDoc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload de fichiers
app.post('/api/upload/report', authMiddleware, requireRole('admin_treasury'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Fichier manquant' });
    }

    const { companyId, type, description } = req.body;
    const timestamp = Date.now();
    const filename = `${companyId}/reports/${timestamp}_${req.file.originalname}`;
    
    // Upload vers Firebase Storage
    const bucket = storage.bucket();
    const file = bucket.file(filename);
    
    await file.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype }
    });
    
    await file.makePublic();
    const fileUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;

    // Sauvegarder la référence
    const report = {
      companyId,
      type: type || 'general',
      description,
      fileName: req.file.originalname,
      fileUrl,
      uploadedBy: req.user.uid,
      uploadedAt: new Date()
    };

    const docRef = await db.collection('financial_reports').add(report);
    
    res.json({ id: docRef.id, ...report });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ERROR HANDLER ====================

app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// ==================== START SERVER ====================

const startServer = async () => {
  try {
    // Initialiser Firebase
    await initializeFirebase();
    
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = app;
