export function normalizeFirestoreOptions(options = {}) {
  return {
    enabled: options.enabled ?? true,
    realtime: options.realtime ?? true,
    constraints: Array.isArray(options.constraints) ? options.constraints : [],
    deps: Array.isArray(options.deps) ? options.deps : [],
  };
}
