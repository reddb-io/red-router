import { permanentRedirect } from "next/navigation";

export default function LogsActivityRedirect() {
  permanentRedirect("/observe/logs/activity");
}
