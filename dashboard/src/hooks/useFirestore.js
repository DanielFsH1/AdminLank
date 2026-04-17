import { useState, useEffect } from 'react';
import { collection, onSnapshot, doc, query, orderBy } from 'firebase/firestore';
import { db } from '../firebase';

// Hook para escuchar una colección en tiempo real
export function useCollection(collectionPath) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const colRef = collection(db, collectionPath);
    const unsub = onSnapshot(colRef, (snapshot) => {
      const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setData(docs);
      setLoading(false);
    }, (err) => {
      console.error(`Error en colección ${collectionPath}:`, err);
      setLoading(false);
    });

    return () => unsub();
  }, [collectionPath]);

  return { data, loading };
}

// Hook para escuchar un documento específico
// Acepta useDocument('col/doc') o useDocument('col', 'doc')
// Reintenta automáticamente hasta 3 veces si la conexión falla
export function useDocument(collectionOrPath, docId) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fullPath = docId ? `${collectionOrPath}/${docId}` : collectionOrPath;

  useEffect(() => {
    const parts = fullPath.split('/');
    let retryCount = 0;
    const MAX_RETRIES = 3;
    let retryTimeout = null;
    let currentUnsub = null;

    function subscribe() {
      const docRef = doc(db, ...parts);
      currentUnsub = onSnapshot(docRef, (snap) => {
        setData(snap.exists() ? { id: snap.id, ...snap.data() } : null);
        setError(null);
        setLoading(false);
      }, (err) => {
        console.error(`Error en doc ${fullPath} (intento ${retryCount + 1}):`, err);
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          retryTimeout = setTimeout(() => {
            if (currentUnsub) currentUnsub();
            subscribe();
          }, 1500 * retryCount); // 1.5s, 3s, 4.5s
        } else {
          setError(err.message || 'Error desconocido');
          setLoading(false);
        }
      });
    }

    subscribe();

    return () => {
      if (currentUnsub) currentUnsub();
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [fullPath]);

  return { data, loading, error };
}

// Hook para sub-colecciones (ej: groups/chatgpt/lank-accounts)
export function useSubCollection(parentPath, subCollectionId) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!parentPath || !subCollectionId) return;

    const colRef = collection(db, parentPath, subCollectionId);
    const unsub = onSnapshot(colRef, (snapshot) => {
      const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setData(docs);
      setLoading(false);
    });

    return () => unsub();
  }, [parentPath, subCollectionId]);

  return { data, loading };
}
