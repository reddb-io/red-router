import { redirect } from "next/navigation";

export default function OneProxyPage() {
  redirect("/system/outbound-proxies?tab=free-pool");
}
