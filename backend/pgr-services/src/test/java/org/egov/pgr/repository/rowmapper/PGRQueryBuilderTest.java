package org.egov.pgr.repository.rowmapper;

import org.egov.pgr.config.PGRConfiguration;
import org.egov.pgr.policy.PgrSearchScope;
import org.egov.pgr.web.models.RequestSearchCriteria;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.when;

/**
 * Verifies the RBAC scope predicates added for the access-control policy reference rule
 * (citizen-self / employee-department / tenant search scoping) — that a null scope is fail-closed
 * (throws, rather than silently unrestricting), and that {@link PgrSearchScope#UNRESTRICTED} is
 * the only way to opt out, leaving the query byte-for-byte unaffected for plainSearch/legacy callers.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class PGRQueryBuilderTest {

    @Mock
    private PGRConfiguration config;

    private PGRQueryBuilder queryBuilder;

    @BeforeEach
    void setup() {
        when(config.getStateLevelTenantIdLength()).thenReturn(1);
        queryBuilder = new PGRQueryBuilder(config);
    }

    @Test
    void nullScopeThrowsRatherThanSilentlyUnrestricting() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();

        assertThrows(IllegalStateException.class,
                () -> queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, null));
    }

    @Test
    void unrestrictedSentinelAddsNoExtraPredicate() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, PgrSearchScope.UNRESTRICTED);

        assertFalse(query.contains("accountId"));
        assertFalse(query.contains("department"));
    }

    @Test
    void stateLevelScopeAddsTenantLikePredicate() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg", true, null, null, null);

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.contains("ser.tenantId LIKE ?"));
        assertTrue(preparedStmtList.contains("pg%"));
    }

    @Test
    void cityLevelScopeAddsTenantEqualsPredicate() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, null, null);

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.contains("ser.tenantId = ?"));
        assertTrue(preparedStmtList.contains("pg.city"));
    }

    @Test
    void citizenScopeAddsAccountIdPredicate() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, "citizen-1", null, null);

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.contains("ser.accountId = ?"));
        assertTrue(preparedStmtList.contains("citizen-1"));
    }

    @Test
    void departmentScopeAddsInPredicate() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, List.of("SANITATION", "ROADS"), null);

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.contains("ser.additionaldetails->>'department' IN"));
        assertTrue(preparedStmtList.contains("SANITATION"));
        assertTrue(preparedStmtList.contains("ROADS"));
    }

    @Test
    void countQueryAppliesTheSameScope() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, "citizen-1", null, null);

        String query = queryBuilder.getCountQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.contains("ser.accountId = ?"));
        assertEquals(1, preparedStmtList.stream().filter("citizen-1"::equals).count());
    }

    @Test
    void jurisdictionScopeAddsLocalityInPredicate() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, List.of("SANITATION"), List.of("WARD_5", "WARD_6"));

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.contains("ads.locality IN"));
        assertTrue(preparedStmtList.contains("WARD_5"));
        assertTrue(preparedStmtList.contains("WARD_6"));
    }

    @Test
    void nullJurisdictionCodesAddNoLocalityPredicate() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, List.of("SANITATION"), null);

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertFalse(query.contains("ads.locality IN"));
    }

    // A non-null EMPTY list means "this axis IS restricted and resolved to zero allowed values" —
    // distinct from null ("axis not restricted"). ScopePolicyEngine.resolve always hands back a
    // non-empty sentinel list instead today, but applyScope must independently deny-all here if
    // that contract ever regresses upstream, rather than silently dropping the axis and returning
    // unrestricted rows (#1441 review).
    @Test
    void emptyNonNullDepartmentCodesDenyAllRatherThanDroppingTheAxis() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, List.of(), null);

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.contains("1 = 0"));
        assertFalse(query.contains("ser.additionaldetails->>'department' IN"));
    }

    @Test
    void emptyNonNullJurisdictionCodesDenyAllRatherThanDroppingTheAxis() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, null, List.of());

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.contains("1 = 0"));
        assertFalse(query.contains("ads.locality IN"));
    }

    // A complaint the caller created passes the department/jurisdiction axes, so a reception
    // officer sees what they filed for another department (or before it is routed at all).
    @Test
    void creatorScopeLetsOwnComplaintsPassTheRestrictedAxes() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, List.of("SANITATION"), List.of("WARD_5"), "emp-1");

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.contains("( ser.createdby = ? OR ( 1 = 1  AND ser.additionaldetails->>'department' IN"));
        assertTrue(query.contains("ads.locality IN"));
        assertTrue(query.contains(" ) ) "));
        assertTrue(preparedStmtList.indexOf("emp-1") < preparedStmtList.indexOf("SANITATION"));
        assertTrue(preparedStmtList.indexOf("SANITATION") < preparedStmtList.indexOf("WARD_5"));
    }

    @Test
    void creatorScopeKeepsTheTenantPredicateOutsideTheException() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, List.of("SANITATION"), null, "emp-1");

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.indexOf("ser.tenantId = ?") < query.indexOf("ser.createdby = ?"));
    }

    @Test
    void creatorWithoutRestrictedAxesAddsNoCreatorPredicate() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, null, null, "emp-1");

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, scope);

        assertFalse(query.contains("ser.createdby = ?"));
        assertFalse(preparedStmtList.contains("emp-1"));
    }

    @Test
    void countQueryAppliesTheCreatorException() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        List<Object> preparedStmtList = new ArrayList<>();
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, List.of("SANITATION"), null, "emp-1");

        String query = queryBuilder.getCountQuery(criteria, preparedStmtList, null, scope);

        assertTrue(query.contains("ser.createdby = ?"));
        assertEquals(1, preparedStmtList.stream().filter("emp-1"::equals).count());
    }

    // #210 review: a creator role's My Complaints used to bind every complaint id they ever filed
    // or were assigned as IN (...). The filed side is now a createdby predicate; only the assigned
    // ids are bound.
    @Test
    void mineCreatorIsFiledByOrAssignedTo() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        criteria.setMineCreatorUuid("rec-1");
        criteria.setVisibilityIds(new java.util.LinkedHashSet<>(List.of("PRD-1", "PRD-2")));
        List<Object> preparedStmtList = new ArrayList<>();

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, PgrSearchScope.UNRESTRICTED);

        assertTrue(query.contains("(  ser.createdby = ?  OR  ser.serviceRequestId IN ( ? , ? ) )"), query);
        assertEquals(List.of("pg.city", "rec-1", "PRD-1", "PRD-2"), preparedStmtList.subList(0, 4));
    }

    @Test
    void mineCreatorWithNothingAssignedIsFiledByOnly() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        criteria.setMineCreatorUuid("rec-1");
        criteria.setVisibilityIds(new java.util.HashSet<>());
        List<Object> preparedStmtList = new ArrayList<>();

        String query = queryBuilder.getPGRSearchQuery(criteria, preparedStmtList, null, PgrSearchScope.UNRESTRICTED);

        assertTrue(query.contains("(  ser.createdby = ?  )"), query);
        assertFalse(query.contains("ser.serviceRequestId IN"));
        assertEquals(List.of("pg.city", "rec-1"), preparedStmtList.subList(0, 2));
    }

    @Test
    void countQueryAppliesTheSameMinePredicate() {
        PgrSearchScope scope = new PgrSearchScope("pg.city", false, null, List.of("SANITATION"), null, "rec-1");
        RequestSearchCriteria searchCriteria = mineCriteria();
        RequestSearchCriteria countCriteria = mineCriteria();
        List<Object> searchParams = new ArrayList<>();
        List<Object> countParams = new ArrayList<>();

        String search = queryBuilder.getPGRSearchQuery(searchCriteria, searchParams, null, scope);
        String count = queryBuilder.getCountQuery(countCriteria, countParams, null, scope);

        String mine = "(  ser.createdby = ?  OR  ser.serviceRequestId IN ( ? ) )";
        assertTrue(search.contains(mine), search);
        assertTrue(count.contains(mine), count);
        // The count wraps the same filter, without ORDER BY / OFFSET / LIMIT.
        assertEquals(searchParams.subList(0, countParams.size()), countParams);
        assertEquals(searchParams.size() - 2, countParams.size());
    }

    // #210 review: the creator wrapper nests the scope axes inside a parenthesised OR; every shape
    // must still bind exactly one value per placeholder, on _search and on _count.
    @Test
    void placeholderCountMatchesBoundParametersForEveryScopeShape() {
        List<List<String>> axisShapes = java.util.Arrays.asList(null, List.of(), List.of("D1"), List.of("D1", "D2"));
        List<List<String>> jurisdictionShapes = java.util.Arrays.asList(null, List.of(), List.of("W1"));
        java.util.Map<String, Long> slaMap = java.util.Map.of("STREETLIGHT", 172_800_000L);
        int combinations = 0;
        for (String tenant : new String[] { "pg.city", "pg" }) {
            boolean stateLevel = !tenant.contains(".");
            for (List<String> departments : axisShapes) {
                for (List<String> jurisdictions : jurisdictionShapes) {
                    for (String creatorUuid : new String[] { null, "emp-1" }) {
                        for (String mineCreatorUuid : new String[] { null, "emp-1" }) {
                            for (boolean assigned : new boolean[] { false, true }) {
                                PgrSearchScope scope = new PgrSearchScope(tenant, stateLevel, null, departments, jurisdictions, creatorUuid);

                                RequestSearchCriteria searchCriteria = shapedCriteria(tenant, mineCreatorUuid, assigned);
                                searchCriteria.setSortBy(RequestSearchCriteria.SortBy.sla);
                                List<Object> searchParams = new ArrayList<>();
                                String search = queryBuilder.getPGRSearchQuery(searchCriteria, searchParams, slaMap, scope);
                                String label = "tenant=" + tenant + " departments=" + departments + " jurisdictions=" + jurisdictions
                                        + " creatorUuid=" + creatorUuid + " mineCreatorUuid=" + mineCreatorUuid + " assigned=" + assigned;
                                assertEquals(placeholders(search), searchParams.size(), "search " + label);

                                List<Object> countParams = new ArrayList<>();
                                String count = queryBuilder.getCountQuery(shapedCriteria(tenant, mineCreatorUuid, assigned), countParams, null, scope);
                                assertEquals(placeholders(count), countParams.size(), "count " + label);

                                assertEquals(count(search, "("), count(search, ")"), "balanced parentheses: " + label);
                                combinations++;
                            }
                        }
                    }
                }
            }
        }
        assertEquals(2 * 4 * 3 * 2 * 2 * 2, combinations);
    }

    private static RequestSearchCriteria mineCriteria() {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("pg.city").build();
        criteria.setMineCreatorUuid("rec-1");
        criteria.setVisibilityIds(new java.util.HashSet<>(List.of("PRD-1")));
        return criteria;
    }

    private static RequestSearchCriteria shapedCriteria(String tenant, String mineCreatorUuid, boolean assigned) {
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId(tenant)
                .applicationStatus(java.util.Set.of("PENDINGFORASSIGNMENT"))
                .limit(10).offset(0).build();
        criteria.setMineCreatorUuid(mineCreatorUuid);
        criteria.setVisibilityIds(assigned ? new java.util.LinkedHashSet<>(List.of("PRD-1", "PRD-2")) : new java.util.HashSet<>());
        return criteria;
    }

    private static int placeholders(String query) {
        return count(query, "?");
    }

    private static int count(String haystack, String needle) {
        int n = 0;
        for (int i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1))
            n++;
        return n;
    }
}
