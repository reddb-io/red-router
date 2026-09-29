-- Usage sink transports (webhook, Amazon SQS, Kafka, RedDB queue). `config` holds the
-- transport's settings as JSON with each credential encrypted per field
-- (src/lib/logExport/secrets.ts primitives). The legacy url / secret_encrypted columns stay:
-- they keep mirroring a webhook sink's url and secret, and hold '' for the other transports.
ALTER TABLE redrouter_usage_sinks ADD COLUMN type TEXT NOT NULL DEFAULT 'webhook';
ALTER TABLE redrouter_usage_sinks ADD COLUMN config TEXT;

UPDATE redrouter_usage_sinks
   SET config = json_object('url', url, 'secret', secret_encrypted)
 WHERE config IS NULL;
