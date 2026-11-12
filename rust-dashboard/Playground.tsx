import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Card } from "./components";

type Message = { role: "user" | "assistant"; content: string };
const inputClass = "w-full rounded border border-border bg-surface px-3 py-2 text-text-main";

export default function Playground() {
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || !key.trim() || !model.trim() || !prompt.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    const next: Message[] = [...messages, { role: "user", content: prompt.trim() }];
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.trim()}` },
        body: JSON.stringify({ model: model.trim(), messages: next, stream: false }),
        signal: controller.signal,
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = result && typeof result === "object" && "error" in result
          ? (result as { error?: { message?: unknown } }).error?.message
          : null;
        throw new Error(typeof detail === "string" ? detail : `Request failed (${response.status}).`);
      }
      const content = (result as { choices?: Array<{ message?: { content?: unknown } }> } | null)
        ?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("The response did not contain text.");
      setMessages([...next, { role: "assistant", content }]);
      setPrompt("");
    } catch (cause) {
      setError(controller.signal.aborted ? "Request cancelled." : cause instanceof Error ? cause.message : "Request failed.");
    } finally {
      if (request.current === controller) request.current = null;
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Playground</h1>
        <p className="mt-1 text-sm text-text-muted">Send a chat request through your configured gateway.</p>
      </div>
      <Card title="Connection">
        <div className="grid gap-4 md:grid-cols-2">
          <label>API key<input className={inputClass} type="password" autoComplete="off" disabled={busy} value={key} onChange={(event) => setKey(event.target.value)} /></label>
          <label>Model or combo<input className={inputClass} disabled={busy} value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" /></label>
        </div>
        <p className="mt-2 text-sm text-text-muted">The key stays in this page's memory and is sent with each request.</p>
      </Card>
      <Card title="Conversation" action={<Button variant="outline" disabled={busy || messages.length === 0} onClick={() => setMessages([])}>Clear</Button>}>
        {messages.length === 0 ? <p className="text-sm text-text-muted">Your conversation will appear here.</p> : (
          <ol className="space-y-4" aria-label="Conversation">
            {messages.map((message, index) => (
              <li key={index} className="rounded border border-border p-3">
                <strong className="text-sm">{message.role === "user" ? "You" : "Assistant"}</strong>
                <p className="mt-2 whitespace-pre-wrap break-words">{message.content}</p>
              </li>
            ))}
          </ol>
        )}
        {error && <p role="alert" className="mt-4 text-sm text-error">{error}</p>}
        <form onSubmit={(event) => void send(event)} className="mt-4 space-y-3">
          <label className="block">Message<textarea className={inputClass} rows={4} disabled={busy} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !key.trim() || !model.trim() || !prompt.trim()}>Send</Button>
            {busy && <Button variant="outline" onClick={() => request.current?.abort()}>Cancel</Button>}
          </div>
        </form>
      </Card>
    </section>
  );
}
