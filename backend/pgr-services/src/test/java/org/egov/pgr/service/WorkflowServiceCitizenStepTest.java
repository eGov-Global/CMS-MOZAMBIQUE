package org.egov.pgr.service;

import org.egov.common.contract.request.User;
import org.egov.pgr.web.models.Document;
import org.egov.pgr.web.models.Workflow;
import org.egov.pgr.web.models.workflow.ProcessInstance;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * #193 — what the citizen's complaint search keeps of the latest workflow step:
 * the same rule as the chronology (own step, or RESOLVE / REJECT).
 */
class WorkflowServiceCitizenStepTest {

    private static final String COMPLAINANT = "citizen-uuid-1";
    private static final String OFFICER = "officer-uuid-9";

    private static Workflow workflow(String action) {
        Document doc = new Document();
        doc.setFileStoreId("file-1");
        return Workflow.builder()
                .action(action)
                .comments("note on " + action)
                .verificationDocuments(new java.util.ArrayList<>(List.of(doc)))
                .build();
    }

    private static ProcessInstance stepBy(String actorUuid) {
        ProcessInstance pi = new ProcessInstance();
        pi.setAssigner(User.builder().uuid(actorUuid).build());
        return pi;
    }

    @Test
    void internalStepLosesCommentAndAttachments() {
        Workflow wf = workflow("ASSIGN");
        WorkflowService.hideInternalStepContent(wf, stepBy(OFFICER), COMPLAINANT);
        assertEquals("ASSIGN", wf.getAction());
        assertNull(wf.getComments());
        assertNull(wf.getVerificationDocuments());
    }

    @Test
    void cmsInternalStepsAreHiddenToo() {
        for (String action : List.of("COMMENT", "AWAITINGINFORMATION", "REFER", "RESOLVEBYSUPERVISOR")) {
            Workflow wf = workflow(action);
            WorkflowService.hideInternalStepContent(wf, stepBy(OFFICER), COMPLAINANT);
            assertNull(wf.getVerificationDocuments(), action);
            assertNull(wf.getComments(), action);
        }
    }

    @Test
    void resolveAndRejectReachTheCitizen() {
        for (String action : List.of("RESOLVE", "REJECT")) {
            Workflow wf = workflow(action);
            WorkflowService.hideInternalStepContent(wf, stepBy(OFFICER), COMPLAINANT);
            assertEquals(1, wf.getVerificationDocuments().size(), action);
            assertEquals("note on " + action, wf.getComments(), action);
        }
    }

    @Test
    void theCitizensOwnStepStaysWhole() {
        for (String action : List.of("APPLY", "REOPEN", "RATE")) {
            Workflow wf = workflow(action);
            WorkflowService.hideInternalStepContent(wf, stepBy(COMPLAINANT), COMPLAINANT);
            assertEquals(1, wf.getVerificationDocuments().size(), action);
            assertEquals("note on " + action, wf.getComments(), action);
        }
    }

    @Test
    void missingActorOrActionIsTreatedAsInternal() {
        Workflow noActor = workflow("ASSIGN");
        WorkflowService.hideInternalStepContent(noActor, null, COMPLAINANT);
        assertNull(noActor.getVerificationDocuments());

        Workflow noAction = workflow(null);
        assertDoesNotThrow(() -> WorkflowService.hideInternalStepContent(noAction, stepBy(OFFICER), COMPLAINANT));
        assertNull(noAction.getVerificationDocuments());

        assertDoesNotThrow(() -> WorkflowService.hideInternalStepContent(null, stepBy(OFFICER), COMPLAINANT));
    }
}
