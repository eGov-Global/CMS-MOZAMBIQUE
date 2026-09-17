import { useEffect, useState } from "react";
import { fetchEmployeeNamesByUuids } from "../services/employeeService";

/**
 * Resolve officer UUIDs to employee names for the officer-PII tiles.
 *
 * Officer identity is server-gated (OFFICER_PII_ROLES): a caller that may not
 * see the dimension never receives uuids to resolve, so this hook only ever
 * looks up what the analytics API already released.
 *
 * Resolutions are memoized across tiles in a module-level cache — the officer
 * tiles overlap heavily and an employee's name does not change inside a
 * session. Unresolved uuids are cached as absent, never retried per render,
 * and never guessed: the caller labels them with a short opaque id.
 *
 * Returns: { names } — { [uuid]: name }, growing as lookups resolve.
 */
const cache = new Map();

export function useEmployeeNames(uuids = []) {
  const [names, setNames] = useState({});
  const key = [...new Set(uuids.filter(Boolean))].sort().join(",");

  useEffect(() => {
    const wanted = key ? key.split(",") : [];
    const missing = wanted.filter((uuid) => !cache.has(uuid));
    if (!missing.length) {
      setNames(Object.fromEntries(wanted.filter((u) => cache.get(u)).map((u) => [u, cache.get(u)])));
      return undefined;
    }
    let cancelled = false;
    fetchEmployeeNamesByUuids(missing).then((resolved) => {
      // Cache misses too, so an unresolvable uuid is not re-fetched per render.
      for (const uuid of missing) cache.set(uuid, resolved[uuid] || null);
      if (cancelled) return;
      setNames(Object.fromEntries(wanted.filter((u) => cache.get(u)).map((u) => [u, cache.get(u)])));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { names };
}
