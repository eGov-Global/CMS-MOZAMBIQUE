package org.egov.pgr.service;

import org.egov.common.contract.request.RequestInfo;
import org.egov.common.contract.request.User;
import org.egov.pgr.config.PGRConfiguration;
import org.egov.pgr.policy.FieldVisibilityService;
import org.egov.pgr.policy.PgrSearchScope;
import org.egov.pgr.policy.SearchAccessPolicyService;
import org.egov.pgr.producer.Producer;
import org.egov.pgr.repository.PGRRepository;
import org.egov.pgr.util.MDMSUtils;
import org.egov.pgr.util.PGRUtils;
import org.egov.pgr.validator.ServiceRequestValidator;
import org.egov.pgr.web.models.RequestSearchCriteria;
import org.egov.pgr.web.models.ServiceWrapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.Collections;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * #209 — an employee searching for the complaints they filed themselves ({@code createdBy} = their
 * own uuid) is not limited by their department or jurisdiction: a reception officer files on
 * citizens' behalf for every department. Any other {@code createdBy} search keeps the full scope.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
public class PGRServiceOwnFilingsTest {

    private static final String ME = "reception-uuid";
    private static final PgrSearchScope DEPARTMENT_SCOPE =
            new PgrSearchScope("mz", true, null, List.of("ministry_of_health"), List.of("maputo_cidade"));

    @Mock private EnrichmentService enrichmentService;
    @Mock private UserService userService;
    @Mock private WorkflowService workflowService;
    @Mock private ServiceRequestValidator validator;
    @Mock private Producer producer;
    @Mock private PGRConfiguration config;
    @Mock private PGRRepository repository;
    @Mock private MDMSUtils mdmsUtils;
    @Mock private ComplaintDomainEventService complaintDomainEventService;
    @Mock private PGRUtils pgrUtils;
    @Mock private ExtendedAttributesValidationService extendedAttributesValidationService;
    @Mock private EncryptionDecryptionService encryptionDecryptionService;
    @Mock private EmployeeDepartmentScopeService employeeDepartmentScopeService;
    @Mock private EmployeeJurisdictionScopeService employeeJurisdictionScopeService;
    @Mock private SearchAccessPolicyService searchAccessPolicyService;
    @Mock private FieldVisibilityService fieldVisibilityService;
    @Mock private EscalationService escalationService;
    @Mock private EscalationLockManager escalationLockManager;

    private PGRService pgrService;

    @BeforeEach
    void setup() {
        pgrService = new PGRService(enrichmentService, userService, workflowService,
                validator, producer, config, repository, mdmsUtils,
                complaintDomainEventService, pgrUtils, extendedAttributesValidationService,
                encryptionDecryptionService, employeeDepartmentScopeService, employeeJurisdictionScopeService,
                searchAccessPolicyService, fieldVisibilityService,
                escalationService, escalationLockManager);
        when(searchAccessPolicyService.resolveScope(any(), any(), anyInt())).thenReturn(DEPARTMENT_SCOPE);
        // The older opt-in filters let the search through (their caller holds no scoped role).
        when(employeeDepartmentScopeService.applyScope(any(), any(), any())).thenReturn(true);
        when(employeeJurisdictionScopeService.applyScope(any(), any(), any())).thenReturn(true);
    }

    private RequestInfo user(String type, String uuid) {
        return RequestInfo.builder()
                .userInfo(User.builder().uuid(uuid).type(type).tenantId("mz").roles(List.of()).build())
                .build();
    }

    private RequestSearchCriteria createdBy(String... uuids) {
        RequestSearchCriteria criteria = new RequestSearchCriteria();
        criteria.setTenantId("mz");
        criteria.setCreatedBy(Set.of(uuids));
        return criteria;
    }

    private PgrSearchScope countedScope(RequestInfo requestInfo, RequestSearchCriteria criteria) {
        pgrService.count(requestInfo, criteria);
        ArgumentCaptor<PgrSearchScope> scope = ArgumentCaptor.forClass(PgrSearchScope.class);
        verify(repository).getCount(any(), scope.capture());
        return scope.getValue();
    }

    @Test
    void count_ownFilings_dropsDepartmentAndJurisdictionLimits() {
        PgrSearchScope scope = countedScope(user("EMPLOYEE", ME), createdBy(ME));

        assertEquals("mz", scope.tenantId);
        assertTrue(scope.tenantStateLevel);
        assertNull(scope.citizenUuid);
        assertNull(scope.departmentCodes);
        assertNull(scope.jurisdictionCodes);
    }

    @Test
    void count_someoneElsesFilings_keepsTheScope() {
        assertSame(DEPARTMENT_SCOPE, countedScope(user("EMPLOYEE", ME), createdBy("other-uuid")));
    }

    @Test
    void count_ownAndSomeoneElsesFilings_keepsTheScope() {
        assertSame(DEPARTMENT_SCOPE, countedScope(user("EMPLOYEE", ME), createdBy(ME, "other-uuid")));
    }

    @Test
    void count_citizen_keepsTheScope() {
        assertSame(DEPARTMENT_SCOPE, countedScope(user("CITIZEN", ME), createdBy(ME)));
    }

    @Test
    void count_deniedScope_staysDenied() {
        PgrSearchScope denied = PgrSearchScope.deniedAll("mz", true);
        when(searchAccessPolicyService.resolveScope(any(), any(), anyInt())).thenReturn(denied);

        assertSame(denied, countedScope(user("EMPLOYEE", ME), createdBy(ME)));
    }

    @Test
    void search_ownFilings_queriesAndEnforcesWithTheSameRelaxedScope() {
        when(repository.getServiceWrappers(any(), any())).thenReturn(List.of(new ServiceWrapper()));
        when(searchAccessPolicyService.enforce(any(), any(), any(), any())).thenReturn(Collections.emptyList());

        pgrService.search(user("EMPLOYEE", ME), createdBy(ME));

        ArgumentCaptor<PgrSearchScope> queried = ArgumentCaptor.forClass(PgrSearchScope.class);
        ArgumentCaptor<PgrSearchScope> enforced = ArgumentCaptor.forClass(PgrSearchScope.class);
        verify(repository).getServiceWrappers(any(), queried.capture());
        verify(searchAccessPolicyService).enforce(any(), any(), enforced.capture(), any());
        assertNull(queried.getValue().departmentCodes);
        assertNull(queried.getValue().jurisdictionCodes);
        assertSame(queried.getValue(), enforced.getValue());
    }

    @Test
    void search_ownFilings_skipsTheOlderDepartmentAndJurisdictionFilters() {
        pgrService.search(user("EMPLOYEE", ME), createdBy(ME));

        verify(employeeDepartmentScopeService, never()).applyScope(any(), any(), any());
        verify(employeeJurisdictionScopeService, never()).applyScope(any(), any(), any());
    }

    @Test
    void search_someoneElsesFilings_appliesTheOlderDepartmentFilter() {
        pgrService.search(user("EMPLOYEE", ME), createdBy("other-uuid"));

        verify(employeeDepartmentScopeService).applyScope(any(), any(), any());
    }
}
