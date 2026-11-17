-- My Complaints for a creator role (InboxVisibilityConfig.creatorRoles) and the search scope's
-- creator exemption both filter on ser.createdby = ?, on _search and _count.
CREATE INDEX IF NOT EXISTS index_eg_pgr_service_v2_createdBy ON eg_pgr_service_v2 (createdBy);
