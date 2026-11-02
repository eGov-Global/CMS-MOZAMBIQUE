import React from "react";
import { useQuery } from "react-query";
import { DEFAULT_EGOV_LOGO_ON_DARK } from "../brandLogos";

/** Chevron for the rail toggle; points the way the rail will move. */
const Chevron = ({ open }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {open ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
  </svg>
);

const LogoutGlyph = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
);

/**
 * The one control that opens or closes the rail: a blue square that sits on
 * the rail's edge, just under the top bar. It is fixed to the viewport rather
 * than placed inside the rail, whose own overflow would clip the half that
 * hangs over the page; the stylesheet moves it with the rail's width.
 */
export const RailToggle = ({ t, expanded, onToggle }) => {
  const label = expanded
    ? t("CORE_SIDEBAR_CLOSE", "Close sidebar")
    : t("CORE_SIDEBAR_OPEN", "Open sidebar");
  return (
    <button
      type="button"
      className="digit-rail-toggle"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={onToggle}
      data-analytics-event="shell.rail.toggle"
      data-analytics-label={expanded ? "collapse" : "expand"}
    >
      <Chevron open={expanded} />
    </button>
  );
};

/**
 * The footer logo is off unless ThemeConfig.sidebarFooterLogo.enabled is set
 * (configurator → Theme). An uploaded logo is stored as a fileStoreId, never as
 * a signed URL, which would expire; it is resolved here, and the eGov lockup
 * stands in while it loads or if it cannot be fetched.
 */
const useSidebarFooterLogo = () => {
  const { data: storeData } = Digit.Hooks.useStore.getInitData();
  const { enabled, fileStoreId } = storeData?.sidebarFooterLogo || {};
  const stateId = Digit.ULBService.getStateId();
  const { data: uploadedUrl } = useQuery(
    ["SIDEBAR_FOOTER_LOGO", stateId, fileStoreId],
    async () => {
      const res = await Digit.UploadServices.Filefetch([fileStoreId], stateId);
      return res?.data?.fileStoreIds?.[0]?.url?.split(",")[0] || null;
    },
    { enabled: !!enabled && !!fileStoreId, staleTime: Infinity, retry: false }
  );
  if (!enabled) return null;
  return uploadedUrl
    ? { src: uploadedUrl, alt: "" }
    : { src: DEFAULT_EGOV_LOGO_ON_DARK, alt: "eGov Foundation" };
};

/**
 * Foot of the desktop rail: Logout, then the footer logo when one is enabled.
 * Closed, Logout keeps only its icon and the logo shrinks to fit the rail.
 */
export const SidebarFoot = ({ t, expanded, onLogout }) => {
  const logo = useSidebarFooterLogo();
  return (
    <div className={`digit-sidebar-foot ${expanded ? "open" : "closed"}`}>
      {onLogout ? (
        <button
          type="button"
          className="digit-sidebar-logout"
          onClick={onLogout}
          data-analytics-event="shell.rail.logout"
          title={t ? t("CORE_COMMON_LOGOUT", "Logout") : "Logout"}
        >
          <LogoutGlyph />
          {expanded ? <span className="digit-sidebar-logout-label">{t ? t("CORE_COMMON_LOGOUT", "Logout") : "Logout"}</span> : null}
        </button>
      ) : null}
      {logo ? (
        <div className="digit-sidebar-egov-band">
          <img className="digit-sidebar-egov" src={logo.src} alt={logo.alt} />
        </div>
      ) : null}
    </div>
  );
};

/**
 * Foot of the phone drawer: the footer logo, as at the foot of the desktop
 * rail. The drawer's own Logout row sits above it (the stylesheet orders it),
 * and "Powered by DIGIT" is the page footer's, not repeated here.
 */
export const DrawerFoot = () => {
  const logo = useSidebarFooterLogo();
  if (!logo) return null;
  return (
    <div className="digit-sidebar-foot digit-drawer-foot">
      <img className="digit-sidebar-egov" src={logo.src} alt={logo.alt} />
    </div>
  );
};
