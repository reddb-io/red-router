use super::*;

/// One global document: the operator payload rules (legacy `settings.payloadRules`).
pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_payload_rules (id TEXT PRIMARY KEY, config_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const SELECT: &str =
    "SELECT config_json, revision FROM redrouter_control_payload_rules WHERE id = 'global'";
const INSERT: &str = "INSERT INTO redrouter_control_payload_rules (id,config_json,revision) VALUES ('global',$1,$2) ON CONFLICT (id) DO NOTHING";
const UPDATE: &str = "UPDATE redrouter_control_payload_rules SET config_json=$1,revision=$2 WHERE id='global' AND revision=$3";

#[derive(Clone, Debug, PartialEq)]
pub struct StoredPayloadRules {
    /// The normalized rules document.
    pub config_json: String,
    pub revision: i64,
}

impl Database {
    pub async fn payload_rules(&self) -> Result<Option<StoredPayloadRules>, &'static str> {
        match self {
            Self::Sql(pool) => {
                let row: Option<(String, i64)> = sqlx::query_as(SELECT)
                    .fetch_optional(pool)
                    .await
                    .map_err(|_| "cannot read payload rules")?;
                Ok(row.map(|(config_json, revision)| StoredPayloadRules {
                    config_json,
                    revision,
                }))
            }
            _ => {
                let rows = match self {
                    Self::Remote(_) => self.remote_query(SELECT, &[]).await?.rows,
                    #[cfg(feature = "reddb-embedded")]
                    Self::Embedded { db, .. } => {
                        db.query(SELECT)
                            .await
                            .map_err(|_| "cannot read payload rules")?
                            .rows
                    }
                    Self::Sql(_) => unreachable!(),
                };
                let Some(row) = rows.first() else {
                    return Ok(None);
                };
                let field = |name: &str| {
                    row.iter()
                        .find(|(column, _)| column.eq_ignore_ascii_case(name))
                };
                match (field("config_json"), field("revision")) {
                    (
                        Some((_, reddb_client::ValueOut::String(config_json))),
                        Some((_, reddb_client::ValueOut::Integer(revision))),
                    ) => Ok(Some(StoredPayloadRules {
                        config_json: config_json.clone(),
                        revision: *revision,
                    })),
                    _ => Err("invalid payload rules storage"),
                }
            }
        }
    }

    /// Write the rules when the stored revision is still `expected_revision`
    /// (`None`: no rules stored yet).
    pub async fn upsert_payload_rules(
        &self,
        rules: &StoredPayloadRules,
        expected_revision: Option<i64>,
    ) -> Result<(), &'static str> {
        let statement = if expected_revision.is_some() {
            UPDATE
        } else {
            INSERT
        };
        let params = || {
            let mut values = vec![
                reddb_client::Value::Text(rules.config_json.clone()),
                reddb_client::Value::Int(rules.revision),
            ];
            if let Some(revision) = expected_revision {
                values.push(reddb_client::Value::Int(revision));
            }
            values
        };
        match self {
            Self::Sql(pool) => {
                let query = sqlx::query(statement)
                    .bind(&rules.config_json)
                    .bind(rules.revision);
                let query = match expected_revision {
                    Some(revision) => query.bind(revision),
                    None => query,
                };
                query
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write payload rules")?;
            }
            Self::Remote(_) => {
                self.remote_query(statement, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(statement, params())
                    .await
                    .map_err(|_| "cannot write payload rules")?;
            }
        }
        // Every backend reports the outcome the same way: read it back.
        if self.payload_rules().await?.as_ref() != Some(rules) {
            return Err("Payload rules changed; reload and retry");
        }
        Ok(())
    }
}
