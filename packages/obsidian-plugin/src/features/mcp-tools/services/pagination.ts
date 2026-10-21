export type Page<T> = {
  page: T[];
  total: number;
  offset: number;
  truncated: boolean;
};

export function normalizeOffset(offset?: number): number {
  return Math.max(0, Math.floor(offset ?? 0));
}

export function normalizeLimit(
  limit: number | undefined,
  fallback: number,
  max: number,
): number {
  return Math.min(max, Math.max(1, Math.floor(limit ?? fallback)));
}

export function paginate<T>(
  items: T[],
  offset: number,
  limit: number,
): Page<T> {
  const page = items.slice(offset, offset + limit);

  return {
    page,
    total: items.length,
    offset,
    truncated: offset + page.length < items.length,
  };
}
