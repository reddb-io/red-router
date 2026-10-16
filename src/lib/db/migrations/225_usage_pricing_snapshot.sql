-- Preserve event-time model prices; historical rows remain explicitly unknown.
ALTER TABLE request_cost_ledger ADD COLUMN pricing_snapshot TEXT;
