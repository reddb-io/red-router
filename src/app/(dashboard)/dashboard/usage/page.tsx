import { redirect } from "next/navigation";

export default function UsageRedirectPage() {
  redirect("/observe/logs");
}
