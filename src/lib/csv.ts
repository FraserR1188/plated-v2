import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing    from 'expo-sharing';
import { MealEntry }   from '../types';

function cell(v: string | number): string {
  const s = String(v);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportCSV(entries: MealEntry[]): Promise<void> {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.logged_at).getTime() - new Date(b.logged_at).getTime()
  );

  const header = 'date,time,meal_type,ingredient,brand,serving_g,calories,protein_g,carbs_g,fat_g,salt_g,fibre_g,sugar_g,source';

  const rows = sorted.map((e) => {
    const dt   = new Date(e.logged_at);
    const date = dt.toISOString().slice(0, 10);
    const time = dt.toTimeString().slice(0, 5);
    return [
      cell(date),
      cell(time),
      cell(e.meal_type),
      cell(e.name),
      cell(e.brand ?? ''),
      cell(e.serving_g.toFixed(1)),
      cell(Math.round(e.calories)),
      cell(e.protein.toFixed(1)),
      cell(e.carbs.toFixed(1)),
      cell(e.fat.toFixed(1)),
      cell(e.salt.toFixed(2)),
      cell(e.fibre.toFixed(1)),
      cell(e.sugar.toFixed(1)),
      cell(e.source),
    ].join(',');
  });

  const csv      = [header, ...rows].join('\n');
  const filename = `plated_${new Date().toISOString().slice(0, 10)}.csv`;
  const path     = FileSystem.documentDirectory + filename;

  await FileSystem.writeAsStringAsync(path, csv, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) throw new Error('Sharing not available on this device');

  await Sharing.shareAsync(path, {
    mimeType:    'text/csv',
    dialogTitle: 'Export plated. data',
  });
}

export function filterByDateRange(entries: MealEntry[], from: string, to: string): MealEntry[] {
  return entries.filter((e) => e.date >= from && e.date <= to);
}

export function last30Days(entries: MealEntry[]): MealEntry[] {
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  return filterByDateRange(entries, from, to);
}
