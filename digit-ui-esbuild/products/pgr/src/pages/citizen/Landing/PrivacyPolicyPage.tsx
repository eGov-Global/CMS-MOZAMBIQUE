// Standalone, shell-free in-app Privacy Policy page. Mounted by core App.js at
// /${contextPath}/privacy-policy and linked from the landing's PRIVACY route +
// footer. Text resolves via useLandingCopy (built-in deck in content.ts,
// overridable by PGR_LANDING_* localisation keys).
//
// The "Delete your account" section (#eliminar-conta, the landing's
// DELETE_ACCOUNT route) is the account deletion page Google Play requires for
// apps where users create an account.
import * as React from "react";
import { ArrowLeft, Mail } from "lucide-react";
import { buildTokenStyle, CONTAINER } from "./tokens";
import { useLandingCopy } from "./useLandingCopy";
import { LandingLink } from "./components/LandingLink";
import { DELETE_ACCOUNT_ANCHOR } from "./routes";

const BODY_KEYS = [
  "PRIVACY_PAGE_P1",
  "PRIVACY_PAGE_P2",
  "PRIVACY_PAGE_P3",
  "PRIVACY_PAGE_P4",
  "PRIVACY_PAGE_P5",
];

export function PGRPrivacyPolicyPage() {
  const { c, i18n } = useLandingCopy();
  const ctx = (typeof window !== "undefined" && (window as any)?.contextPath) || "digit-ui";

  // Portuguese-first public page: if the app's active locale isn't PT, switch
  // to pt_PT once on mount. Prefer the platform LocalizationService (fetches
  // the locale bundle + records the choice) and fall back to a bare i18n switch
  // (the copy deck's pt strings still resolve). Runs once.
  React.useEffect(() => {
    const active = String(i18n?.language || "").toLowerCase();
    if (active.startsWith("pt")) return;
    try {
      const D = (typeof window !== "undefined" ? (window as any).Digit : undefined) as any;
      const stateCode = D?.ULBService?.getStateId?.();
      if (D?.LocalizationService?.changeLanguage) {
        D.LocalizationService.changeLanguage("pt_PT", stateCode);
        return;
      }
    } catch {
      /* fall through */
    }
    i18n?.changeLanguage?.("pt_PT");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arriving at #eliminar-conta (footer link or the URL given to Google Play):
  // the section renders after the browser's own anchor jump, and core App.js
  // scrolls to the top on every route change in an effect that runs after
  // this one — so scroll in a task queued behind both. (A timer, not
  // requestAnimationFrame, which never fires while the tab is hidden.)
  React.useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== `#${DELETE_ACCOUNT_ANCHOR}`) return;
    const timer = window.setTimeout(() =>
      document.getElementById(DELETE_ACCOUNT_ANCHOR)?.scrollIntoView()
    );
    return () => window.clearTimeout(timer);
  }, []);

  const deletionEmail = c("DELETE_ACCOUNT_EMAIL");
  const deletionMailto = `mailto:${deletionEmail}?subject=${encodeURIComponent(c("DELETE_ACCOUNT_SUBJECT"))}`;

  return (
    <div className="v2-scope pgr-landing min-h-screen bg-[hsl(var(--pgrl-page))]" style={buildTokenStyle()}>
      <header className="bg-[hsl(var(--pgrl-deep))] text-[hsl(var(--pgrl-on-primary))]">
        <div className={`${CONTAINER} flex min-h-[56px] items-center justify-between gap-3 py-2`}>
          <span className="font-semibold uppercase tracking-wide">{c("PORTAL_NAME")}</span>
          <LandingLink
            to={`/${ctx}/landing`}
            className="inline-flex items-center gap-1.5 text-sm font-semibold no-underline !text-[hsl(var(--pgrl-on-primary))]"
          >
            <ArrowLeft aria-hidden className="h-4 w-4" /> {c("NAV_HOME")}
          </LandingLink>
        </div>
      </header>
      <main className={`${CONTAINER} py-10`}>
        <h1 className="mb-6 text-2xl font-bold text-[hsl(var(--pgrl-ink))]">{c("PRIVACY_PAGE_TITLE")}</h1>
        <div className="flex max-w-3xl flex-col gap-4">
          {BODY_KEYS.map((k) => (
            <p key={k} className="m-0 text-base leading-relaxed text-[hsl(var(--pgrl-ink-soft))]">
              {c(k)}
            </p>
          ))}
        </div>

        <section
          id={DELETE_ACCOUNT_ANCHOR}
          aria-labelledby={`${DELETE_ACCOUNT_ANCHOR}-title`}
          className="mt-10 flex max-w-3xl scroll-mt-4 flex-col gap-4 rounded-[var(--pgrl-radius)] border border-solid border-[hsl(var(--pgrl-line))] border-l-4 border-l-[hsl(var(--pgrl-primary))] bg-[hsl(var(--pgrl-surface))] p-6"
        >
          <h2 id={`${DELETE_ACCOUNT_ANCHOR}-title`} className="m-0 text-xl font-bold text-[hsl(var(--pgrl-ink))]">
            {c("DELETE_ACCOUNT_TITLE")}
          </h2>
          <p className="m-0 text-base leading-relaxed text-[hsl(var(--pgrl-ink-soft))]">{c("DELETE_ACCOUNT_P1")}</p>
          <p className="m-0 text-base leading-relaxed text-[hsl(var(--pgrl-ink-soft))]">{c("DELETE_ACCOUNT_HOW")}</p>
          <LandingLink
            to={deletionMailto}
            className="inline-flex items-center gap-2 self-start text-base font-semibold !text-[hsl(var(--pgrl-primary))] underline"
          >
            <Mail aria-hidden className="h-5 w-5" /> {deletionEmail}
          </LandingLink>
          <p className="m-0 text-base leading-relaxed text-[hsl(var(--pgrl-ink-soft))]">{c("DELETE_ACCOUNT_DELETED")}</p>
          <p className="m-0 text-base leading-relaxed text-[hsl(var(--pgrl-ink-soft))]">{c("DELETE_ACCOUNT_KEPT")}</p>
        </section>
      </main>
    </div>
  );
}

export default PGRPrivacyPolicyPage;
