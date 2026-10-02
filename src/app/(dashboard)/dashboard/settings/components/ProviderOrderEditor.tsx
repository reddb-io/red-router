"use client";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { Badge, Button } from "@/shared/components";
import {
  addItem,
  moveItem,
  removeItem,
  unlisted,
  type ProviderOption,
} from "./providerPriorityList";

/** An ordered list with move, remove and add: the first provider is tried first. */
export default function OrderEditor({
  order,
  providers,
  onChange,
  label,
}: {
  order: string[];
  providers: ProviderOption[];
  onChange: (next: string[]) => void;
  label: string;
}) {
  const nameOf = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;
  const missing = (id: string) => !providers.some((provider) => provider.id === id);
  const rest = unlisted(providers, order);
  return (
    <div className="flex flex-col gap-2" aria-label={label}>
      {order.length === 0 ? (
        <p className="text-xs text-text-muted">
          No order set: providers are tried in the catalog&apos;s own order.
        </p>
      ) : (
        <ol className="divide-y divide-border rounded-md border border-border text-xs">
          {order.map((id, index) => (
            <li key={id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="w-5 tabular-nums text-text-muted">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-text-main">{nameOf(id)}</span>
              {missing(id) ? (
                <Badge size="sm" variant="warning">
                  No active connection
                </Badge>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Move ${nameOf(id)} up`}
                disabled={index === 0}
                onClick={() => onChange(moveItem(order, index, -1))}
              >
                <Icon icon={ArrowUp} size="sm" color="current" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Move ${nameOf(id)} down`}
                disabled={index === order.length - 1}
                onClick={() => onChange(moveItem(order, index, 1))}
              >
                <Icon icon={ArrowDown} size="sm" color="current" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${nameOf(id)} from the order`}
                onClick={() => onChange(removeItem(order, id))}
              >
                <Icon icon={X} size="sm" color="current" />
              </Button>
            </li>
          ))}
        </ol>
      )}
      {rest.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
          <span>Add:</span>
          {rest.map((provider) => (
            <Button
              key={provider.id}
              variant="outline"
              size="sm"
              aria-label={`Add ${provider.name} to the order`}
              onClick={() => onChange(addItem(order, provider.id))}
            >
              <Icon icon={Plus} size="sm" color="current" />
              {provider.name}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
