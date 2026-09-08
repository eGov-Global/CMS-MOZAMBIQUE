package org.egov.pgr.util;

import org.egov.common.contract.request.RequestInfo;
import org.egov.pgr.web.models.Service;
import org.egov.pgr.web.models.User;

import static org.egov.pgr.util.PGRConstants.MASK_SENTINEL;
import static org.egov.pgr.util.PGRConstants.ROLE_INTERNAL_MICROSERVICE;

/**
 * CRQ "Complaint Chronology Visibility" v2.0 (AC-06): on a CONFIDENTIAL
 * complaint the complainant's identity must be masked SERVER-SIDE, not only on
 * screen. The backend already masks extendedAttributes (witness fields etc.)
 * this way; the {@code service.citizen} block — enriched from egov-user in
 * clear on every read — was the remaining gap: any employee of the tenant,
 * with no special role, could read a confidential complainant's name, phone
 * and address straight off the API.
 *
 * This is deliberately a small pure utility so the masking rules are unit
 * testable without mocking PGRService's dependency graph. The CALLER decides
 * when to apply it (confidential + caller not authorized); this class only
 * answers "how to mask" and "is this a machine caller".
 */
public final class CitizenIdentityMask {

    private CitizenIdentityMask() {
    }

    /**
     * Masks the complainant's identifying fields with the same sentinel the
     * extendedAttributes masking uses, so masked rows look identical whichever
     * layer produced them.
     *
     * uuid is deliberately KEPT: it is already exposed as service.accountId,
     * carries no direct identity, and the frontend matches the complainant's
     * timeline entries against it. userName is masked because for citizens it
     * is the mobile number.
     */
    public static void apply(Service svc) {
        if (svc == null)
            return;
        User citizen = svc.getCitizen();
        if (citizen == null)
            return;
        if (citizen.getName() != null)
            citizen.setName(MASK_SENTINEL);
        if (citizen.getUserName() != null)
            citizen.setUserName(MASK_SENTINEL);
        if (citizen.getMobileNumber() != null)
            citizen.setMobileNumber(MASK_SENTINEL);
        if (citizen.getEmailId() != null)
            citizen.setEmailId(MASK_SENTINEL);
        if (citizen.getCorrespondenceAddress() != null)
            citizen.setCorrespondenceAddress(MASK_SENTINEL);
    }

    /**
     * Machine callers keep clear data: masking exists to protect the identity
     * from HUMAN viewers on presentation endpoints, while internal consumers
     * (schedulers, service-to-service reads) must never receive the sentinel
     * where a phone number is expected. A missing userInfo is treated as a
     * machine context for the same reason — presentation traffic always
     * carries one.
     */
    public static boolean isInternalCaller(RequestInfo requestInfo) {
        if (requestInfo == null || requestInfo.getUserInfo() == null)
            return true;
        if ("SYSTEM".equalsIgnoreCase(requestInfo.getUserInfo().getType()))
            return true;
        if (requestInfo.getUserInfo().getRoles() == null)
            return false;
        return requestInfo.getUserInfo().getRoles().stream()
                .anyMatch(r -> ROLE_INTERNAL_MICROSERVICE.equals(r.getCode()));
    }
}
