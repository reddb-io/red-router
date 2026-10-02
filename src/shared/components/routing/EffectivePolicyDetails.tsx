import type { EffectivePolicySnapshot } from "@/lib/routing/effectivePolicy";

export default function EffectivePolicyDetails({
  snapshot,
}: {
  snapshot: EffectivePolicySnapshot;
}) {
  return (
    <div className="space-y-5">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="pb-2 text-left font-semibold text-text-main">
            Effective policy
          </caption>
          <thead className="text-xs text-text-muted">
            <tr>
              <th scope="col" className="py-2 pr-4">
                Setting
              </th>
              <th scope="col" className="py-2 pr-4">
                Effective value
              </th>
              <th scope="col" className="py-2">
                Defined by
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {snapshot.rows.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="py-3 pr-4 align-top font-medium">
                  {row.setting}
                </th>
                <td className="py-3 pr-4 align-top break-words">
                  {row.value}
                  <p className="mt-1 max-w-prose text-xs text-text-muted">{row.explanation}</p>
                </td>
                <td className="py-3 align-top text-text-muted">{row.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {snapshot.access && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">API key restrictions</summary>
          <dl className="mt-2 space-y-2 text-text-muted">
            <div>
              <dt className="font-medium">Model access</dt>
              <dd className="break-words">
                {snapshot.access.modelAccessMode}
                {snapshot.access.allowedModels.length > 0
                  ? `: ${snapshot.access.allowedModels.join(", ")}`
                  : ""}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Blocked models</dt>
              <dd className="break-words">
                {snapshot.access.blockedModels.join(", ") || "None configured on this key"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Allowed endpoints</dt>
              <dd>
                {snapshot.access.allowedEndpoints.join(", ") ||
                  "No endpoint restriction on this key"}
              </dd>
            </div>
          </dl>
        </details>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Connections in this scope</h3>
        <p className="text-xs text-text-muted">
          Defined by: {snapshot.connectionSource}. Live dispatch also checks provider health,
          budgets, quotas and model access.
        </p>
        {snapshot.connections.length === 0 ? (
          <p className="text-sm text-text-muted">No connections are accessible in this scope.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {snapshot.connections.map((connection) => (
              <li
                key={connection.id}
                className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2"
              >
                <span>
                  {connection.name}{" "}
                  <span className="text-xs text-text-muted">({connection.provider})</span>
                </span>
                <span className="text-text-muted">
                  {!connection.enabled
                    ? "Disabled"
                    : connection.cooldownUntil
                      ? "Cooling down"
                      : "Enabled"}
                  {connection.cooldownUntil && (
                    <>
                      {" "}
                      until{" "}
                      <time dateTime={connection.cooldownUntil}>{connection.cooldownUntil}</time>
                    </>
                  )}
                  {connection.testStatus
                    ? ` · Last recorded test: ${connection.testStatus}`
                    : " · No recorded test"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
