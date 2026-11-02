// The server-side employee inbox (InboxVisibilityConfig.serverSide): who
// counts as a creator, and the order the inbox opens in.

const roleCode = (code) => (typeof code === "string" ? code.trim().toUpperCase() : "");

/**
 * Whether the user holds one of InboxVisibilityConfig.creatorRoles — the roles
 * whose My Complaints, resolved by pgr-services, lists the complaints they
 * filed as well as those assigned to them. Codes are compared trimmed and
 * upper-cased, ignoring the role's tenant, the way pgr-services compares them:
 * the inbox and the server have to agree on who is a creator.
 */
export const holdsCreatorRole = (userRoles, creatorRoles) => {
  if (!Array.isArray(userRoles) || !Array.isArray(creatorRoles)) return false;
  const creators = new Set(creatorRoles.map(roleCode).filter(Boolean));
  return userRoles.some((role) => creators.has(roleCode(role?.code)));
};

/** The order the inbox opens in before the operator picks a column. A
 *  creator's My tab lists every complaint they filed, closed ones included,
 *  so SLA remaining would open it on the oldest, mostly closed filings. */
export const inboxDefaultSort = (creatorMyTab = false) =>
  creatorMyTab ? { sortBy: "createdTime", sortOrder: "DESC" } : { sortBy: "sla", sortOrder: "ASC" };

/**
 * The sortBy/sortOrder the inbox sends: the column the operator picked, else
 * the default. On a creator's My tab a sortOrder without a sortBy is not the
 * operator's: the search card writes a lowercase "asc" there on every search,
 * filter and clear, which would flip the list to oldest first.
 */
export const inboxSort = (tableForm, creatorMyTab = false) => {
  if (creatorMyTab && !tableForm?.sortBy) return inboxDefaultSort(true);
  const fallback = inboxDefaultSort(false);
  return {
    sortBy: tableForm?.sortBy || fallback.sortBy,
    sortOrder: (tableForm?.sortOrder || fallback.sortOrder).toUpperCase(),
  };
};
