package org.egov.pgr.util;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.jayway.jsonpath.JsonPath;
import com.jayway.jsonpath.PathNotFoundException;
import lombok.extern.slf4j.Slf4j;
import org.egov.common.contract.request.RequestInfo;
import org.egov.common.contract.request.User;
import org.egov.mdms.model.MasterDetail;
import org.egov.mdms.model.MdmsCriteria;
import org.egov.mdms.model.MdmsCriteriaReq;
import org.egov.mdms.model.ModuleDetail;
import org.egov.pgr.repository.ServiceRequestRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.util.CollectionUtils;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.egov.pgr.util.PGRConstants.MDMS_INBOX_VISIBILITY_CONFIG;
import static org.egov.pgr.util.PGRConstants.MDMS_INBOX_VISIBILITY_CONFIG_JSONPATH;
import static org.egov.pgr.util.PGRConstants.MDMS_MODULE_NAME;
import static org.egov.pgr.util.PGRConstants.USERTYPE_EMPLOYEE;

/**
 * Whether a caller holds a role listed in {@code RAINMAKER-PGR.InboxVisibilityConfig.creatorRoles}
 * on the state-root record — the roles (a reception officer, say) that file complaints on a
 * citizen's behalf and so keep seeing what they filed outside their own department/jurisdiction.
 *
 * <p>The one answer for the inbox MINE scope ({@code VisibilityService}) and for the search scope's
 * creator exemption ({@code PolicyDrivenScopeResolver} sets {@code PgrSearchScope.creatorUuid}, which
 * {@code PolicyInputBuilder} carries into the re-check as {@code user.creatorExempt}). Codes are
 * compared trimmed and upper-cased on both sides, as {@link RoleCodes} and {@code ScopePolicy} do;
 * a missing or malformed {@code creatorRoles} grants nothing.
 */
@Slf4j
@Component
public class CreatorRoles {

    public static final String CONFIG_KEY = "creatorRoles";

    /** The search scope asks on every request; a configurator change still lands within minutes. */
    private static final long CACHE_TTL_MILLIS = TimeUnit.MINUTES.toMillis(5);

    private final ServiceRequestRepository serviceRequestRepository;
    private final MDMSUtils mdmsUtils;

    private final Cache<String, Set<String>> cache = Caffeine.newBuilder()
            .expireAfterWrite(CACHE_TTL_MILLIS, TimeUnit.MILLISECONDS)
            .build();

    @Autowired
    public CreatorRoles(ServiceRequestRepository serviceRequestRepository, MDMSUtils mdmsUtils) {
        this.serviceRequestRepository = serviceRequestRepository;
        this.mdmsUtils = mdmsUtils;
    }

    /** Against an InboxVisibilityConfig record the caller has already fetched. */
    public boolean holdsCreatorRole(User user, Map<String, Object> visibilityConfig) {
        return holdsAny(user, configuredCodes(visibilityConfig));
    }

    /**
     * Against the tenant's state-root record, cached per state for {@link #CACHE_TTL_MILLIS}. An
     * MDMS failure grants nothing and is not cached, so the next call retries.
     */
    public boolean holdsCreatorRole(RequestInfo requestInfo, String tenantId) {
        User user = requestInfo == null ? null : requestInfo.getUserInfo();
        if (user == null || tenantId == null || tenantId.isBlank())
            return false;
        return holdsAny(user, cachedCodes(requestInfo, tenantId.split("\\.")[0]));
    }

    /**
     * The uuid a search scope may exempt from its department/jurisdiction axes for the complaints
     * that caller created, or null. EMPLOYEE type only: the re-check's creator branch
     * ({@code AccessPolicyRegistry}) keys on {@code user.type == "EMPLOYEE"}, and the SQL scope must
     * not admit a row that branch would then drop.
     */
    public String exemptCreatorUuid(RequestInfo requestInfo, String tenantId) {
        User user = requestInfo == null ? null : requestInfo.getUserInfo();
        if (user == null || user.getUuid() == null || user.getUuid().isBlank()
                || !USERTYPE_EMPLOYEE.equals(user.getType()))
            return null;
        return holdsCreatorRole(requestInfo, tenantId) ? user.getUuid() : null;
    }

    private Set<String> cachedCodes(RequestInfo requestInfo, String stateTenant) {
        try {
            return cache.get(stateTenant, key -> fetchCodes(requestInfo, key));
        } catch (Exception e) {
            log.warn("InboxVisibilityConfig.creatorRoles lookup failed for {} — no creator exemption on this request: {}",
                    stateTenant, e.toString());
            return Set.of();
        }
    }

    @SuppressWarnings("unchecked")
    private Set<String> fetchCodes(RequestInfo requestInfo, String stateTenant) {
        ModuleDetail moduleDetail = ModuleDetail.builder()
                .moduleName(MDMS_MODULE_NAME)
                .masterDetails(Collections.singletonList(
                        MasterDetail.builder().name(MDMS_INBOX_VISIBILITY_CONFIG).build()))
                .build();
        MdmsCriteriaReq req = MdmsCriteriaReq.builder()
                .requestInfo(requestInfo)
                .mdmsCriteria(MdmsCriteria.builder()
                        .tenantId(stateTenant)
                        .moduleDetails(Collections.singletonList(moduleDetail))
                        .build())
                .build();
        // fetchResult swallows transport errors into null; throwing keeps that out of the cache.
        Object result = serviceRequestRepository.fetchResult(mdmsUtils.getMdmsSearchUrl(), req);
        if (result == null)
            throw new IllegalStateException("MDMS returned no response");

        List<Object> configs;
        try {
            configs = JsonPath.read(result, MDMS_INBOX_VISIBILITY_CONFIG_JSONPATH);
        } catch (PathNotFoundException e) {
            return Set.of();
        }
        if (CollectionUtils.isEmpty(configs) || !(configs.get(0) instanceof Map))
            return Set.of();
        return configuredCodes((Map<String, Object>) configs.get(0));
    }

    private static Set<String> configuredCodes(Map<String, Object> visibilityConfig) {
        Object raw = visibilityConfig == null ? null : visibilityConfig.get(CONFIG_KEY);
        if (!(raw instanceof List))
            return Set.of();
        Set<String> codes = new LinkedHashSet<>();
        for (Object entry : (List<?>) raw) {
            if (entry instanceof String && !((String) entry).isBlank())
                codes.add(((String) entry).trim().toUpperCase());
        }
        return codes;
    }

    private static boolean holdsAny(User user, Set<String> creatorRoleCodes) {
        if (creatorRoleCodes.isEmpty())
            return false;
        return RoleCodes.normalize(user).stream().anyMatch(creatorRoleCodes::contains);
    }
}
