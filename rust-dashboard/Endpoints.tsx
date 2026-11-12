import { useState } from "react";
import { Button, Card } from "./components";

const endpoints = [
  { method: "POST", path: "/v1/chat/completions", label: "Chat completions" },
  { method: "POST", path: "/v1/responses", label: "Responses" },
  { method: "POST", path: "/v1/messages", label: "Messages" },
  { method: "POST", path: "/v1/embeddings", label: "Embeddings" },
  { method: "POST", path: "/v1/rerank", label: "Rerank" },
  { method: "GET", path: "/v1/models", label: "Models" },
] as const;

export default function Endpoints() {
  const [message, setMessage] = useState("");
  const baseUrl = `${window.location.origin}/v1`;

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("Address copied.");
    } catch {
      setMessage("Could not copy the address. Select and copy it manually.");
    }
  };

  return (
    <section className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Endpoint</h1>
        <p className="mt-1 text-sm text-text-muted">
          Connect your applications to RedRouter using an API key.
        </p>
      </div>
      <Card title="Base URL" subtitle="Use this address in an OpenAI-compatible client.">
        <div className="flex flex-wrap items-center gap-3">
          <code className="min-w-0 flex-1 break-all rounded border border-border bg-bg px-3 py-2 text-sm">
            {baseUrl}
          </code>
          <Button variant="outline" onClick={() => void copy(baseUrl)}>Copy URL</Button>
        </div>
        <p className="mt-3 text-sm text-text-muted">
          This is the address used by your browser. Clients on another machine need an address they can reach.
        </p>
        {message && <p role="status" className="mt-2 text-sm">{message}</p>}
        <a href="/dashboard/api-manager" className="mt-4 inline-block text-sm text-primary underline">
          Manage API keys
        </a>
      </Card>
      <Card title="API endpoints" subtitle="Choose the protocol supported by your client.">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-border"><th className="p-2">Operation</th><th className="p-2">Method</th><th className="p-2">Path</th></tr></thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.path} className="border-b border-border last:border-0">
                  <td className="p-2">{endpoint.label}</td>
                  <td className="p-2"><code>{endpoint.method}</code></td>
                  <td className="p-2"><code>{endpoint.path}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
