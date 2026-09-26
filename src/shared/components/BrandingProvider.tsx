"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PublicBranding } from "@/lib/branding/branding";

const DEFAULT_BRANDING: PublicBranding = {
  name: "RedRouter",
  custom: false,
  logo: null,
  logoDark: null,
  favicon: null,
  login: {
    title: "RedRouter",
    subtitle: null,
    footer: null,
    backgroundColor: null,
    backgroundImage: null,
  },
  colorScheme: null,
  theme: { primary: null, primaryHover: null },
};

const BrandingContext = createContext<PublicBranding>(DEFAULT_BRANDING);

export function BrandingProvider({
  value,
  children,
}: {
  value: PublicBranding;
  children: ReactNode;
}) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export const useBranding = (): PublicBranding => useContext(BrandingContext);
