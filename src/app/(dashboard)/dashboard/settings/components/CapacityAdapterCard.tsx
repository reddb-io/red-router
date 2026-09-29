"use client";

// Fallback model pools for media a combo cannot take. When a request carries an image, audio or
// video and no member of the combo can read it, the models named here are tried first instead of
// the request failing. Off by default; every pool member is a model on one of your accounts, so
// you name them yourself.

import { Layers } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useEffect, useState } from "react";
import { Button, Card, Toggle } from "@/shared/components";

type Modality = "vision" | "audio" | "video";
interface Pool {
  enabled: boolean;
  models: string;
}

const MODALITIES: Array<{ id: Modality; label: string; hint: string }> = [
  { id: "vision", label: "Images", hint: "Requests that contain an image." },
  { id: "audio", label: "Audio", hint: "Requests that contain audio input." },
  { id: "video", label: "Video", hint: "Requests that contain video input." },
];

const EMPTY: Record<Modality, Pool> = {
  vision: { enabled: false, models: "" },
  audio: { enabled: false, models: "" },
  video: { enabled: false, models: "" },
};

export default function CapacityAdapterCard() {
  const [pools, setPools] = useState<Record<Modality, Pool>>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((response) => response.json())
      .then((data) => {
        const saved = data?.capacityAdapter ?? {};
        setPools(
          Object.fromEntries(
            MODALITIES.map(({ id }) => [
              id,
              {
                enabled: saved[id]?.enabled === true,
                models: Array.isArray(saved[id]?.models) ? saved[id].models.join("\n") : "",
              },
            ])
          ) as Record<Modality, Pool>
        );
      })
      .finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const capacityAdapter = Object.fromEntries(
        MODALITIES.map(({ id }) => [
          id,
          {
            enabled: pools[id].enabled,
            models: pools[id].models
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          },
        ])
      );
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacityAdapter }),
      });
      const data = await response.json().catch(() => null);
      setStatus(
        response.ok
          ? { ok: true, message: "Saved." }
          : { ok: false, message: data?.error?.message || "Could not save the pools." }
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          <Icon icon={Layers} size="lg" color="current" />
        </div>
        <div>
          <p className="font-medium">Capacity adapter</p>
          <p className="text-sm text-text-muted">
            When a combo has no model that can read the media in a request, try these models first
            instead of failing. A combo that already has one is never changed.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {MODALITIES.map(({ id, label, hint }) => (
          <div key={id} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-text-muted">{hint}</p>
              </div>
              <Toggle
                checked={pools[id].enabled}
                onChange={() =>
                  setPools((previous) => ({
                    ...previous,
                    [id]: { ...previous[id], enabled: !previous[id].enabled },
                  }))
                }
                disabled={!loaded}
              />
            </div>
            <textarea
              aria-label={`${label} pool models`}
              rows={2}
              value={pools[id].models}
              disabled={!loaded || !pools[id].enabled}
              onChange={(event) =>
                setPools((previous) => ({
                  ...previous,
                  [id]: { ...previous[id], models: event.target.value },
                }))
              }
              placeholder={"provider/model, one per line, in the order to try them"}
              className="rounded border border-control-edge bg-surface px-3 py-2 font-mono text-xs text-text-main disabled:opacity-50"
            />
          </div>
        ))}
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={!loaded || busy}>
            Save
          </Button>
          {status && (
            <p
              role="status"
              className={`text-sm ${status.ok ? "text-feedback-success-foreground" : "text-feedback-danger-foreground"}`}
            >
              {status.message}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
