import { getUserDatabaseSettings } from "./databaseSettings";

export type HistoryWindowDays = 0 | 7 | 14 | 28;

/** null preserves existing policies until the operator selects a preset. */
export function getHistoryWindowDays(): HistoryWindowDays | null {
  const value = getUserDatabaseSettings().retention.historyWindowDays;
  return value === 0 || value === 7 || value === 14 || value === 28 ? value : null;
}
