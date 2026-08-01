export interface DeduplicableMemory {
  id: number;
  summary: string;
  pinned: boolean;
  importance: number;
  createdAt: string;
}

export function normalizeMemorySummary(value: string): string {
  return Array.from(value.normalize("NFKC").toLowerCase())
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
}

function trigrams(value: string): Set<string> {
  const result = new Set<string>();
  const characters = Array.from(value);
  for (let index = 0; index <= characters.length - 3; index += 1) {
    result.add(characters.slice(index, index + 3).join(""));
  }
  return result;
}

export function summariesDeduplicate(left: string, right: string): boolean {
  const normalizedLeft = normalizeMemorySummary(left);
  const normalizedRight = normalizeMemorySummary(right);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.length < 16 || normalizedRight.length < 16) return false;
  const leftTrigrams = trigrams(normalizedLeft);
  const rightTrigrams = trigrams(normalizedRight);
  let overlap = 0;
  for (const gram of leftTrigrams) if (rightTrigrams.has(gram)) overlap += 1;
  return overlap / Math.min(leftTrigrams.size, rightTrigrams.size) >= 0.85;
}

export function compareMemoryOrder<T extends DeduplicableMemory>(left: T, right: T): number {
  return (
    Number(right.pinned) - Number(left.pinned) ||
    right.importance - left.importance ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id - right.id
  );
}

/** Keeps exactly one deterministically preferred memory from each duplicate group. */
export function deduplicateMemories<T extends DeduplicableMemory>(records: readonly T[]): T[] {
  const sorted = [...records].sort(compareMemoryOrder);
  const retained: T[] = [];
  for (const record of sorted) {
    if (!retained.some((candidate) => summariesDeduplicate(candidate.summary, record.summary))) {
      retained.push(record);
    }
  }
  return retained;
}
