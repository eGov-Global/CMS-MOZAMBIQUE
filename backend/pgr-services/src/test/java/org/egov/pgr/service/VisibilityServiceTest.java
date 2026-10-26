package org.egov.pgr.service;

import org.egov.common.contract.request.RequestInfo;
import org.egov.common.contract.request.Role;
import org.egov.common.contract.request.User;
import org.egov.pgr.config.PGRConfiguration;
import org.egov.pgr.repository.HrmsProjectionRepository;
import org.egov.pgr.repository.PGRRepository;
import org.egov.pgr.repository.ServiceRequestRepository;
import org.egov.pgr.util.MDMSUtils;
import org.egov.pgr.web.models.RequestSearchCriteria;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * MINE scope of the server-side inbox: assigned-to-me for every role, widened to
 * created-by-me OR assigned-to-me for the roles listed in InboxVisibilityConfig.creatorRoles.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class VisibilityServiceTest {

    @Mock
    private PGRConfiguration config;
    @Mock
    private HrmsProjectionRepository projectionRepository;
    @Mock
    private WorkflowService workflowService;
    @Mock
    private ServiceRequestRepository serviceRequestRepository;
    @Mock
    private MDMSUtils mdmsUtils;
    @Mock
    private PGRRepository pgrRepository;

    private VisibilityService visibilityService;

    @BeforeEach
    void setup() {
        when(config.getVisibilityEnabled()).thenReturn(true);
        when(mdmsUtils.getMdmsSearchUrl()).thenReturn(new StringBuilder("http://mdms/_search"));
        visibilityService = new VisibilityService(config, projectionRepository, workflowService,
                serviceRequestRepository, mdmsUtils, pgrRepository);
    }

    @Test
    void mineIsAssignedToMeForARoleNotListedAsCreator() {
        stubConfig(List.of("CMS_RECEPTION_OFFICER"));
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("mz").build();

        visibilityService.resolve(requestInfo("emp-1", "CMS_CASE_MANAGER"), criteria, VisibilityService.SCOPE_MINE);

        assertEquals("emp-1", criteria.getAssignee());
        assertNull(criteria.getVisibilityIds());
        verify(pgrRepository, never()).getServiceRequestIdsCreatedBy(any(), any());
    }

    @Test
    void mineIsCreatedOrAssignedForACreatorRole() {
        stubConfig(List.of("CMS_RECEPTION_OFFICER"));
        when(workflowService.getServiceRequestIdsByAssignee(any(), any(), any())).thenReturn(Set.of("PRD-1"));
        when(pgrRepository.getServiceRequestIdsCreatedBy("mz", "rec-1")).thenReturn(Set.of("PRD-2"));
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("mz").build();

        visibilityService.resolve(requestInfo("rec-1", "CMS_RECEPTION_OFFICER"), criteria, VisibilityService.SCOPE_MINE);

        assertEquals(Set.of("PRD-1", "PRD-2"), criteria.getVisibilityIds());
        assertNull(criteria.getAssignee());
    }

    @Test
    void mineWithNothingCreatedOrAssignedFallsBackToCreatedByRatherThanUnfiltered() {
        stubConfig(List.of("CMS_RECEPTION_OFFICER"));
        when(workflowService.getServiceRequestIdsByAssignee(any(), any(), any())).thenReturn(Set.of());
        when(pgrRepository.getServiceRequestIdsCreatedBy("mz", "rec-1")).thenReturn(Set.of());
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("mz").build();

        visibilityService.resolve(requestInfo("rec-1", "CMS_RECEPTION_OFFICER"), criteria, VisibilityService.SCOPE_MINE);

        assertEquals(Set.of("rec-1"), criteria.getCreatedBy());
        assertNull(criteria.getVisibilityIds());
    }

    @Test
    void mineIsAssignedToMeWhenNoCreatorRolesAreConfigured() {
        stubConfig(null);
        RequestSearchCriteria criteria = RequestSearchCriteria.builder().tenantId("mz").build();

        visibilityService.resolve(requestInfo("rec-1", "CMS_RECEPTION_OFFICER"), criteria, VisibilityService.SCOPE_MINE);

        assertEquals("rec-1", criteria.getAssignee());
    }

    private void stubConfig(List<String> creatorRoles) {
        Map<String, Object> cfg = new HashMap<>();
        cfg.put("code", "INBOX_VISIBILITY");
        cfg.put("enabled", true);
        if (creatorRoles != null)
            cfg.put("creatorRoles", creatorRoles);
        Map<String, Object> result = Map.of("MdmsRes", Map.of("RAINMAKER-PGR", Map.of("InboxVisibilityConfig", List.of(cfg))));
        when(serviceRequestRepository.fetchResult(any(), any())).thenReturn(result);
    }

    private RequestInfo requestInfo(String uuid, String roleCode) {
        User user = new User();
        user.setUuid(uuid);
        user.setType("EMPLOYEE");
        user.setTenantId("mz");
        user.setRoles(List.of(Role.builder().code("EMPLOYEE").build(), Role.builder().code(roleCode).build()));
        RequestInfo requestInfo = new RequestInfo();
        requestInfo.setUserInfo(user);
        return requestInfo;
    }
}
