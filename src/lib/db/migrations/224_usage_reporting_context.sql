-- Attribution is captured on the ledger/outbox event, never joined from mutable keys.
ALTER TABLE request_cost_ledger ADD COLUMN usage_attributes TEXT NOT NULL DEFAULT '{}';
ALTER TABLE request_cost_ledger ADD COLUMN pricing_known INTEGER NOT NULL DEFAULT 1;
