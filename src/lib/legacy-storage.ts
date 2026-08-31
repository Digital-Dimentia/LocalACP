// One-time `localStorage` key migration for the ACP UI -> LocalACP rename.
//
// Every browser-side key this app owns used to be namespaced `acp-ui:*`. The
// rename moved them to `localacp:*`, which would silently orphan an existing
// user's theme, agents and preferences. Rather than sprinkling
// read-old-then-new logic through each call site, every reader funnels through
// `readMigrated`, which promotes the legacy value on first access.
//
// Promotion is a copy, not a move: the `acp-ui:*` key is left in place so
// downgrading to a pre-rename build still finds its data. The new key always
// wins once it exists, so a value written after the migration is never
// clobbered by a stale legacy one.

/** Namespace prefix for everything this app persists in `localStorage`. */
export const STORAGE_PREFIX = 'localacp';

/** The prefix used before the rename. */
export const LEGACY_STORAGE_PREFIX = 'acp-ui';

/**
 * Read `key`, falling back to its pre-rename `acp-ui:`-prefixed twin and
 * copying that value forward. Returns `null` when neither exists, and when
 * `localStorage` is unavailable or throws (private mode, blocked site data).
 */
export function readMigrated(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;

    if (!key.startsWith(`${STORAGE_PREFIX}:`)) return null;
    const legacyKey = `${LEGACY_STORAGE_PREFIX}:${key.slice(STORAGE_PREFIX.length + 1)}`;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy === null) return null;

    try {
      localStorage.setItem(key, legacy);
    } catch (e) {
      // Quota or a read-only store: we still have the value, so serve it and
      // let the next read migrate again rather than failing outright.
      console.warn(`Failed to migrate ${legacyKey} to ${key}:`, e);
    }
    return legacy;
  } catch (e) {
    console.warn(`Failed to read ${key} from localStorage:`, e);
    return null;
  }
}
