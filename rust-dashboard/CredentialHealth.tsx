import { useEffect, useState } from "react";
import { rustAdminFetch } from "./api/browserClient";

type Account = {
  provider_id: string;
  provider: string;
  status: "active" | "error";
  last_error: string | null;
  error_type: string | null;
  warning: string | null;
  latency_ms: number;
  checked_at_unix_ms: number;
  fresh: boolean;
  consecutive_failures: number;
  next_check_at_unix_ms: number;
};
type Report = {
  summary: { total: number; active: number; error: number };
  accounts: Account[];
};

function isReport(value: unknown): value is Report {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.accounts) && typeof record.summary === "object";
}

function utc(unixMs: number): string {
  return new Date(unixMs).toISOString().replace("T", " ").slice(0, 19);
}

/** Latest background credential probe of each account (legacy credential health). */
export default function CredentialHealth() {
  const [refresh, setRefresh] = useState(0);
  const [sweeping, setSweeping] = useState(false);
  const [notice, setNotice] = useState("");
  // The result of the latest refresh; an older one reads as loading.
  const [result, setResult] = useState<{
    refresh: number;
    report: Report | null;
    error: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    rustAdminFetch("/api/admin/credential-health", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Credential health unavailable (${response.status})`);
        const data: unknown = await response.json();
        if (!isReport(data)) throw new Error("Invalid credential health report");
        setResult({ refresh, report: data, error: "" });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setResult({
            refresh,
            report: null,
            error: cause instanceof Error ? cause.message : "Credential health unavailable",
          });
      });
    return () => controller.abort();
  }, [refresh]);

  const sweep = () => {
    setSweeping(true);
    setNotice("");
    rustAdminFetch("/api/admin/credential-health/sweep", { method: "POST" })
      .then(async (response) => {
        if (response.status === 409) throw new Error("A sweep is already running.");
        if (!response.ok) throw new Error(`Sweep failed (${response.status})`);
        const data = (await response.json()) as { probed?: number };
        setNotice(`Probed ${data.probed ?? 0} account(s) that were due.`);
      })
      .catch((cause) => setNotice(cause instanceof Error ? cause.message : "Sweep failed"))
      .finally(() => {
        setSweeping(false);
        setRefresh((value) => value + 1);
      });
  };

  const current = result?.refresh === refresh ? result : null;
  const report = current?.report;

  return (
    <section className="space-y-3 rounded border border-border p-4" aria-label="Credential health">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Credential health</h2>
          <p className="text-sm text-text-muted">
            A background sweep probes every enabled account hourly. A failed probe is retried after
            5, 10 and 30 minutes, then every 2 hours; for 5 minutes after it, combos skip the
            account.
          </p>
        </div>
        <button
          type="button"
          className="rounded border border-border px-3 py-2"
          disabled={sweeping}
          onClick={sweep}
        >
          {sweeping ? "Sweeping…" : "Run sweep now"}
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {current?.error && (
        <p role="alert" className="text-error">
          {current.error}
        </p>
      )}
      {!current && <p>Loading credential health…</p>}
      {report && report.accounts.length === 0 && (
        <p>No account has been probed yet. The first sweep runs 30 seconds after the daemon starts.</p>
      )}
      {report && report.accounts.length > 0 && (
        <>
          <p className="text-sm">
            {report.summary.active} healthy · {report.summary.error} failing ·{" "}
            {report.summary.total} probed
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Checked (UTC)</th>
                  <th>Next check (UTC)</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {report.accounts.map((account) => (
                  <tr key={account.provider_id}>
                    <td>
                      {account.provider_id}
                      <small> ({account.provider})</small>
                    </td>
                    <td>
                      <span className={account.status === "active" ? "text-success" : "text-error"}>
                        {account.status === "active" ? "Healthy" : "Failing"}
                      </span>
                      {account.status === "error" && (
                        <small>
                          {" "}
                          {account.last_error} · {account.consecutive_failures} in a row
                          {account.fresh ? " · combos skip it" : ""}
                        </small>
                      )}
                      {account.warning && <small className="text-warning"> {account.warning}</small>}
                    </td>
                    <td>{utc(account.checked_at_unix_ms)}</td>
                    <td>{utc(account.next_check_at_unix_ms)}</td>
                    <td>{account.latency_ms.toLocaleString()} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
