import { redirect } from "next/navigation";

export default async function LegacyMediaProvidersRedirect({ params }) {
  const { path } = await params;
  const parts = Array.isArray(path) ? path : [path];
  const canonical = parts.map((part) => part === "textClassification" ? "systemone" : part);
  redirect(`/dashboard/tools-providers/${canonical.map(encodeURIComponent).join("/")}`);
}
