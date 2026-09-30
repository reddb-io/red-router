-- Attribution on the call log: the same nullable end_user / tags as the cost ledger (206).
-- NULL = not supplied. Kept apart from 206 because ensureCallLogsColumns (db/schemaColumns.ts)
-- back-fills these two columns before migrations run; the runner then records this file as
-- applied on its "duplicate column" path, and that must not swallow the ledger columns.

ALTER TABLE call_logs ADD COLUMN end_user TEXT DEFAULT NULL;
ALTER TABLE call_logs ADD COLUMN tags TEXT DEFAULT NULL;
