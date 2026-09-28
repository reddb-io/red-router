import { DashboardLayout } from "@/shared/components";

// The authenticated control plane is request-driven. Pre-rendering every dashboard
// route duplicates large RSC/HTML payloads in the release artifact and provides no
// useful static response because the browser immediately loads live local state.
export const dynamic = "force-dynamic";

export default function DashboardRootLayout({ children }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
