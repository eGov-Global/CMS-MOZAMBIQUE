package org.egov.pgr.web.controllers;

import org.egov.pgr.web.models.RequestSearchCriteria;
import org.junit.jupiter.api.Test;
import org.springframework.beans.MutablePropertyValues;
import org.springframework.web.bind.WebDataBinder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Query params bind RequestSearchCriteria through @ModelAttribute, where @JsonIgnore does not
 * apply: the server-resolved fields must be refused by the controller's @InitBinder.
 */
class RequestsApiControllerBinderTest {

    @Test
    void internalVisibilityFieldsCannotBeSetFromQueryParams() {
        RequestSearchCriteria criteria = new RequestSearchCriteria();
        WebDataBinder binder = new WebDataBinder(criteria);
        new RequestsApiController(null, null, null, null, null).disallowInternalCriteriaFields(binder);

        MutablePropertyValues params = new MutablePropertyValues();
        params.add("tenantId", "mz");
        params.add("mineCreatorUuid", "someone-else");
        params.add("visibilityIds", "PRD-1");
        params.add("skipEmployeeDepartmentScope", "true");
        binder.bind(params);

        assertEquals("mz", criteria.getTenantId());
        assertNull(criteria.getMineCreatorUuid());
        assertNull(criteria.getVisibilityIds());
        assertFalse(criteria.isSkipEmployeeDepartmentScope());
    }
}
