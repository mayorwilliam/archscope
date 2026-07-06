export function formatDate(date: Date): string {
  return date.toISOString();
}

export type DateLike = Date | string | number;
