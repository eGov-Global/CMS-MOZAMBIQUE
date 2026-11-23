// Standalone, shell-free in-app Privacy Policy page. Mounted by core App.js at
// /${contextPath}/privacy-policy and linked from the landing's PRIVACY route +
// footer. Text resolves via useLandingCopy (built-in deck in content.ts,
// overridable by PGR_LANDING_* localisation keys).
//
// The "Delete your account" section (#eliminar-conta, the landing's
// DELETE_ACCOUNT route) is the account deletion page Google Play requires for
// apps where users create an account.
import * as React from "react";
import { Archive, ArrowLeft, Check, Mail, Smartphone, Trash2, UserX, X } from "lucide-react";
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

// The deletion steps, drawn as a numbered timeline (copy keys
// DELETE_ACCOUNT_STEP<n>_TITLE / _TEXT).
const DELETE_STEPS = [
  { n: 1, Icon: Mail },
  { n: 2, Icon: Smartphone },
  { n: 3, Icon: UserX },
];

/** One side of "what happens to your data": deleted (red) or kept (green). */
function DataCard({
  tone,
  Icon,
  ItemIcon,
  title,
  items,
  note,
}: {
  tone: "deleted" | "kept";
  Icon: React.ComponentType<{ className?: string }>;
  ItemIcon: React.ComponentType<{ className?: string }>;
  title: string;
  items: string[];
  note?: string;
}) {
  const color = tone === "deleted" ? "#B42318" : "hsl(var(--pgrl-primary))";
  const tint = tone === "deleted" ? "#FEF3F2" : "hsl(var(--pgrl-page))";
  return (
    <div
      className="flex flex-col gap-3 rounded-[var(--pgrl-radius)] border border-solid border-[hsl(var(--pgrl-line))] p-4"
      style={{ background: tint }}
    >
      <p className="m-0 flex items-center gap-2 text-base font-bold" style={{ color }}>
        <Icon aria-hidden className="h-5 w-5" /> {title}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-base text-[hsl(var(--pgrl-ink))]">
            <span style={{ color }} className="mt-0.5 shrink-0">
              <ItemIcon aria-hidden className="h-4 w-4" />
            </span>
            {item}
          </li>
        ))}
      </ul>
      {note ? <p className="m-0 text-sm leading-relaxed text-[hsl(var(--pgrl-ink-soft))]">{note}</p> : null}
    </div>
  );
}

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
  const deletionMailto =
    `mailto:${deletionEmail}?subject=${encodeURIComponent(c("DELETE_ACCOUNT_SUBJECT"))}` +
    `&body=${encodeURIComponent(c("DELETE_ACCOUNT_MAIL_BODY"))}`;

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

          {/* How it works: the three steps as a numbered timeline. */}
          <h3 className="m-0 mt-2 text-base font-bold uppercase tracking-wide text-[hsl(var(--pgrl-ink))]">
            {c("DELETE_ACCOUNT_STEPS_TITLE")}
          </h3>
          <ol className="m-0 flex list-none flex-col p-0">
            {DELETE_STEPS.map(({ n, Icon }, i) => (
              <li key={n} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <span
                    aria-hidden
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--pgrl-primary))] text-[hsl(var(--pgrl-on-primary))]"
                  >
                    <Icon className="h-6 w-6" />
                  </span>
                  {i < DELETE_STEPS.length - 1 ? (
                    <span aria-hidden className="my-1 w-0.5 flex-1 bg-[hsl(var(--pgrl-line))]" />
                  ) : null}
                </div>
                <div className={i < DELETE_STEPS.length - 1 ? "pb-6 pt-1" : "pt-1"}>
                  <p className="m-0 text-sm font-semibold text-[hsl(var(--pgrl-primary))]">
                    {n}. {c(`DELETE_ACCOUNT_STEP${n}_TITLE`)}
                  </p>
                  <p className="m-0 mt-1 text-base leading-relaxed text-[hsl(var(--pgrl-ink-soft))]">
                    {c(`DELETE_ACCOUNT_STEP${n}_TEXT`)}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <a
            href={deletionMailto}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 self-stretch rounded-[var(--pgrl-radius)] bg-[hsl(var(--pgrl-primary))] px-5 text-base font-semibold no-underline !text-[hsl(var(--pgrl-on-primary))] sm:self-start"
          >
            <Mail aria-hidden className="h-5 w-5" /> {c("DELETE_ACCOUNT_SEND")}
          </a>
          <p className="m-0 text-sm text-[hsl(var(--pgrl-ink-soft))]">
            {c("DELETE_ACCOUNT_OR_WRITE")}{" "}
            <a href={deletionMailto} className="font-semibold !text-[hsl(var(--pgrl-primary))] underline">
              {deletionEmail}
            </a>
          </p>

          {/* What happens to the data: deleted vs kept, side by side. */}
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <DataCard
              tone="deleted"
              Icon={Trash2}
              ItemIcon={X}
              title={c("DELETE_ACCOUNT_DELETED_TITLE")}
              items={c("DELETE_ACCOUNT_DELETED_ITEMS").split("|")}
            />
            <DataCard
              tone="kept"
              Icon={Archive}
              ItemIcon={Check}
              title={c("DELETE_ACCOUNT_KEPT_TITLE")}
              items={c("DELETE_ACCOUNT_KEPT_ITEMS").split("|")}
              note={c("DELETE_ACCOUNT_KEPT_WHY")}
            />
          </div>
        </section>
      </main>
    </div>
  );
}

export default PGRPrivacyPolicyPage;
