"use client";


import { Coins } from "lucide-react";
import Icon from "@/shared/components/Icon";
interface TokenBadgeProps {
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export function TokenBadge({ tokensIn, tokensOut }: TokenBadgeProps) {
  if (!tokensIn && !tokensOut) return null;

  return (
    <span className="inline-flex items-center gap-1 rounded bg-purple-900/40 px-2 py-0.5 text-xs text-purple-300 font-mono">
      <Icon icon={Coins} size="sm" color="current" />
      {tokensIn != null && <span>{tokensIn}↑</span>}
      {tokensOut != null && <span>{tokensOut}↓</span>}
    </span>
  );
}
