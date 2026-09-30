"use client";

import { Bandage } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useState, useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

export default function DegradationBadge() {
  const [isDegraded, setDegraded] = useState(false);
  const t = useTranslations("common"); // Or a specific namespace if needed

  useEffect(() => {
    const checkDegradation = async () => {
      try {
        const res = await fetch("/api/health/degradation?summary=true");
        if (res.ok) {
          const data = await res.json();
          setDegraded(data.isDegraded);
        }
      } catch (err) {
        // Ignore error
      }
    };

    checkDegradation();
    const interval = setInterval(checkDegradation, 60000);
    return () => clearInterval(interval);
  }, []);

  if (!isDegraded) return null;

  return (
    <Link
      href="/observe/health"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors border border-amber-500/20"
      title={t("warning")} // Using common warning text, or we could just use English / fixed string if i18n is not strict
    >
      <Icon icon={Bandage} size="md" color="current" />
      <span className="text-xs font-semibold whitespace-nowrap">{t("degraded")}</span>
    </Link>
  );
}
