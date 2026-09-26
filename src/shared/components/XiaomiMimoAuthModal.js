"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import Icon from "./Icon";

/**
 * Xiaomi MiMo Auth Modal
 *
 * Auto-imports credentials from the local Xiaomi MiMo Desktop auth.json (~/.local/share/mimocode/auth.json).
 * If auto-import fails, offers a one-click browser OAuth fallback.
 * Reached only via the "Connect with OAuth" button — the API-key path uses the
 * standard Add API Key modal, since Xiaomi MiMo supports both auth modes.
 */
export default function XiaomiMimoAuthModal({ isOpen, onSuccess, onClose }) {
  const [phase, setPhase] = useState("detecting"); // detecting | found | not-found | importing | error
  const [detectResult, setDetectResult] = useState(null);
  const [error, setError] = useState(null);
  const [oauthUrl, setOauthUrl] = useState(null);
  const [oauthState, setOauthState] = useState(null);

  // Auto-detect local credentials when modal opens
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    (async () => {
      setPhase("detecting");
      setError(null);
      setDetectResult(null);
      setOauthUrl(null);

      try {
        const res = await fetch("/api/oauth/xiaomi-mimo/auto-import");
        const data = await res.json();
        if (cancelled) return;

        if (data.found && data.apiKey) {
          setDetectResult(data);
          setPhase("found");
        } else {
          setPhase("not-found");
          setError(data.error || "Xiaomi MiMo Desktop credentials not found on this machine.");
        }
      } catch {
        if (!cancelled) {
          setPhase("not-found");
          setError("Failed to read local Xiaomi MiMo Desktop credentials.");
        }
      }
    })();

    return () => { cancelled = true; };
  }, [isOpen]);

  // Import the auto-detected key
  const handleImport = async () => {
    if (!detectResult?.apiKey) return;
    setPhase("importing");
    setError(null);

    try {
      const res = await fetch("/api/oauth/xiaomi-mimo/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: detectResult.apiKey,
          uid: detectResult.uid,
          baseUrl: detectResult.baseUrl,
          mimoPassToken: detectResult.mimoPassToken || null,
          mimoUserId: detectResult.mimoUserId || null,
          mimoCUserId: detectResult.mimoCUserId || null,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || "Import failed");
      }

      onSuccess?.(data.connection);
      onClose();
    } catch (err) {
      setPhase("found");
      setError(err.message);
    }
  };

  // Start browser OAuth fallback
  const handleStartOAuth = async () => {
    setError(null);
    try {
      const state = crypto.randomUUID();
      const res = await fetch(`/api/oauth/xiaomi-mimo/authorize?state=${state}`);
      const data = await res.json();
      if (data.authorizeUrl) {
        setOauthUrl(data.authorizeUrl);
        setOauthState(data.state);
        window.open(data.authorizeUrl, "_blank", "width=600,height=700");
      } else {
        throw new Error(data.error || "Failed to start OAuth");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  // Poll OAuth result
  const handlePollOAuth = async () => {
    if (!oauthState) return;
    setError(null);
    try {
      const res = await fetch(`/api/oauth/xiaomi-mimo/poll-status?state=${oauthState}`);
      const data = await res.json();

      if (data.status === "done" && data.result) {
        // Exchange to create the connection
        const exRes = await fetch("/api/oauth/xiaomi-mimo/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: oauthState }),
        });
        const exData = await exRes.json();
        if (exData.success) {
          onSuccess?.(exData.connection);
          onClose();
        } else {
          throw new Error(exData.error || "Exchange failed");
        }
      } else if (data.status === "error") {
        throw new Error(data.error || "OAuth failed");
      } else {
        setError("Authorization not completed yet. Finish in the browser, then click Check Again.");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Connect Xiaomi MiMo" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* Detecting */}
        {phase === "detecting" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <Icon name="progress_activity" className="text-3xl text-primary animate-spin" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Reading local credentials...</h3>
            <p className="text-sm text-text-muted">
              Checking ~/.local/share/mimocode/auth.json
            </p>
          </div>
        )}

        {/* Found — one-click import */}
        {phase === "found" && detectResult && (
          <>
            <div className="bg-feedback-success-surface p-3 rounded-lg border border-feedback-success-border">
              <div className="flex gap-2">
<<<<<<< HEAD
                <Icon name="check_circle" size={24} className="text-feedback-success-foreground" />
||||||| e6e8d110
                <span className="material-symbols-outlined text-[var(--reddb-color-feedback-success-foreground)]">check_circle</span>
                <div className="text-sm text-[var(--reddb-color-feedback-success-foreground)]">
=======
                <span className="material-symbols-outlined text-feedback-success-foreground">check_circle</span>
>>>>>>> feat/ds-v2026.09
                <div className="text-sm text-feedback-success-foreground">
                  <p className="font-medium">Xiaomi MiMo Desktop credentials found!</p>
                  <p className="mt-1 opacity-80">
                    UID: {detectResult.uid || "—"} · Source: {detectResult.source?.split(/[\\/]/).pop()}
                  </p>
                </div>
              </div>
            </div>

            {error && (
              <div className="bg-feedback-danger-surface p-3 rounded-lg border border-feedback-danger-border">
                <p className="text-sm text-feedback-danger-foreground">{error}</p>
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={handleImport} fullWidth>
                Connect with Local Credentials
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}

        {/* Importing */}
        {phase === "importing" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <Icon name="progress_activity" className="text-3xl text-primary animate-spin" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Connecting...</h3>
          </div>
        )}

        {/* Not found — offer OAuth fallback */}
        {phase === "not-found" && (
          <>
            <div className="bg-feedback-warning-surface p-3 rounded-lg border border-feedback-warning-border">
              <div className="flex gap-2 items-start">
<<<<<<< HEAD
                <Icon name="info" size={24} className="text-feedback-warning-foreground" />
||||||| e6e8d110
                <span className="material-symbols-outlined text-[var(--reddb-color-feedback-warning-foreground)]">info</span>
                <div className="text-sm text-[var(--reddb-color-feedback-warning-foreground)]">
=======
                <span className="material-symbols-outlined text-feedback-warning-foreground">info</span>
>>>>>>> feat/ds-v2026.09
                <div className="text-sm text-feedback-warning-foreground">
                  <p className="font-medium">Local credentials not found</p>
                  <p className="mt-1 opacity-80">{error}</p>
                  <p className="mt-2 opacity-80">
                    Make sure Xiaomi MiMo Desktop is installed and you are signed in, then retry.
                    Or sign in via browser below.
                  </p>
                </div>
              </div>
            </div>

            {!oauthUrl ? (
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setPhase("detecting");
                    // Re-trigger detect
                    fetch("/api/oauth/xiaomi-mimo/auto-import")
                      .then((r) => r.json())
                      .then((data) => {
                        if (data.found && data.apiKey) {
                          setDetectResult(data);
                          setPhase("found");
                        } else {
                          setPhase("not-found");
                          setError(data.error || "Still not found.");
                        }
                      })
                      .catch(() => setPhase("not-found"));
                  }}
                  variant="outline"
                  fullWidth
                >
                  Retry Local Detect
                </Button>
                <Button onClick={handleStartOAuth} fullWidth>
                  Sign in via Browser
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="bg-feedback-info-surface p-3 rounded-lg border border-feedback-info-border">
                  <p className="text-sm text-feedback-info-foreground">
                    Browser opened. Complete the Xiaomi sign-in, then click{" "}
                    <strong>Check Again</strong>.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button onClick={handlePollOAuth} fullWidth>
                    Check Again
                  </Button>
                  <Button onClick={onClose} variant="ghost" fullWidth>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

XiaomiMimoAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
