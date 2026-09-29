import { redirect } from "next/navigation";

// "Skills" is a menu entry with three pages; it opens on the skills themselves.
export default function Page() {
  redirect("/dashboard/omni-skills");
}
