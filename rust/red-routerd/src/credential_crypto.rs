//! Keep scrypt off the HTTP/OAuth executor without changing the persisted format.
use zeroize::Zeroizing;

// Each scrypt operation uses approximately 16 MiB. This bounds cryptographic work,
// not inference or agent concurrency. Hold the permit inside the blocking job so
// cancelling its awaiting HTTP request cannot admit more concurrent allocations.
static WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[cfg(test)]
pub(super) async fn reserve_workers_for_test() -> tokio::sync::SemaphorePermit<'static> {
    WORKERS.acquire_many(2).await.unwrap()
}

pub(crate) async fn encrypt_async(
    value: &str,
    id: &str,
    secret: &str,
) -> Result<String, &'static str> {
    let permit = WORKERS
        .acquire()
        .await
        .map_err(|_| "credential worker unavailable")?;
    let value = Zeroizing::new(value.to_owned());
    let id = id.to_owned();
    let secret = Zeroizing::new(secret.to_owned());
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        super::encrypt(&value, &id, &secret)
    })
    .await
    .map_err(|_| "credential worker failed")?
}

pub(crate) async fn decrypt_async(
    stored: &str,
    id: &str,
    secret: &str,
) -> Result<Zeroizing<String>, &'static str> {
    let permit = WORKERS
        .acquire()
        .await
        .map_err(|_| "credential worker unavailable")?;
    let stored = stored.to_owned();
    let id = id.to_owned();
    let secret = Zeroizing::new(secret.to_owned());
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        super::decrypt(&stored, &id, &secret)
    })
    .await
    .map_err(|_| "credential worker failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[tokio::test(flavor = "current_thread")]
    async fn credential_work_yields_to_requests_and_preserves_identity_binding() {
        let progressed = Arc::new(AtomicBool::new(false));
        let observed = progressed.clone();
        let other_request = tokio::spawn(async move {
            observed.store(true, Ordering::SeqCst);
        });
        let ciphertext = encrypt_async(
            "provider-secret",
            "account-a",
            "fixture-storage-key-1234567890",
        )
        .await
        .unwrap();
        assert!(
            progressed.load(Ordering::SeqCst),
            "credential derivation blocked the HTTP executor"
        );
        other_request.await.unwrap();
        assert_eq!(
            decrypt_async(&ciphertext, "account-a", "fixture-storage-key-1234567890")
                .await
                .unwrap()
                .as_str(),
            "provider-secret"
        );
        assert!(
            decrypt_async(&ciphertext, "account-b", "fixture-storage-key-1234567890")
                .await
                .is_err()
        );
    }
}
