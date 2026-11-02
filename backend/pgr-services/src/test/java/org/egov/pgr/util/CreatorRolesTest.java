package org.egov.pgr.util;

import org.egov.common.contract.request.RequestInfo;
import org.egov.common.contract.request.Role;
import org.egov.common.contract.request.User;
import org.egov.mdms.model.MdmsCriteriaReq;
import org.egov.pgr.repository.ServiceRequestRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The creator-role gate (#210 review): who keeps seeing the complaints they filed, decided from
 * RAINMAKER-PGR.InboxVisibilityConfig.creatorRoles on the state-root record.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class CreatorRolesTest {

    private static final String RECEPTION = "CMS_RECEPTION_OFFICER";

    @Mock
    private ServiceRequestRepository serviceRequestRepository;
    @Mock
    private MDMSUtils mdmsUtils;

    private CreatorRoles creatorRoles;

    @BeforeEach
    void setup() {
        when(mdmsUtils.getMdmsSearchUrl()).thenReturn(new StringBuilder("http://mdms/_search"));
        creatorRoles = new CreatorRoles(serviceRequestRepository, mdmsUtils);
    }

    // ---------- against a record the caller already holds ----------

    @Test
    void aListedRoleIsACreatorRole() {
        assertTrue(creatorRoles.holdsCreatorRole(employee("rec-1", RECEPTION), config(List.of(RECEPTION))));
    }

    @Test
    void anUnlistedRoleIsNot() {
        assertFalse(creatorRoles.holdsCreatorRole(employee("cm-1", "CMS_CASE_MANAGER"), config(List.of(RECEPTION))));
    }

    @Test
    void codesAreComparedTrimmedAndUpperCasedOnBothSides() {
        assertTrue(creatorRoles.holdsCreatorRole(employee("rec-1", " cms_reception_officer "), config(List.of(" Cms_Reception_Officer"))));
    }

    @Test
    void anAbsentOrMalformedCreatorRolesGrantsNothing() {
        User reception = employee("rec-1", RECEPTION);
        assertFalse(creatorRoles.holdsCreatorRole(reception, config(null)), "creatorRoles absent");
        Map<String, Object> notAList = new HashMap<>();
        notAList.put(CreatorRoles.CONFIG_KEY, RECEPTION);
        assertFalse(creatorRoles.holdsCreatorRole(reception, notAList), "creatorRoles not a list");
        assertFalse(creatorRoles.holdsCreatorRole(reception, config(Arrays.asList(null, "", 42))), "no usable entry");
        assertFalse(creatorRoles.holdsCreatorRole(reception, null), "no record at all");
    }

    @Test
    void missingOrNullRolesNeverThrow() {
        User noRoles = new User();
        noRoles.setUuid("rec-1");
        assertFalse(creatorRoles.holdsCreatorRole(noRoles, config(List.of(RECEPTION))), "roles == null");

        User nullEntry = new User();
        nullEntry.setUuid("rec-1");
        List<Role> roles = new ArrayList<>();
        roles.add(null);
        roles.add(Role.builder().code(null).build());
        roles.add(Role.builder().code(RECEPTION).build());
        nullEntry.setRoles(roles);
        assertDoesNotThrow(() -> creatorRoles.holdsCreatorRole(nullEntry, config(List.of(RECEPTION))));
        assertTrue(creatorRoles.holdsCreatorRole(nullEntry, config(List.of(RECEPTION))));

        assertFalse(creatorRoles.holdsCreatorRole((User) null, config(List.of(RECEPTION))));
    }

    // ---------- against the tenant's state-root record (cached) ----------

    @Test
    void readsTheStateRootRecordForACityTenant() {
        stubMdms(List.of(RECEPTION));

        assertTrue(creatorRoles.holdsCreatorRole(requestInfo(employee("rec-1", RECEPTION)), "mz.maputo"));

        ArgumentCaptor<Object> request = ArgumentCaptor.forClass(Object.class);
        verify(serviceRequestRepository).fetchResult(any(), request.capture());
        assertEquals("mz", ((MdmsCriteriaReq) request.getValue()).getMdmsCriteria().getTenantId());
    }

    @Test
    void theRecordIsFetchedOncePerStateWithinTheCacheWindow() {
        stubMdms(List.of(RECEPTION));

        creatorRoles.holdsCreatorRole(requestInfo(employee("rec-1", RECEPTION)), "mz.maputo");
        creatorRoles.holdsCreatorRole(requestInfo(employee("cm-1", "CMS_CASE_MANAGER")), "mz.matola");
        creatorRoles.holdsCreatorRole(requestInfo(employee("rec-2", RECEPTION)), "mz");

        verify(serviceRequestRepository, times(1)).fetchResult(any(), any());
    }

    @Test
    void anMdmsFailureGrantsNothingAndIsRetried() {
        when(serviceRequestRepository.fetchResult(any(), any())).thenReturn(null);
        RequestInfo reception = requestInfo(employee("rec-1", RECEPTION));

        assertFalse(creatorRoles.holdsCreatorRole(reception, "mz.maputo"));

        stubMdms(List.of(RECEPTION));
        assertTrue(creatorRoles.holdsCreatorRole(reception, "mz.maputo"), "a failure must not be cached");
    }

    @Test
    void anUnseededRecordGrantsNothing() {
        when(serviceRequestRepository.fetchResult(any(), any())).thenReturn(Map.of("MdmsRes", Map.of()));

        assertFalse(creatorRoles.holdsCreatorRole(requestInfo(employee("rec-1", RECEPTION)), "mz.maputo"));
    }

    // ---------- the uuid a search scope may exempt ----------

    @Test
    void aCreatorRoleEmployeeIsExempt() {
        stubMdms(List.of(RECEPTION));

        assertEquals("rec-1", creatorRoles.exemptCreatorUuid(requestInfo(employee("rec-1", RECEPTION)), "mz.maputo"));
    }

    @Test
    void anEmployeeWithoutACreatorRoleIsNot() {
        stubMdms(List.of(RECEPTION));

        assertNull(creatorRoles.exemptCreatorUuid(requestInfo(employee("cm-1", "CMS_CASE_MANAGER")), "mz.maputo"));
    }

    @Test
    void noRecordMeansNoExemption() {
        stubMdms(null);

        assertNull(creatorRoles.exemptCreatorUuid(requestInfo(employee("rec-1", RECEPTION)), "mz.maputo"));
    }

    @Test
    void onlyAnEmployeeWithAUuidIsExempt() {
        stubMdms(List.of(RECEPTION));

        User system = employee("svc-1", RECEPTION);
        system.setType("SYSTEM");
        assertNull(creatorRoles.exemptCreatorUuid(requestInfo(system), "mz.maputo"), "the re-check keys on EMPLOYEE");

        assertNull(creatorRoles.exemptCreatorUuid(requestInfo(employee("  ", RECEPTION)), "mz.maputo"), "blank uuid");
        assertNull(creatorRoles.exemptCreatorUuid(requestInfo(employee(null, RECEPTION)), "mz.maputo"), "no uuid");
        assertNull(creatorRoles.exemptCreatorUuid(new RequestInfo(), "mz.maputo"), "no user");
        assertNull(creatorRoles.exemptCreatorUuid(null, "mz.maputo"), "no request info");
    }

    private void stubMdms(List<?> creatorRolesValue) {
        Map<String, Object> result = Map.of("MdmsRes", Map.of("RAINMAKER-PGR",
                Map.of("InboxVisibilityConfig", List.of(config(creatorRolesValue)))));
        when(serviceRequestRepository.fetchResult(any(), any())).thenReturn(result);
    }

    private static Map<String, Object> config(List<?> creatorRolesValue) {
        Map<String, Object> cfg = new HashMap<>();
        cfg.put("code", "INBOX_VISIBILITY");
        cfg.put("enabled", true);
        if (creatorRolesValue != null)
            cfg.put(CreatorRoles.CONFIG_KEY, creatorRolesValue);
        return cfg;
    }

    private static User employee(String uuid, String... roleCodes) {
        User user = new User();
        user.setUuid(uuid);
        user.setType("EMPLOYEE");
        user.setTenantId("mz");
        List<Role> roles = new ArrayList<>();
        roles.add(Role.builder().code("EMPLOYEE").build());
        for (String code : roleCodes)
            roles.add(Role.builder().code(code).build());
        user.setRoles(roles);
        return user;
    }

    private static RequestInfo requestInfo(User user) {
        RequestInfo requestInfo = new RequestInfo();
        requestInfo.setUserInfo(user);
        return requestInfo;
    }
}
