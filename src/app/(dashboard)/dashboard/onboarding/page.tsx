"use client";

import { ArrowBigUp } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDisplayBaseUrl } from "@/shared/hooks";
import { extractApiErrorMessage } from "@/shared/http/apiErrorMessage";
import { TierTour } from "./steps/TierTour";

const STEP_IDS = ["welcome", "tiers", "security", "done"];
const STEP_ICONS = ["waving_hand", "layers", "lock", "check_circle"];

export default function OnboardingWizard() {
  const router = useRouter();
  const t = useTranslations("onboarding");
  const tc = useTranslations("common");
  const baseUrl = useDisplayBaseUrl();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const apiEndpoint = `${baseUrl}/v1`;

  // Security step state
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [skipSecurity, setSkipSecurity] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);

  // #14296: fresh Docker/NAT-forwarded installs (peer isn't 127.0.0.1) hit a
  // 401 on the bootstrap writes below until the operator supplies the
  // one-shot token the server printed to its log.
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [needsBootstrapToken, setNeedsBootstrapToken] = useState(false);

  // Check if setup is already complete
  useEffect(() => {
    const checkSetup = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const settings = await res.json();
          if (settings.setupComplete) {
            router.replace("/home/setup");
            return;
          }
        }
      } catch {
        // Continue with setup
      }
      setLoading(false);
    };
    checkSetup();
  }, [router]);

  const STEPS = STEP_IDS.map((id, i) => ({
    id,
    title: id === "done" ? "Continue in Setup" : t(id),
    icon: STEP_ICONS[i],
  }));

  const currentStep = STEPS[step];
  const isLastStep = step === STEPS.length - 1;

  const handleNext = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
  };

  const handleBack = () => {
    if (step > 0) setStep(step - 1);
  };

  const [errorMessage, setErrorMessage] = useState("");

  // #14296: attach the operator-supplied bootstrap token when we have one —
  // required only for a non-loopback (e.g. Docker/NAT-forwarded) caller
  // completing a fresh install; a no-op header on every other install.
  const bootstrapHeaders = (base: Record<string, string> = {}) =>
    bootstrapToken ? { ...base, "x-omniroute-bootstrap-token": bootstrapToken } : base;

  // Returns true when the caller should stop (a bootstrap-token prompt was
  // shown), false when the response was a "real" failure to report normally.
  const handleBootstrapAuthFailure = (res: Response): boolean => {
    if (res.status === 401 && !bootstrapToken) {
      setNeedsBootstrapToken(true);
      setErrorMessage(t("bootstrapTokenHelp"));
      return true;
    }
    return false;
  };

  const handleSetPassword = async () => {
    setErrorMessage("");
    if (skipSecurity) {
      // (#574) Explicitly disable requireLogin when skipping password setup
      try {
        const res = await fetch("/api/settings/require-login", {
          method: "POST",
          headers: bootstrapHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ requireLogin: false }),
        });
        if (!res.ok) {
          if (!handleBootstrapAuthFailure(res)) setErrorMessage(t("failedSetPassword"));
          return;
        }
      } catch {
        setErrorMessage(t("connectionError"));
        return;
      }
      handleNext();
      return;
    }
    if (password !== confirmPassword) return;
    try {
      const res = await fetch("/api/settings/require-login", {
        method: "POST",
        headers: bootstrapHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ requireLogin: true, password }),
      });
      if (!res.ok) {
        if (handleBootstrapAuthFailure(res)) return;
        const data = await res.json().catch(() => ({}));
        setErrorMessage(extractApiErrorMessage(data, t("failedSetPassword")));
        return;
      }
      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!loginRes.ok) {
        const data = await loginRes.json().catch(() => ({}));
        setErrorMessage(extractApiErrorMessage(data, t("connectionError")));
        return;
      }
      handleNext();
    } catch {
      setErrorMessage(t("connectionError"));
    }
  };

  const handleFinish = async () => {
    setErrorMessage("");
    try {
      // Read the security choice again before marking dashboard bootstrap complete.
      const securityRes = await fetch("/api/settings/require-login");
      if (!securityRes.ok) {
        setErrorMessage(t("connectionError"));
        return;
      }
      const settings = await securityRes.json();
      if (typeof settings.hasPassword !== "boolean" || typeof settings.requireLogin !== "boolean") {
        setErrorMessage(t("connectionError"));
        return;
      }
      if (!settings.hasPassword && settings.requireLogin !== false) {
        // Finishing cannot implicitly skip the operator's security choice.
        if (!skipSecurity) {
          setErrorMessage("Configure dashboard access before continuing.");
          setStep(STEP_IDS.indexOf("security"));
          return;
        }
        const requireLoginRes = await fetch("/api/settings/require-login", {
          method: "POST",
          headers: bootstrapHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ requireLogin: false }),
        });
        // #14296: this write used to be fire-and-forget, so a 401 from a
        // Docker/NAT-forwarded install silently left requireLogin untouched
        // and the wizard sailed on to setupComplete/dashboard anyway,
        // reproducing the reported redirect loop. Surface it instead.
        if (!requireLoginRes.ok) {
          if (!handleBootstrapAuthFailure(requireLoginRes)) setErrorMessage(t("failedSetPassword"));
          return;
        }
      }

      const patchRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: bootstrapHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ setupComplete: true }),
      });
      if (!patchRes.ok) {
        if (handleBootstrapAuthFailure(patchRes)) return;
        setErrorMessage(t("connectionError"));
        return;
      }
    } catch {
      setErrorMessage(t("connectionError"));
      return;
    }
    router.push("/home/setup");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-text-muted">{tc("loading")}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Progress Indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-300 ${
                  i < step
                    ? "bg-green-500/20 text-green-400"
                    : i === step
                      ? "bg-primary/20 text-primary ring-2 ring-primary/40"
                      : "bg-white/5 text-text-muted"
                }`}
              >
                {i < step ? (
                  <span className="material-symbols-outlined text-[16px]">check</span>
                ) : (
                  i + 1
                )}
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`w-8 h-0.5 rounded-full transition-colors ${
                    i < step ? "bg-green-500/40" : "bg-white/10"
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="bg-surface rounded-2xl border border-white/[0.06] p-8 shadow-xl">
          {/* Step Header */}
          <div className="text-center mb-6">
            <span
              className={`material-symbols-outlined text-[48px] mb-3 block ${
                currentStep.id === "done" ? "text-green-400" : "text-primary"
              }`}
            >
              {currentStep.icon}
            </span>
            <h2 className="text-2xl font-bold text-text-main">{currentStep.title}</h2>
            {currentStep.id === "tiers" && (
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-text-muted text-balance">
                {t("tier.subtitle")}
              </p>
            )}
          </div>

          {/* #14296: fresh-install bootstrap token prompt + generic errors —
              rendered above the step content so it applies regardless of
              which step's write actually failed (security step or the
              Finish/Skip-wizard buttons). */}
          {errorMessage && (
            <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-center animate-in fade-in duration-200">
              <p className="text-sm text-amber-400">{errorMessage}</p>
              {needsBootstrapToken && (
                <div className="mt-3 space-y-2">
                  <input
                    type="text"
                    placeholder={t("bootstrapTokenLabel")}
                    value={bootstrapToken}
                    onChange={(e) => setBootstrapToken(e.target.value)}
                    className="w-full px-4 py-2.5 bg-white/[0.04] border border-white/10 rounded-lg text-text-main text-sm placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <button
                    onClick={isLastStep ? handleFinish : handleSetPassword}
                    disabled={!bootstrapToken}
                    className="px-6 py-2 bg-primary rounded-lg text-white font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {t("retry")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Step Content */}
          <div className="min-h-[200px]">
            {/* Welcome */}
            {currentStep.id === "welcome" && (
              <div className="text-center space-y-4">
                <p className="text-text-muted">{t("welcomeDesc")}</p>
                <div className="mt-6 grid grid-cols-3 gap-3 items-stretch">
                  {[
                    { icon: "swap_horiz", label: t("multiProvider") },
                    { icon: "monitoring", label: t("usageTracking") },
                    { icon: "shield", label: t("apiKeyMgmt") },
                  ].map((f) => (
                    <div
                      key={f.icon}
                      className="h-full bg-white/[0.03] rounded-xl p-3 text-center border border-white/[0.06]"
                    >
                      <div className="flex h-full flex-col items-center justify-center">
                        <span className="material-symbols-outlined text-primary text-[24px] mb-1 block">
                          {f.icon}
                        </span>
                        <span className="text-xs text-text-muted">{f.label}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tiers */}
            {currentStep.id === "tiers" && <TierTour />}

            {/* Security */}
            {currentStep.id === "security" && (
              <div className="space-y-4">
                <p className="text-sm text-text-muted text-center">{t("securityDesc")}</p>
                <label className="flex items-center gap-2 cursor-pointer text-sm text-text-muted">
                  <input
                    type="checkbox"
                    checked={skipSecurity}
                    onChange={(e) => setSkipSecurity(e.target.checked)}
                    className="accent-primary"
                  />
                  {t("skipPassword")}
                </label>
                {skipSecurity && (
                  <p className="text-xs text-amber-400 text-center animate-in fade-in duration-200">
                    {t("securityDescSkipWarning")}
                  </p>
                )}
                {!skipSecurity && (
                  <div className="space-y-3">
                    <input
                      type="password"
                      placeholder={t("enterPassword")}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      onKeyUp={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      className="w-full px-4 py-2.5 bg-white/[0.04] border border-white/10 rounded-lg text-text-main text-sm placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <input
                      type="password"
                      placeholder={t("confirmPasswordPlaceholder")}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      onKeyDown={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      onKeyUp={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      className="w-full px-4 py-2.5 bg-white/[0.04] border border-white/10 rounded-lg text-text-main text-sm placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    {capsLockOn && (
                      <p className="text-xs text-amber-500 dark:text-amber-400 flex items-center gap-1 animate-in fade-in duration-200">
                        <Icon icon={ArrowBigUp} size="sm" color="current" />
                        Caps Lock is on
                      </p>
                    )}
                    {password && confirmPassword && password !== confirmPassword && (
                      <p className="text-xs text-red-400">{t("passwordsMismatch")}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Done */}
            {currentStep.id === "done" && (
              <div className="text-center space-y-4">
                <p className="text-text-muted">
                  Dashboard access is configured. In Setup, choose a connection and model, prepare a
                  client key, and validate the exact configuration. No inference request has been
                  sent.
                </p>
                <div className="bg-white/[0.03] rounded-xl p-4 border border-white/[0.06] text-left">
                  <p className="text-xs text-text-muted mb-2 font-medium">{t("yourEndpoint")}</p>
                  <code className="text-sm text-primary">{apiEndpoint}</code>
                </div>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between mt-8 pt-6 border-t border-white/[0.06]">
            <div>
              {step > 0 && !isLastStep && (
                <button
                  onClick={handleBack}
                  className="px-4 py-2 text-sm text-text-muted hover:text-text-main transition-colors cursor-pointer"
                >
                  {tc("back")}
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              {!isLastStep && step > 0 && currentStep.id !== "security" && (
                <button
                  onClick={handleNext}
                  className="px-4 py-2 text-sm text-text-muted hover:text-text-main transition-colors cursor-pointer"
                >
                  {t("skip")}
                </button>
              )}
              {currentStep.id === "welcome" && (
                <button
                  onClick={handleNext}
                  className="px-6 py-2.5 bg-primary rounded-lg text-white font-medium text-sm hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  {t("getStarted")}
                </button>
              )}
              {currentStep.id === "tiers" && (
                <button
                  onClick={handleNext}
                  className="px-6 py-2.5 bg-primary rounded-lg text-white font-medium text-sm hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  {t("continue")}
                </button>
              )}
              {currentStep.id === "security" && (
                <button
                  onClick={handleSetPassword}
                  disabled={!skipSecurity && (!password || password !== confirmPassword)}
                  className="px-6 py-2.5 bg-primary rounded-lg text-white font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {skipSecurity ? t("skipAndContinue") : t("setPassword")}
                </button>
              )}
              {isLastStep && (
                <button
                  onClick={handleFinish}
                  className="px-6 py-2.5 bg-green-500 rounded-lg text-white font-medium text-sm hover:bg-green-500/90 transition-colors cursor-pointer"
                >
                  Open Setup
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
