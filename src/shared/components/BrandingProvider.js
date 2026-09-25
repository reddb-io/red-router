"use client";

import { createContext, useContext } from "react";

// The white-label identity the root layout read from branding.json (src/lib/branding.js).
const DEFAULT = { name: "RedRouter", custom: false, logo: null, logoDark: null, favicon: null, login: { title: "RedRouter" }, colorScheme: null };
const BrandingContext = createContext(DEFAULT);

export function BrandingProvider({ value, children }) {
  return <BrandingContext.Provider value={value || DEFAULT}>{children}</BrandingContext.Provider>;
}

export const useBranding = () => useContext(BrandingContext);

/** The brand's logo for the current colour scheme, or its name when it has none. */
export function BrandMark({ className = "h-7", textClassName = "text-lg font-semibold tracking-tight" }) {
  const brand = useBranding();
  if (!brand.logo) return <span className={textClassName}>{brand.name}</span>;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- operator-supplied URL or data URI */}
      <img src={brand.logo} alt={brand.name} className={`${className} w-auto dark:hidden`} />
      {/* eslint-disable-next-line @next/next/no-img-element -- operator-supplied URL or data URI */}
      <img src={brand.logoDark || brand.logo} alt={brand.name} className={`${className} hidden w-auto dark:block`} />
    </>
  );
}
