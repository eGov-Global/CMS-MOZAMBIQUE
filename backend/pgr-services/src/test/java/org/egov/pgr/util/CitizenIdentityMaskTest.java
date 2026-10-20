package org.egov.pgr.util;

import org.egov.common.contract.request.RequestInfo;
import org.egov.common.contract.request.Role;
import org.egov.pgr.web.models.Service;
import org.egov.pgr.web.models.User;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.egov.pgr.util.PGRConstants.MASK_SENTINEL;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * CRQ v2 AC-06 — the citizen-identity mask itself. The WHEN (confidential +
 * caller not authorized + presentation endpoint) is decided in PGRService and
 * covered by its existing gate; these tests pin the HOW so a masked response
 * can never leak a field, break the frontend's uuid matching, or hand a
 * sentinel to a machine caller.
 */
class CitizenIdentityMaskTest {

    private Service serviceWithCitizen() {
        User citizen = new User();
        citizen.setName("Maria João Cossa");
        citizen.setUserName("841234567");
        citizen.setMobileNumber("841234567");
        citizen.setEmailId("maria@example.mz");
        citizen.setCorrespondenceAddress("Rua Secreta 42, Maputo");
        citizen.setUuid("citizen-uuid-1");
        citizen.setTenantId("mz");
        Service svc = new Service();
        svc.setCitizen(citizen);
        svc.setAccountId("citizen-uuid-1");
        return svc;
    }

    @Test
    void masksEveryIdentifyingField() {
        Service svc = serviceWithCitizen();
        CitizenIdentityMask.apply(svc);
        assertEquals(MASK_SENTINEL, svc.getCitizen().getName());
        assertEquals(MASK_SENTINEL, svc.getCitizen().getUserName());
        assertEquals(MASK_SENTINEL, svc.getCitizen().getMobileNumber());
        assertEquals(MASK_SENTINEL, svc.getCitizen().getEmailId());
        assertEquals(MASK_SENTINEL, svc.getCitizen().getCorrespondenceAddress());
    }

    @Test
    void keepsUuidAndTenant_theFrontendMatchesTheComplainantOnUuid() {
        Service svc = serviceWithCitizen();
        CitizenIdentityMask.apply(svc);
        assertEquals("citizen-uuid-1", svc.getCitizen().getUuid());
        assertEquals("mz", svc.getCitizen().getTenantId());
    }

    @Test
    void absentFieldsStayAbsent_neverInventsASentinel() {
        Service svc = new Service();
        User citizen = new User();
        citizen.setName("Only A Name");
        svc.setCitizen(citizen);
        CitizenIdentityMask.apply(svc);
        assertEquals(MASK_SENTINEL, citizen.getName());
        assertNull(citizen.getMobileNumber());
        assertNull(citizen.getEmailId());
        assertNull(citizen.getCorrespondenceAddress());
    }

    @Test
    void nullServiceAndNullCitizenAreNoOps() {
        CitizenIdentityMask.apply(null);
        Service svc = new Service();
        CitizenIdentityMask.apply(svc);
        assertNull(svc.getCitizen());
    }

    // ---- machine-caller detection ----

    private RequestInfo requestInfoWith(String type, String... roleCodes) {
        org.egov.common.contract.request.User info = org.egov.common.contract.request.User.builder()
                .type(type)
                .roles(java.util.Arrays.stream(roleCodes)
                        .map(c -> Role.builder().code(c).build())
                        .collect(java.util.stream.Collectors.toList()))
                .build();
        RequestInfo ri = new RequestInfo();
        ri.setUserInfo(info);
        return ri;
    }

    @Test
    void systemUserIsInternal() {
        assertTrue(CitizenIdentityMask.isInternalCaller(requestInfoWith("SYSTEM", "EMPLOYEE")));
    }

    @Test
    void internalMicroserviceRoleIsInternal() {
        assertTrue(CitizenIdentityMask.isInternalCaller(
                requestInfoWith("EMPLOYEE", "EMPLOYEE", "INTERNAL_MICROSERVICE_ROLE")));
    }

    @Test
    void ordinaryEmployeeIsNotInternal() {
        assertFalse(CitizenIdentityMask.isInternalCaller(requestInfoWith("EMPLOYEE", "EMPLOYEE", "CMS_VIEWER")));
    }

    @Test
    void citizenIsNotInternal() {
        assertFalse(CitizenIdentityMask.isInternalCaller(requestInfoWith("CITIZEN", "CITIZEN")));
    }

    @Test
    void missingUserInfoIsNotInternal_anonymousCallersGetTheMask() {
        // The gateway strips client-supplied userInfo from token-less requests
        // and (audit mode) still forwards them: absent identity must fail
        // CLOSED, never into the machine-caller exemption.
        assertFalse(CitizenIdentityMask.isInternalCaller(null));
        assertFalse(CitizenIdentityMask.isInternalCaller(new RequestInfo()));
    }

    @Test
    void rolelessUserIsNotInternal() {
        RequestInfo ri = new RequestInfo();
        ri.setUserInfo(org.egov.common.contract.request.User.builder().type("EMPLOYEE").roles(List.of()).build());
        assertFalse(CitizenIdentityMask.isInternalCaller(ri));
    }
}
