// Storage adapters. Interface (all async, values are JSON-safe):
//   get(key) -> value | null      set(key, value) -> void
//   remove(key) -> void           keys(prefix = '') -> string[]
// A network adapter implements the same four calls over HTTP.

// Named exclusive lock. Callers with the same adapter object queue behind each other.
function makeLocker() {
  const chains = new Map();
  return (name, fn) => {
    const prev = chains.get(name) || Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(name, run.catch(() => {}));
    return run;
  };
}

export function memoryAdapter() {
  const map = new Map();
  const local = makeLocker();
  return {
    withLock: (name, fn) => local(name, fn),
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, structuredClone(value));
    },
    async remove(key) {
      map.delete(key);
    },
    async keys(prefix = '') {
      return [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

// localStorage with a prefix. Every call is wrapped in try/catch. If the browser
// refuses (private mode, quota, no localStorage, corrupt JSON) the key lives in memory.
// `backend` is injectable for tests; default is globalThis.localStorage.
export function localStorageAdapter(prefix = 'arcade:', backend) {
  const mem = memoryAdapter();
  const memKeys = new Set(); // keys that had to fall back to memory
  const local = makeLocker();
  let degraded = false; // true once any write fell back to memory (data is lost on reload)
  const ls = () => {
    try {
      return backend ?? globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  return {
    get degraded() {
      return degraded;
    },
    // Uses the Web Locks API when present (serialises across tabs of one origin), else an in-process queue.
    withLock(name, fn) {
      try {
        const locks = globalThis.navigator?.locks;
        if (locks && typeof locks.request === 'function') return locks.request(prefix + name, fn);
      } catch {
        /* fall through */
      }
      return local(name, fn);
    },
    async get(key) {
      if (memKeys.has(key)) return mem.get(key);
      try {
        const raw = ls()?.getItem(prefix + key);
        if (raw == null) return null;
        return JSON.parse(raw);
      } catch {
        return null; // unreadable or corrupt: treat as missing
      }
    },
    async set(key, value) {
      try {
        const store = ls();
        if (!store) throw new Error('no localStorage');
        store.setItem(prefix + key, JSON.stringify(value));
        memKeys.delete(key);
      } catch {
        memKeys.add(key);
        degraded = true;
        await mem.set(key, value);
      }
    },
    async remove(key) {
      memKeys.delete(key);
      await mem.remove(key);
      try {
        ls()?.removeItem(prefix + key);
      } catch {
        /* ignore */
      }
    },
    async keys(p = '') {
      const out = new Set(await mem.keys(p));
      try {
        const store = ls();
        if (store) {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k && k.startsWith(prefix + p)) out.add(k.slice(prefix.length));
          }
        }
      } catch {
        /* ignore */
      }
      return [...out].sort();
    },
  };
}

// Keep the top `cap` entries plus every player's best entry (player = e.pid, else e.name).
// `entries` must already be sorted best-first.
export function trimBoard(entries, cap = 100) {
  const seen = new Set();
  const out = [];
  entries.forEach((e, i) => {
    const who = e.pid ?? e.name;
    const first = !seen.has(who);
    seen.add(who);
    if (i < cap || first) out.push(e);
  });
  return out;
}

const PID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const isPlayerId = (v) => typeof v === 'string' && PID_RE.test(v);

// One opaque id per browser, generated once and kept in storage. Names are labels only.
export async function getLocalPlayerId(storage) {
  const have = await storage.get('playerId');
  if (isPlayerId(have)) return have;
  let id;
  try {
    id = globalThis.crypto.randomUUID();
  } catch {
    id = Array.from({ length: 4 }, () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')).join('');
  }
  await storage.set('playerId', id);
  return id;
}
