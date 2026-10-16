/**
 * Deterministic JSON: object keys sorted recursively, undefined values dropped.
 * Used for signing mandates and hashing audit entries, so the same logical
 * value always produces the same bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      if (o[k] !== undefined) out[k] = sortValue(o[k]);
    }
    return out;
  }
  return v;
}
