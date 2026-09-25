"use client";

import { useState } from "react";
import NineRemotePromoModal from "./NineRemotePromoModal";
import Icon from "./Icon";

export default function NineRemoteButton() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all text-text-muted hover:text-text-main hover:bg-muted/50"
        title="9Remote"
      >
        <Icon name="computer" size={18} />
        <span className="text-xs font-medium">Remote</span>
      </button>

      <NineRemotePromoModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}
