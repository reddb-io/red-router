-- Bumped to end every live session of a tenant user at once (password change, role change, disable,
-- "sign out everywhere"). A tenant session token carries the version it was minted at.
ALTER TABLE tenant_users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
