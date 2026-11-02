package org.egov.pgr.policy;

import org.egov.common.contract.request.RequestInfo;
import org.egov.common.contract.request.User;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * {@code user.creatorExempt} is read off the resolved scope, so the JsonLogic re-check grants the
 * creator branch exactly when the SQL scope carries {@code creatorUuid} for this caller.
 */
class PolicyInputBuilderTest {

    private final PolicyInputBuilder inputBuilder = new PolicyInputBuilder();

    @Test
    void creatorExemptFollowsTheScopesCreatorUuid() {
        RequestInfo caller = employee("emp-1");

        assertEquals(true, inputBuilder.buildUserDoc(caller, scope("emp-1")).get("creatorExempt"));
        assertEquals(false, inputBuilder.buildUserDoc(caller, scope(null)).get("creatorExempt"));
        assertEquals(false, inputBuilder.buildUserDoc(caller, scope("emp-2")).get("creatorExempt"),
                "a scope resolved for someone else never exempts this caller");
    }

    @Test
    void noCallerIsNeverExempt() {
        assertEquals(false, inputBuilder.buildUserDoc(null, scope("emp-1")).get("creatorExempt"));
        assertEquals(false, inputBuilder.buildUserDoc(new RequestInfo(), scope("emp-1")).get("creatorExempt"));
    }

    private static PgrSearchScope scope(String creatorUuid) {
        return new PgrSearchScope("pg.city", false, null, List.of("DEPT_1"), null, creatorUuid);
    }

    private static RequestInfo employee(String uuid) {
        RequestInfo requestInfo = new RequestInfo();
        requestInfo.setUserInfo(User.builder().uuid(uuid).type("EMPLOYEE").build());
        return requestInfo;
    }
}
