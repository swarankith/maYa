export function formatDisplayDate(iso: string | null | undefined): string {
  if (!iso) return 'Unscheduled';
  const normalized = iso.length === 10 ? `${iso}T12:00:00` : iso;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return iso;
  const datePart = parsed.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  if (iso.length > 10 && iso.includes('T')) {
    return `${datePart} · ${iso.slice(11, 16)}`;
  }
  return datePart;
}

export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
