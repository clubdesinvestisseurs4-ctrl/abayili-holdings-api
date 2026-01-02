/**
 * Firebase Configuration pour le Backend
 * Utilise Firebase Admin SDK
 */

const admin = require('firebase-admin');

let db, auth, storage;

async function initializeFirebase() {
  if (admin.apps.length > 0) {
    console.log('✅ Firebase déjà initialisé');
    return { db, auth, storage };
  }

  try {
    // Option 1: Variable d'environnement (recommandé pour Render)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: `${serviceAccount.project_id}.appspot.com`
      });
    }
    // Option 2: Fichier local (pour développement)
    else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        storageBucket: `${process.env.FIREBASE_PROJECT_ID}.appspot.com`
      });
    }
    // Option 3: Variables d'environnement séparées
    else if (process.env.FIREBASE_PROJECT_ID) {
      const serviceAccount = {
        type: 'service_account',
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: process.env.FIREBASE_CERT_URL
      };
      
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: `${process.env.FIREBASE_PROJECT_ID}.appspot.com`
      });
    }
    else {
      throw new Error('Configuration Firebase manquante');
    }

    db = admin.firestore();
    auth = admin.auth();
    storage = admin.storage();

    console.log('✅ Firebase initialisé avec succès');
    return { db, auth, storage };
  } catch (error) {
    console.error('❌ Erreur initialisation Firebase:', error.message);
    throw error;
  }
}

// Export avec getters pour accès lazy
module.exports = {
  initializeFirebase,
  get db() { return db || admin.firestore(); },
  get auth() { return auth || admin.auth(); },
  get storage() { return storage || admin.storage(); },
  admin
};
