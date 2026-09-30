import { redirect } from "next/navigation";

export default function AutoComboRedirectPage() {
  redirect("/proxy/combos?filter=intelligent");
}
