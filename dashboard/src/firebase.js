// Configuración de Firebase para AdminLank Dashboard
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "***REMOVED***",
  authDomain: "***REMOVED***",
  projectId: "***REMOVED***",
  storageBucket: "***REMOVED***",
  messagingSenderId: "***REMOVED***",
  appId: "***REMOVED***"
};

const app = initializeApp(firebaseConfig);

// Firebase v12 habilita persistencia offline por defecto con getFirestore()
export const db = getFirestore(app);
export const auth = getAuth(app);

export default app;
