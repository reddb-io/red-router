import { GoogleAnalytics } from "@next/third-parties/google";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";
import { BrandingProvider } from "@/shared/components/BrandingProvider";
import { brandingCss, loadBranding, publicBranding } from "@/lib/branding";

// Branding (white label) is read from branding.json on each request, so a new
// file applies on the next page load without a rebuild.
export const dynamic = "force-dynamic";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

export async function generateMetadata() {
  const brand = publicBranding(loadBranding());
  return {
    title: brand.custom ? brand.name : "RedRouter - AI Infrastructure Management",
    description: brand.custom ? brand.name : "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
    icons: { icon: brand.favicon || "/favicon.svg" },
  };
}

export const viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }) {
  const branding = loadBranding();
  const brand = publicBranding(branding);
  const themeCss = brandingCss(branding);
  // Before the user picks one, the branding's colour scheme is the default.
  const defaultScheme = JSON.stringify(brand.colorScheme || "system");
  return (
    <html lang="en" data-density="compact" suppressHydrationWarning>
      <head>
        {/* Apply persisted theme before first paint so a reload does not flash the
            default (light) theme before the client store hydrates. Mirrors the
            zustand-persist "theme" key and the `dark` class applyTheme() sets. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('theme');var t=s?(JSON.parse(s).state||{}).theme:${defaultScheme};t=t||${defaultScheme};var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=document.documentElement;d.setAttribute('data-theme','application');if(t==='dark'||(t==='system'&&m)){d.classList.add('dark');d.setAttribute('data-color-scheme','dark')}else{d.setAttribute('data-color-scheme','light')}}catch(e){}})();`,
          }}
        />
        {themeCss && <style id="branding-theme" dangerouslySetInnerHTML={{ __html: themeCss }} />}
      </head>
      <body className="font-sans antialiased">
        <BrandingProvider value={brand}>
          <ThemeProvider>
            <RuntimeI18nProvider>
              {children}
            </RuntimeI18nProvider>
          </ThemeProvider>
        </BrandingProvider>
        <GoogleAnalytics gaId={"G-LC959F603F"} />
      </body>
    </html>
  );
}
