import { redirect } from "next/navigation";

// `/dashboard/context` is a hub with only sub-routes (settings, combos, ultra,
// …) and no page of its own, so Next.js RSC prefetches of the bare parent
// route 404'd (#5298). Redirect the parent to its canonical sub-route, honoring
// a legacy `?tab=` query for deep links.
const CONTEXT_TAB_ROUTES: Record<string, string> = {
  settings: "/optimize/token-saver",
  combos: "/optimize/token-saver/combos",
  caveman: "/optimize/token-saver/engines/caveman",
  rtk: "/optimize/token-saver/engines/rtk",
  headroom: "/optimize/token-saver/engines/headroom",
  "session-dedup": "/optimize/token-saver/engines/session-dedup",
  sessionDedup: "/optimize/token-saver/engines/session-dedup",
  ccr: "/optimize/token-saver/engines/ccr",
  llmlingua: "/optimize/token-saver/engines/llmlingua",
  lite: "/optimize/token-saver/engines/lite",
  aggressive: "/optimize/token-saver/engines/aggressive",
  ultra: "/optimize/token-saver/engines/ultra",
};

const DEFAULT_CONTEXT_ROUTE = "/optimize/token-saver";

export function resolveContextRoute(value: string | undefined): string {
  return value ? CONTEXT_TAB_ROUTES[value] || DEFAULT_CONTEXT_ROUTE : DEFAULT_CONTEXT_ROUTE;
}

type ContextPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ContextPage({ searchParams }: ContextPageProps) {
  const params = searchParams ? await searchParams : {};
  const tab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  redirect(resolveContextRoute(tab));
}
