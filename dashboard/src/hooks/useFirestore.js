import { useCallback, useEffect, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs, onSnapshot, query } from 'firebase/firestore';
import { db } from '../firebase';
import { normalizeFirestoreOptions } from './firestoreQueryHelpers';

function buildCollectionRef(collectionPath, constraints) {
  const colRef = collection(db, collectionPath);
  return constraints.length ? query(colRef, ...constraints) : colRef;
}

function areDependencyListsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((item, index) => Object.is(item, b[index]));
}

function useDependencyVersion(deps) {
  const depsRef = useRef(deps);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!areDependencyListsEqual(depsRef.current, deps)) {
      depsRef.current = deps;
      setVersion(currentVersion => currentVersion + 1);
    }
  }, [deps]);

  return version;
}

function useDependencyControlledValue(value, deps) {
  const depsRef = useRef(deps);
  const [state, setState] = useState({ value, version: 0 });

  useEffect(() => {
    if (!areDependencyListsEqual(depsRef.current, deps)) {
      depsRef.current = deps;
      setState(({ version }) => ({ value, version: version + 1 }));
    }
  }, [deps, value]);

  return [state.value, state.version];
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [constraintRef, constraintVersion] = useDependencyControlledValue(constraints, deps);

  const refetch = useCallback(() => setRefreshKey(k => k + 1), []);

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
  }, [collectionPath, enabled, realtime, constraintRef, constraintVersion, refreshKey]);

  return { data, loading, error, refetch };
}

export function useDocument(collectionOrPath, docIdOrOptions, maybeOptions) {
  const { fullPath, options } = parseDocumentArgs(collectionOrPath, docIdOrOptions, maybeOptions);
  const { enabled, realtime, deps } = options;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const dependencyVersion = useDependencyVersion(deps);

  const refetch = useCallback(() => setRefreshKey(k => k + 1), []);

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
  }, [fullPath, enabled, realtime, dependencyVersion, refreshKey]);

  return { data, loading, error, refetch };
}

export function useSubCollection(parentPath, subCollectionId, options = {}) {
  const fullPath = parentPath && subCollectionId ? `${parentPath}/${subCollectionId}` : '';
  return useCollection(fullPath, {
    ...options,
    enabled: Boolean(parentPath && subCollectionId) && (options.enabled ?? true),
    deps: options.deps || [parentPath, subCollectionId],
  });
}
