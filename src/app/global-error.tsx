"use client";

import { NextIntlClientProvider, useTranslations } from "next-intl";
import enMessages from "@/i18n/messages/en.json";

/**
 * Global Error Page — FASE-04 Error Handling
 *
 * Root-level error boundary for unrecoverable errors.
 * This is the last resort — catches errors that the per-page
 * error.js boundaries don't handle.
 */

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

function buildGlobalErrorMessages(localeMessages: Record<string, unknown>) {
  const publicSystem = localeMessages.publicSystem;
  const globalError =
    publicSystem && typeof publicSystem === "object" && !Array.isArray(publicSystem)
      ? (publicSystem as Record<string, unknown>).globalError
      : null;
  const translated =
    globalError && typeof globalError === "object" && !Array.isArray(globalError)
      ? Object.fromEntries(
          Object.entries(globalError).filter(
            ([, value]) => typeof value === "string" && !value.startsWith("__MISSING__:")
          )
        )
      : {};

  return {
    publicSystem: {
      globalError: {
        ...enMessages.publicSystem.globalError,
        ...translated,
      },
    },
  };
}

function GlobalErrorContent({ error, reset }: GlobalErrorProps) {
  const t = useTranslations("publicSystem");

  return (
    <main role="alert" aria-live="assertive" className="flex flex-col items-center">
      <div className="text-[64px] mb-4" aria-hidden="true">
        ⚠️
      </div>
      <h1 className="text-[28px] font-bold mb-2">{t("globalError.title")}</h1>
      <p className="text-[15px] text-text-muted max-w-[400px] leading-relaxed mb-6">
        {t("globalError.description")}
      </p>
      {process.env.NODE_ENV === "development" && error?.message && (
        <pre
          className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-500 text-xs max-w-[600px] overflow-auto text-left mb-6"
          aria-label={t("globalError.detailsAriaLabel")}
        >
          {error.message}
        </pre>
      )}
      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={reset}
          aria-label={t("globalError.retryAriaLabel")}
          className="px-8 py-3 rounded-[10px] text-white border-none text-sm font-semibold cursor-pointer transition-transform duration-200 motion-reduce:transition-none motion-reduce:transform-none shadow-warm hover:-translate-y-0.5 bg-gradient-to-br from-primary to-primary-hover focus:outline-2 focus:outline-offset-2 focus:outline-primary"
        >
          {t("globalError.tryAgain")}
        </button>
        <a
          href="/status"
          className="px-8 py-3 rounded-[10px] text-sm font-semibold border border-[var(--color-border)] hover:bg-[var(--color-bg-alt)] no-underline focus:outline-2 focus:outline-offset-2 focus:outline-primary"
          aria-label={t("globalError.statusAriaLabel")}
        >
          {t("globalError.systemStatus")}
        </a>
      </div>
    </main>
  );
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  return (
    <html lang="en">
      <body className="flex flex-col items-center justify-center min-h-screen p-6 bg-bg text-text-main font-[system-ui,-apple-system,sans-serif] text-center m-0">
        <NextIntlClientProvider locale="en" messages={buildGlobalErrorMessages(enMessages)}>
          <GlobalErrorContent error={error} reset={reset} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
