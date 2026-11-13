//! A policy and its six sidecars are one durable authorization record.
use red_routerd::storage::{Backend, Database, StoredClientKey, StoredTenant};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tempfile::TempDir;
use url::Url;

const SIDECARS: [&str; 6] = [
    "preferences",
    "schedules",
    "model_access",
    "combo_access",
    "ownership",
    "quotas",
];

fn policy(revision: i64) -> StoredClientKey {
    StoredClientKey {
        id: "shared-client".into(),
        label: format!("Revision {revision}"),
        key_hash: format!("{revision:064x}"),
        enabled: revision % 2 == 0,
        expiry_unix: 2_000_000_000 + revision,
        scopes_json: "[]".into(),
        allowed_endpoints_json: "[]".into(),
        allowed_models_json: format!("[\"model-{revision}\"]"),
        blocked_models_json: format!("[\"blocked-{revision}\"]"),
        allowed_provider_ids_json: format!("[\"provider-{revision}\"]"),
        max_concurrent: revision,
        max_rpm: revision + 100,
        max_rpd: revision + 200,
        model_id_format: if revision % 2 == 0 {
            "flat"
        } else {
            "prefixed"
        }
        .into(),
        model_access_mode: if revision % 2 == 0 {
            "all"
        } else {
            "restricted"
        }
        .into(),
        allowed_combos_json: format!("[\"combo/team-{revision}\"]"),
        access_schedule_json: format!(
            r#"{{"enabled":{},"from":"08:00","until":"18:00","days":[1],"tz":"UTC"}}"#,
            revision % 2 == 0
        ),
        tenant_id: if revision % 2 == 0 { "red" } else { "acme" }.into(),
        created_by: format!("actor-{revision}"),
        max_tokens_per_minute: 1000 + revision,
        max_tokens_per_day: 2000 + revision,
        max_monthly_microusd: 3000 + revision,
        reservation_tokens: 10 + revision,
        reservation_microusd: 20 + revision,
        revision,
    }
}

async fn seed_tenant(db: &Database) {
    db.upsert_tenant(&StoredTenant {
        id: "acme".into(),
        slug: "acme".into(),
        name: "Acme".into(),
        enabled: true,
        revision: 1,
    })
    .await
    .unwrap();
}

fn database_url(path: &std::path::Path) -> String {
    format!(
        "{}?mode=rwc",
        Url::from_file_path(path)
            .unwrap()
            .as_str()
            .replacen("file:", "sqlite:", 1)
    )
}

#[tokio::test]
async fn sqlite_late_failure_rolls_back_key_and_every_policy_sidecar() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("atomic.sqlite");
    let db = Database::connect(Backend::Sqlite, &database_url(&path))
        .await
        .unwrap();
    seed_tenant(&db).await;
    let original = policy(1);
    db.upsert_client_key(&original).await.unwrap();
    let mut raw = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TRIGGER reject_policy_update BEFORE UPDATE ON redrouter_control_client_keys BEGIN SELECT RAISE(ABORT,'injected late failure'); END;")
        .execute(&mut raw).await.unwrap();
    assert!(db.upsert_client_key(&policy(2)).await.is_err());
    assert_eq!(db.client_keys().await.unwrap(), vec![original.clone()]);
    sqlx::raw_sql("DROP TRIGGER reject_policy_update; CREATE TRIGGER reject_policy_insert BEFORE INSERT ON redrouter_control_client_keys BEGIN SELECT RAISE(ABORT,'injected insert failure'); END;")
        .execute(&mut raw).await.unwrap();
    let mut created = policy(3);
    created.id = "new-client".into();
    assert!(db.upsert_client_key(&created).await.is_err());
    for suffix in SIDECARS {
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*) FROM redrouter_control_client_key_{suffix} WHERE key_id='new-client'"
        ))
        .fetch_one(&mut raw)
        .await
        .unwrap();
        assert_eq!(count, 0, "failed insert left {suffix}");
    }
    assert_eq!(db.client_keys().await.unwrap(), vec![original]);
    raw.close().await.unwrap();
    db.close().await.unwrap();
}

