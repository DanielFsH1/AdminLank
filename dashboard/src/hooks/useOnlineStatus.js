import { useState, useEffect } from 'react';

/**
 * Hook que detecta si el dispositivo tiene conexión a internet.
 * Escucha los eventos online/offline del navegador.
 *
 * @returns {{ isOnline: boolean, wasOffline: boolean }}
 *   - isOnline: estado actual de la conexión
 *   - wasOffline: true si estuvo offline y acaba de reconectarse (por 3 seg)
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      // Mostrar banner de "reconectado" por 3 segundos
      setWasOffline(true);
      setTimeout(() => setWasOffline(false), 3000);
    };
    const goOffline = () => {
      setIsOnline(false);
      setWasOffline(false);
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return { isOnline, wasOffline };
}
