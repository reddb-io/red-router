import Link from "next/link";

const AREAS = [
  {
    id: "connections",
    href: "/proxy/providers",
    label: "Connections",
    description: "Providers, credentials and destination URLs",
  },
  {
    id: "routes",
    href: "/dashboard/api-manager/routing",
    label: "Routes",
    description: "Public model IDs and authorized destinations",
  },
  {
    id: "policies",
    href: "/system/settings/routing",
    label: "Policies",
    description: "Model visibility, provider priority and tenant delegation",
  },
] as const;

export default function TrafficConfigurationGuide({ current }: { current?: string }) {
  return (
    <nav aria-label="Traffic configuration" className="space-y-2 border-b border-border pb-4">
      <ul className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
        {AREAS.map((area) => (
          <li key={area.id}>
            <Link
              href={area.href}
              aria-current={current === area.id ? "page" : undefined}
              className="font-medium text-primary hover:underline"
            >
              {area.label}
            </Link>
            <p className="text-xs text-text-muted">{area.description}</p>
          </li>
        ))}
      </ul>
    </nav>
  );
}
