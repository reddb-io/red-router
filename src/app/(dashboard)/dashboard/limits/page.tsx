import { redirect } from "next/navigation";

export default function LimitsRedirect() {
  redirect("/observe/costs/quota");
}
