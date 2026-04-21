import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, onSnapshot, query } from 'firebase/firestore';
import { db } from '../firebase';
import { normalizeFirestoreOptions } from './firestoreQueryHelpers';

function buildCollectionRef(collectionPath, constraints) {
  const colRef = collection(db, collectionPath);
  return constraints.length ? query(colRef, ...constraints) : colRef;
}

function parseDocumentArgs(collectionOrPath, docIdOrOptions, maybeOptions) {
  if (typeof docIdOrOptions === 'string') {
    return {
      fullPath: `${collectionOrPath}/${docIdOrOptions}`,
      options: normalizeFirestoreOptions(maybeOptions),
    };
  }

  return {
    fullPath: collectionOrPath,
    options: normalizeFirestoreOptions(docIdOrOptions),
  };
}

export function useCollection(collectionPath, options = {}) {
  const { enabled, realtime, constraints, deps } = normalizeFirestoreOptions(options);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const constraintRef = useMemo(() => constraints, deps);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const target = buildCollectionRef(collectionPath, constraintRef);

    if (!realtime) {
      getDocs(target)
        .then((snapshot) => {
          setData(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          console.error(`Error en colección ${collectionPath}:`, err);
          setError(err.message || 'Error desconocido');
          setLoading(false);
        });
      return undefined;
    }

    const unsub = onSnapshot(target, (snapshot) => {
      setData(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      setError(null);
      setLoading(false);
    }, (err) => {
      console.error(`Error en colección ${collectionPath}:`, err);
      setError(err.message || 'Error desconocido');
      setLoading(false);
    });

    return () => unsub();
  }, [collectionPath, enabled, realtime, constraintRef]);

  return { data, loading, error };
}

export function useDocument(collectionOrPath, docIdOrOptions, maybeOptions) {
  const { fullPath, options } = parseDocumentArgs(collectionOrPath, docIdOrOptions, maybeOptions);
  const { enabled, realtime, deps } = options;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const effectDeps = deps.length ? deps : [fullPath, enabled, realtime];

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }

    const parts = fullPath.split('/');
    const ref = doc(db, ...parts);
    let retryCount = 0;
    const maxRetries = 3;
    let retryTimeout = null;
    let currentUnsub = null;

    function handleSuccess(snap) {
      setData(snap.exists() ? { id: snap.id, ...snap.data() } : null);
      setError(null);
      setLoading(false);
    }

    function handleError(err) {
      console.error(`Error en doc ${fullPath} (intento ${retryCount + 1}):`, err);
      if (realtime && retryCount < maxRetries) {
        retryCount += 1;
        retryTimeout = setTimeout(() => {
          if (currentUnsub) currentUnsub();
          subscribe();
        }, 1500 * retryCount);
        return;
      }

      setError(err.message || 'Error desconocido');
      setLoading(false);
    }

    function subscribe() {
      setLoading(true);
      if (!realtime) {
        getDoc(ref).then(handleSuccess).catch(handleError);
        return;
      }

      currentUnsub = onSnapshot(ref, handleSuccess, handleError);
    }

    subscribe();

    return () => {
      if (currentUnsub) currentUnsub();
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, effectDeps);

  return { data, loading, error };
}

export function useSubCollection(parentPath, subCollectionId, options = {}) {
  const fullPath = parentPath && subCollectionId ? `${parentPath}/${subCollectionId}` : '';
  return useCollection(fullPath, {
    ...options,
    enabled: Boolean(parentPath && subCollectionId) && (options.enabled ?? true),
    deps: options.deps || [parentPath, subCollectionId],
  });
}
