import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Card } from "./components";

type Message = { role: "user" | "assistant"; content: string };
const inputClass = "w-full rounded border border-border bg-surface px-3 py-2 text-text-main";

export async function readChatStream(response: Response, onText: (text: string) => void): Promise<string> {
  if (!response.body) throw new Error("The response stream is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let done = false;
  const processEvent = (event: string) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    if (data === "[DONE]") { done = true; return; }
    let parsed: { error?: { message?: unknown }; choices?: Array<{ delta?: { content?: unknown } }> };
    try { parsed = JSON.parse(data); } catch { throw new Error("The response stream contained invalid data."); }
    if (parsed.error) throw new Error(typeof parsed.error.message === "string" ? parsed.error.message : "The response stream failed.");
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === "string") { text += delta; onText(text); }
  };
  try {
    while (!done) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        processEvent(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
        if (done) break;
      }
      if (chunk.done) {
        if (buffer.trim()) processEvent(buffer);
        break;
      }
    }
    if (!done) throw new Error("The response stream ended unexpectedly.");
    return text;
  } finally {
    if (done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export default function Playground() {
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsMessage, setModelsMessage] = useState("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState(true);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const modelsRequest = useRef<AbortController | null>(null);

  useEffect(() => () => {
    request.current?.abort();
    modelsRequest.current?.abort();
  }, []);

  function changeKey(value: string) {
    modelsRequest.current?.abort();
    modelsRequest.current = null;
    setModelsLoading(false);
    setModels([]);
    setModelsMessage("");
    setKey(value);
  }

  async function loadModels() {
    if (!key.trim() || modelsRequest.current) return;
    const controller = new AbortController();
    modelsRequest.current = controller;
    setModelsLoading(true);
    setModelsMessage("");
    setModels([]);
    try {
      const response = await fetch("/v1/models", {
        headers: { Authorization: `Bearer ${key.trim()}`, Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = body && typeof body === "object" && "error" in body
          ? (body as { error?: { message?: unknown } }).error?.message
          : null;
        throw new Error(typeof detail === "string" ? detail : `Could not load models (${response.status}).`);
      }
      const data = body && typeof body === "object" && "data" in body
        ? (body as { data?: unknown }).data : null;
      if (!Array.isArray(data)) throw new Error("Invalid model list response.");
      const ids = [...new Set(data.flatMap((item: unknown) => {
        if (!item || typeof item !== "object" || !("id" in item)) return [];
        const id = (item as { id?: unknown }).id;
        return typeof id === "string" && id.trim() ? [id] : [];
      }))].sort((a, b) => a.localeCompare(b));
      if (controller.signal.aborted) return;
      setModels(ids);
      setModelsMessage(ids.length ? `${ids.length} models available to this key.` : "No models were listed for this key. You can still enter a model or combo manually.");
    } catch (cause) {
      if (!controller.signal.aborted) setModelsMessage(cause instanceof Error ? cause.message : "Could not load models.");
    } finally {
      if (modelsRequest.current === controller) {
        modelsRequest.current = null;
        setModelsLoading(false);
      }
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || !key.trim() || !model.trim() || !prompt.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    const next: Message[] = [...messages, { role: "user", content: prompt.trim() }];
    setBusy(true);
    setError("");
    setPartial("");
    try {
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.trim()}` },
        body: JSON.stringify({ model: model.trim(), messages: next, stream }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const result: unknown = await response.json().catch(() => null);
        const detail = result && typeof result === "object" && "error" in result
          ? (result as { error?: { message?: unknown } }).error?.message
          : null;
        throw new Error(typeof detail === "string" ? detail : `Request failed (${response.status}).`);
      }
      let content: unknown;
      if (stream) content = await readChatStream(response, setPartial);
      else {
        const result = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
        content = result?.choices?.[0]?.message?.content;
      }
      if (typeof content !== "string") throw new Error("The response did not contain text.");
      setMessages([...next, { role: "assistant", content }]);
      setPrompt("");
      setPartial("");
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
          <label>API key<input className={inputClass} type="password" autoComplete="off" disabled={busy} value={key} onChange={(event) => changeKey(event.target.value)} /></label>
          <label>Model or combo<input className={inputClass} list="playground-models" disabled={busy} value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" /></label>
          <datalist id="playground-models">{models.map((id) => <option key={id} value={id} />)}</datalist>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="outline" disabled={busy || modelsLoading || !key.trim()} onClick={() => void loadModels()}>
            {modelsLoading ? "Loading models…" : "Load available models"}
          </Button>
          {modelsMessage && <p role="status" className="text-sm text-text-muted">{modelsMessage}</p>}
        </div>
        <p className="mt-2 text-sm text-text-muted">The key stays in this page's memory and is sent with each request.</p>
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={stream} disabled={busy} onChange={(event) => setStream(event.target.checked)} /> Stream responses</label>
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
        {partial && <div className="mt-4 rounded border border-border p-3"><strong className="text-sm">Assistant (partial)</strong><p className="mt-2 whitespace-pre-wrap break-words">{partial}</p></div>}
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