#[tokio::test]
async fn independent_sqlite_instances_never_publish_mixed_policy_revisions() {
    let dir = TempDir::new().unwrap();
    let url = database_url(&dir.path().join("replicas.sqlite"));
    let reader = Database::connect(Backend::Sqlite, &url).await.unwrap();
    seed_tenant(&reader).await;
    reader.upsert_client_key(&policy(0)).await.unwrap();
    let first = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let second = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let barrier = Arc::new(tokio::sync::Barrier::new(3));
    let committed = Arc::new(AtomicUsize::new(0));
    let mut writers = Vec::new();
    for (index, db) in [first, second].into_iter().enumerate() {
        let barrier = barrier.clone();
        let committed = committed.clone();
        writers.push(tokio::spawn(async move {
            barrier.wait().await;
            for step in 0..24 {
                db.upsert_client_key(&policy((step * 2 + index + 1) as i64))
                    .await
                    .unwrap();
                committed.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
            }
            db.close().await.unwrap();
        }));
    }
    barrier.wait().await;
    let mut snapshots = 0;
    tokio::time::timeout(std::time::Duration::from_secs(45), async {
        loop {
            let keys = reader
                .client_keys()
                .await
                .expect("concurrent snapshot must remain available");
            assert_eq!(keys.len(), 1);
            assert_eq!(
                keys[0],
                policy(keys[0].revision),
                "mixed key fields across commits"
            );
            snapshots += 1;
            if committed.load(Ordering::SeqCst) == 48 {
                break;
            }
            // Propagate writer failures instead of masking them behind the timeout.
            if writers.iter().all(tokio::task::JoinHandle::is_finished) {
                break;
            }
            tokio::task::yield_now().await;
        }
        for writer in writers {
            writer.await.unwrap();
        }
    })
    .await
    .expect("bounded concurrent policy updates");
    assert_eq!(committed.load(Ordering::SeqCst), 48);
    assert!(snapshots > 0);
    reader.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_reader_snapshot_does_not_block_policy_commit() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("reader-snapshot.sqlite");
    let db = Database::connect(Backend::Sqlite, &database_url(&path))
        .await
        .unwrap();
    seed_tenant(&db).await;
    db.upsert_client_key(&policy(1)).await.unwrap();
    let mut reader = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut reader)
        .await
        .unwrap();
    assert_eq!(mode, "wal");
    let mut snapshot = reader.begin().await.unwrap();
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM redrouter_control_client_keys")
        .fetch_one(&mut *snapshot)
        .await
        .unwrap();
    assert_eq!(revision, 1);
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        db.upsert_client_key(&policy(2)),
    )
    .await
    .expect("reader must not stall writer")
    .unwrap();
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM redrouter_control_client_keys")
        .fetch_one(&mut *snapshot)
        .await
        .unwrap();
    assert_eq!(revision, 1, "reader keeps its consistent snapshot");
    assert_eq!(db.client_keys().await.unwrap(), vec![policy(2)]);
    snapshot.commit().await.unwrap();
    reader.close().await.unwrap();
    db.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_snapshot_keeps_defaults_for_keys_created_before_sidecars() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("old-schema.sqlite");
    let db = Database::connect(Backend::Sqlite, &database_url(&path))
        .await
        .unwrap();
    seed_tenant(&db).await;
    db.upsert_client_key(&policy(1)).await.unwrap();
    let mut raw = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    for suffix in SIDECARS {
        sqlx::query(&format!(
            "DELETE FROM redrouter_control_client_key_{suffix}"
        ))
        .execute(&mut raw)
        .await
        .unwrap();
    }
    let key = db.client_keys().await.unwrap().remove(0);
    assert_eq!(key.id, "shared-client");
    assert_eq!(key.model_id_format, "prefixed");
    assert_eq!(key.model_access_mode, "all");
    assert_eq!(key.allowed_combos_json, "null");
    assert_eq!(key.tenant_id, "red");
    assert_eq!(key.created_by, "legacy");
    assert!(key.access_schedule_json.is_empty());
    assert_eq!(key.max_tokens_per_day, 0);
    raw.close().await.unwrap();
    db.close().await.unwrap();
}
