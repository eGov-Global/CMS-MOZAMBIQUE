/**
 * The privacy policy and account deletion links a citizen can reach from
 * inside the app. Google Play wants account deletion reachable in the app as
 * well as on the web, and the app never opens the landing page, whose footer
 * is the only other place with these links. The privacy policy sits on the
 * sign-in screen and in the side menu; account deletion only in a signed-in
 * citizen's Edit Profile.
 *
 * Both point at the public privacy page the PGR product registers
 * (`PGRPrivacyPolicy`, mounted by App.js at /<contextPath>/privacy-policy).
 * A deployment without that page gets null, so no link leads to a 404.
 */

/** Same id as DELETE_ACCOUNT_ANCHOR in products/pgr/.../Landing/routes.ts. */
export const DELETE_ACCOUNT_ANCHOR = "eliminar-conta";

const isPortuguese = () => String(Digit?.StoreData?.getCurrentLanguage?.() || "").toLowerCase().startsWith("pt");

// A tenant can override the label through localisation. Until it does, the
// fallback follows the citizen's language, since the page itself is in
// Portuguese and an English label would sit oddly in front of it.
const label = (t, key, pt, en) => {
  const value = t(key);
  return value && value !== key ? value : isPortuguese() ? pt : en;
};

export const privacyLinks = (t) => {
  if (!Digit?.ComponentRegistryService?.getComponent?.("PGRPrivacyPolicy")) return null;
  const privacyUrl = `/${window?.contextPath}/privacy-policy`;
  return {
    privacy: {
      url: privacyUrl,
      label: label(t, "CORE_PRIVACY_POLICY", "Política de Privacidade", "Privacy policy"),
    },
    deleteAccount: {
      url: `${privacyUrl}#${DELETE_ACCOUNT_ANCHOR}`,
      label: label(t, "CORE_DELETE_MY_ACCOUNT", "Eliminar a minha conta", "Delete my account"),
      description: label(
        t,
        "CORE_DELETE_MY_ACCOUNT_INFO",
        "Pode pedir a eliminação da sua conta e dos dados do seu perfil. Veja como pedir e o que é conservado.",
        "You can ask for your account and your profile data to be deleted. See how to ask and what is kept."
      ),
    },
  };
};
