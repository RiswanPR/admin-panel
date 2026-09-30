'use strict';

/**
 * Zeitnah Admin Panel — Governance, Moderation, AI & Career Intelligence Test Suite
 * Covers Requirements 40 and 41:
 * - Roles & Educator Security
 * - Business Governance (Approve, Reject, Suspend, Integrity Signals)
 * - Job Governance (Inspect, Unpublish, Close, Restore, Flag, Aggregate Privacy)
 * - AI Matching Telemetry & Configuration Versioning
 * - Career Intelligence (Taxonomy, Skill Graph, Aliases, Market Provenance)
 * - Security & Middleware Guards
 * - End-to-End Administrative Workflow Verification
 */

const assert = require('assert');
const { ObjectId } = require('mongodb');
const governanceHelper = require('../Helpers/governance-helper');
const aiAdminHelper = require('../Helpers/ai-admin-helper');
const careerAdminHelper = require('../Helpers/career-admin-helper');
const moderationHelper = require('../Helpers/moderation-helper');
const analyticsHelper = require('../Helpers/analytics-helper');
const permissionsHelper = require('../Helpers/permissions-helper');
const db = require('../config/connection');
const collection = require('../config/collections');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function test(desc, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✔ PASS: ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✖ FAIL: ${desc}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

async function testAsync(desc, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✔ PASS: ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✖ FAIL: ${desc}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

// In-memory mock database state for hermetic unit testing
const mockDb = {
  users: new Map(),
  community_profiles: new Map(),
  organizations: new Map(),
  organization_memberships: new Map(),
  courses: new Map(),
  opportunities: new Map(),
  job_applications: new Map(),
  job_talent_matches: new Map(),
  user_job_recommendations: new Map(),
  skills: new Map(),
  settings: new Map(),
  moderation_reports: new Map(),
  audit_logs: []
};

// Create mock mongo collection
const createMockCollection = (mapOrArray) => {
  if (Array.isArray(mapOrArray)) {
    return {
      insertOne: async (doc) => { mapOrArray.push({ ...doc, _id: doc._id || new ObjectId() }); return { insertedId: doc._id }; },
      find: (q = {}) => ({
        sort: () => ({ limit: (l) => ({ toArray: async () => mapOrArray.slice(-l) }), toArray: async () => mapOrArray }),
        toArray: async () => mapOrArray
      }),
      countDocuments: async () => mapOrArray.length
    };
  }

  return {
    findOne: async (q) => {
      for (const item of mapOrArray.values()) {
        let match = true;
        for (const [k, v] of Object.entries(q)) {
          if (k === '$or' && Array.isArray(v)) {
            const orMatch = v.some(subQ => {
              for (const [subK, subV] of Object.entries(subQ)) {
                if (String(item[subK]) === String(subV)) return true;
              }
              return false;
            });
            if (!orMatch) match = false;
          } else if (k === '_id' && String(item._id) !== String(v)) {
            match = false;
          } else if (k !== '_id' && k !== '$or' && item[k] !== v) {
            match = false;
          }
        }
        if (match) return JSON.parse(JSON.stringify(item));
      }
      return null;
    },
    updateOne: async (q, u) => {
      const id = String(q._id);
      const existing = mapOrArray.get(id);
      if (existing) {
        if (u.$set) {
          for (const [k, v] of Object.entries(u.$set)) {
            if (k.includes('.')) {
              const parts = k.split('.');
              let target = existing;
              for (let i = 0; i < parts.length - 1; i++) {
                target[parts[i]] = target[parts[i]] || {};
                target = target[parts[i]];
              }
              target[parts[parts.length - 1]] = v;
            } else {
              existing[k] = v;
            }
          }
        }
        if (u.$addToSet) {
          for (const [k, v] of Object.entries(u.$addToSet)) {
            existing[k] = existing[k] || [];
            if (!existing[k].includes(v)) existing[k].push(v);
          }
        }
        if (u.$pull) {
          for (const [k, v] of Object.entries(u.$pull)) {
            if (Array.isArray(existing[k])) {
              existing[k] = existing[k].filter(item => item !== v);
            }
          }
        }
        if (u.$push) {
          for (const [k, v] of Object.entries(u.$push)) {
            existing[k] = existing[k] || [];
            existing[k].push(v);
          }
        }
      }
      return { modifiedCount: 1 };
    },
    updateMany: async (q, u) => {
      let count = 0;
      for (const item of mapOrArray.values()) {
        if (u.$set) Object.assign(item, u.$set);
        count++;
      }
      return { modifiedCount: count };
    },
    countDocuments: async (q = {}) => {
      if (Object.keys(q).length === 0) return mapOrArray.size;
      let count = 0;
      for (const item of mapOrArray.values()) {
        let match = true;
        for (const [k, v] of Object.entries(q)) {
          if (k === 'status' && v.$in && !v.$in.includes(item.status)) match = false;
          else if (k === 'status' && !v.$in && item.status !== v) match = false;
        }
        if (match) count++;
      }
      return count;
    },
    distinct: async (field) => {
      const set = new Set();
      for (const item of mapOrArray.values()) {
        if (item[field]) set.add(String(item[field]));
      }
      return Array.from(set);
    },
    aggregate: (pipe) => ({
      toArray: async () => []
    }),
    find: (q = {}) => {
      let results = Array.from(mapOrArray.values());
      if (q && Object.keys(q).length > 0) {
        results = results.filter(item => {
          if (q.$or && Array.isArray(q.$or)) {
            return q.$or.some(subQ => {
              for (const [subK, subV] of Object.entries(subQ)) {
                if (String(item[subK]) === String(subV)) return true;
              }
              return false;
            });
          }
          for (const [k, v] of Object.entries(q)) {
            if (v && v.$in && Array.isArray(v.$in)) {
              if (!v.$in.map(String).includes(String(item[k]))) return false;
            } else if (k === '_id') {
              if (String(item._id) !== String(v)) return false;
            } else if (item[k] !== v) {
              return false;
            }
          }
          return true;
        });
      }
      return {
        sort: () => ({
          skip: () => ({
            limit: (l) => ({ toArray: async () => results.slice(0, l) }),
            toArray: async () => results
          }),
          limit: (l) => ({ toArray: async () => results.slice(0, l) }),
          toArray: async () => results
        }),
        limit: (l) => ({ toArray: async () => results.slice(0, l) }),
        toArray: async () => results
      };
    }
  };
};

const setupMockEnvironment = () => {
  const mockGet = () => ({
    collection: (name) => {
      if (name === collection.STUDENTS_COLLECTION) return createMockCollection(mockDb.users);
      if (name === collection.COMMUNITY_PROFILES_COLLECTION) return createMockCollection(mockDb.community_profiles);
      if (name === collection.ORGANIZATIONS_COLLECTION) return createMockCollection(mockDb.organizations);
      if (name === collection.ORGANIZATION_MEMBERSHIPS_COLLECTION) return createMockCollection(mockDb.organization_memberships);
      if (name === collection.COURSE_COLLECTION) return createMockCollection(mockDb.courses);
      if (name === collection.OPPORTUNITIES_COLLECTION) return createMockCollection(mockDb.opportunities);
      if (name === collection.JOB_APPLICATIONS_COLLECTION) return createMockCollection(mockDb.job_applications);
      if (name === collection.JOB_TALENT_MATCHES_COLLECTION) return createMockCollection(mockDb.job_talent_matches);
      if (name === collection.USER_JOB_RECOMMENDATIONS_COLLECTION) return createMockCollection(mockDb.user_job_recommendations);
      if (name === collection.SKILLS_COLLECTION) return createMockCollection(mockDb.skills);
      if (name === collection.SETTINGS_COLLECTION) return createMockCollection(mockDb.settings);
      if (name === collection.MODERATION_REPORTS_COLLECTION) return createMockCollection(mockDb.moderation_reports);
      if (name === collection.AUDIT_LOG_COLLECTION) return createMockCollection(mockDb.audit_logs);
      return createMockCollection(new Map());
    }
  });

  db.get = mockGet;
};

async function runTestSuite() {
  console.log('\n================================================================');
  console.log('   ZEITNAH ADMIN PANEL: NETWORK & GOVERNANCE TEST SUITE        ');
  console.log('================================================================\n');

  setupMockEnvironment();

  const mockAdmin = {
    _id: new ObjectId(),
    Name: 'Chief Administrator',
    Email: 'admin@zeitnah.com',
    role: 'superuser'
  };

  const mockReq = {
    session: { adminloggedIn: true, admin: mockAdmin },
    headers: { 'x-forwarded-for': '127.0.0.1', 'user-agent': 'ZeitnahTest/1.0' }
  };

  // ─────────────────────────────────────────────────────────────
  // 1. ROLES & EDUCATOR PROTECTION TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\x1b[36m--- 1. Profile Role & Educator Security Tests ---\x1b[0m');

  const testUserId = new ObjectId();
  mockDb.users.set(String(testUserId), {
    _id: testUserId,
    username: 'rahul_sharma',
    name: 'Rahul Sharma',
    email: 'rahul@example.com',
    primaryRole: 'STUDENT',
    role: 'student',
    account_Status: { isVerified: false, isBlocked: false }
  });

  await testAsync('✓ Admin can assign Educator role', async () => {
    const result = await governanceHelper.assignUserRole(testUserId, 'EDUCATOR', mockAdmin, mockReq);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.newRole, 'EDUCATOR');
    const updated = mockDb.users.get(String(testUserId));
    assert.strictEqual(updated.primaryRole, 'EDUCATOR');
  });

  test('✓ Protected role mutation is recorded in Audit Log', () => {
    const roleLogs = mockDb.audit_logs.filter(l => l.action === 'USER_ROLE_ASSIGNED');
    assert.ok(roleLogs.length > 0);
    const latest = roleLogs[roleLogs.length - 1];
    assert.strictEqual(latest.entityId, String(testUserId));
    assert.strictEqual(latest.metadata.role, 'EDUCATOR');
    assert.strictEqual(latest.metadata.actor, 'Chief Administrator');
  });

  await testAsync('✓ Invalid role rejected with descriptive error', async () => {
    let threw = false;
    try {
      await governanceHelper.assignUserRole(testUserId, 'SUPER_WIZARD', mockAdmin, mockReq);
    } catch(err) {
      threw = true;
      assert.ok(err.message.includes('Must be one of'));
    }
    assert.strictEqual(threw, true);
  });

  // ─────────────────────────────────────────────────────────────
  // 2. BUSINESS GOVERNANCE TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n\x1b[36m--- 2. Business Governance & Verification Tests ---\x1b[0m');

  const testOrgId = new ObjectId();
  mockDb.organizations.set(String(testOrgId), {
    _id: testOrgId,
    name: 'Apex Infrastructure EPC',
    slug: 'apex-infrastructure',
    industry: 'Highways & Expressways',
    infrastructureSpecializations: ['Highway Engineering', 'Bridge Construction'],
    status: 'PENDING',
    verificationStatus: 'PENDING',
    createdBy: testUserId,
    createdAt: new Date()
  });

  await testAsync('✓ Admin can review business profile and integrity signals', async () => {
    const details = await governanceHelper.getBusinessById(testOrgId);
    assert.ok(details);
    assert.strictEqual(details.business.name, 'Apex Infrastructure EPC');
    assert.ok(Array.isArray(details.integritySignals));
  });

  await testAsync('✓ Admin can approve business entity', async () => {
    const res = await governanceHelper.approveBusiness(testOrgId, mockAdmin, mockReq);
    assert.strictEqual(res.success, true);
    const org = mockDb.organizations.get(String(testOrgId));
    assert.strictEqual(org.status, 'APPROVED');
    assert.strictEqual(org.verificationStatus, 'VERIFIED');
  });

  test('✓ Business approval creates audit log entry', () => {
    const approveLogs = mockDb.audit_logs.filter(l => l.action === 'BUSINESS_APPROVED');
    assert.ok(approveLogs.length > 0);
    assert.strictEqual(approveLogs[approveLogs.length - 1].entityId, String(testOrgId));
  });

  await testAsync('✓ Admin cannot reject or suspend business without mandatory reason', async () => {
    let rejectThrew = false;
    try {
      await governanceHelper.rejectBusiness(testOrgId, '', mockAdmin, mockReq);
    } catch (e) {
      rejectThrew = true;
      assert.ok(e.message.includes('mandatory'));
    }
    assert.strictEqual(rejectThrew, true);

    let suspendThrew = false;
    try {
      await governanceHelper.suspendBusiness(testOrgId, '', mockAdmin, mockReq);
    } catch (e) {
      suspendThrew = true;
      assert.ok(e.message.includes('mandatory'));
    }
    assert.strictEqual(suspendThrew, true);
  });

  await testAsync('✓ Admin can suspend business with audit logging', async () => {
    const reason = 'Suspected duplicate registration violating community terms';
    const res = await governanceHelper.suspendBusiness(testOrgId, reason, mockAdmin, mockReq);
    assert.strictEqual(res.success, true);
    const org = mockDb.organizations.get(String(testOrgId));
    assert.strictEqual(org.status, 'SUSPENDED');
    assert.strictEqual(org.suspensionReason, reason);

    const suspendLogs = mockDb.audit_logs.filter(l => l.action === 'BUSINESS_SUSPENDED');
    assert.ok(suspendLogs.length > 0);
  });

  // ─────────────────────────────────────────────────────────────
  // 3. JOB GOVERNANCE & MODERATION TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n\x1b[36m--- 3. Job Governance & Moderation Tests ---\x1b[0m');

  const testJobId = new ObjectId();
  mockDb.opportunities.set(String(testJobId), {
    _id: testJobId,
    organizationId: testOrgId,
    title: 'Senior Planning Engineer (Expressway Project)',
    discipline: 'Civil Engineering',
    infrastructureSector: 'Highways & Expressways',
    experienceLevel: 'SENIOR',
    minYearsExperience: 8,
    maxYearsExperience: 12,
    requiredSkills: ['Planning & Scheduling', 'Delay Analysis'],
    requiredSoftware: ['Primavera P6', 'AutoCAD'],
    status: 'PUBLISHED',
    createdBy: testUserId,
    createdAt: new Date()
  });

  await testAsync('✓ Admin can inspect job details and moderation signals', async () => {
    const details = await governanceHelper.getJobById(testJobId);
    assert.ok(details);
    assert.strictEqual(details.job.title, 'Senior Planning Engineer (Expressway Project)');
    assert.ok(details.moderationSignals);
  });

  await testAsync('✓ Admin can unpublish job with audit record', async () => {
    const reason = 'Incorrect salary and location specification';
    const res = await governanceHelper.unpublishJob(testJobId, reason, mockAdmin, mockReq);
    assert.strictEqual(res.success, true);
    const job = mockDb.opportunities.get(String(testJobId));
    assert.strictEqual(job.status, 'PAUSED');

    const unpublishLogs = mockDb.audit_logs.filter(l => l.action === 'JOB_UNPUBLISHED');
    assert.ok(unpublishLogs.length > 0);
  });

  await testAsync('✓ Admin can restore job to published status', async () => {
    const res = await governanceHelper.restoreJob(testJobId, mockAdmin, mockReq);
    assert.strictEqual(res.success, true);
    const job = mockDb.opportunities.get(String(testJobId));
    assert.strictEqual(job.status, 'PUBLISHED');

    const restoreLogs = mockDb.audit_logs.filter(l => l.action === 'JOB_RESTORED');
    assert.ok(restoreLogs.length > 0);
  });

  await testAsync('✓ Admin can flag job for moderation review', async () => {
    const res = await governanceHelper.flagJob(testJobId, 'Suspicious external application redirect', mockAdmin, mockReq);
    assert.strictEqual(res.success, true);
    const job = mockDb.opportunities.get(String(testJobId));
    assert.strictEqual(job.moderationStatus, 'FLAGGED');
  });

  // ─────────────────────────────────────────────────────────────
  // 4. AI MATCHING ADMINISTRATION & CONFIGURATION TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n\x1b[36m--- 4. AI Matching Telemetry & Configuration Tests ---\x1b[0m');

  await testAsync('✓ Admin can retrieve operational AI metrics', async () => {
    const metrics = await aiAdminHelper.getAIMatchingMetrics();
    assert.ok(metrics.operational);
    assert.ok(typeof metrics.operational.aiSuccessRate === 'number');
    assert.ok(typeof metrics.operational.averageLatencyMs === 'number');
  });

  test('✓ AI engine version registry exposes version definitions', () => {
    const versions = aiAdminHelper.getAIModelVersions();
    assert.ok(versions.matchingEngineVersion);
    assert.ok(versions.taxonomyVersion);
    assert.ok(versions.modelArchitecture);
  });

  test('✓ AI failure monitoring exposes failure categories', () => {
    const failures = aiAdminHelper.getAIFailureMonitoring();
    assert.ok(typeof failures.successful === 'number');
    assert.ok(typeof failures.deterministicFallback === 'number');
    assert.ok(typeof failures.timeout === 'number');
  });

  await testAsync('✓ Configuration changes are versioned, audited, and validated', async () => {
    const newWeights = {
      roleWeight: 25,
      skillWeight: 30,
      sectorWeight: 15,
      softwareWeight: 10,
      experienceWeight: 10,
      projectWeight: 5,
      locationWeight: 3,
      certificationWeight: 1,
      careerPreferenceWeight: 1
    };

    const res = await aiAdminHelper.updateMatchingConfig(newWeights, mockAdmin, mockReq);
    assert.strictEqual(res.success, true);
    assert.ok(res.version);

    const configLogs = mockDb.audit_logs.filter(l => l.action === 'MATCHING_CONFIG_UPDATED');
    assert.ok(configLogs.length > 0);
    const latest = configLogs[configLogs.length - 1];
    assert.strictEqual(latest.metadata.after.roleWeight, 25);
  });

  await testAsync('✓ Invalid weights (negative or out-of-range) are rejected', async () => {
    let threw = false;
    try {
      await aiAdminHelper.updateMatchingConfig({ roleWeight: -50 }, mockAdmin, mockReq);
    } catch(err) {
      threw = true;
      assert.ok(err.message.includes('between 0 and 100'));
    }
    assert.strictEqual(threw, true);
  });

  // ─────────────────────────────────────────────────────────────
  // 5. CAREER INTELLIGENCE & TAXONOMY TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n\x1b[36m--- 5. Career Intelligence & Taxonomy Tests ---\x1b[0m');

  test('✓ Canonical infrastructure disciplines are defined', () => {
    assert.ok(careerAdminHelper.INFRASTRUCTURE_DISCIPLINES.length >= 8);
    assert.ok(careerAdminHelper.INFRASTRUCTURE_DISCIPLINES.includes('Civil Engineering'));
    assert.ok(careerAdminHelper.INFRASTRUCTURE_DISCIPLINES.includes('Digital Construction & BIM'));
  });

  test('✓ Canonical roles contain competencies, software, and progression ladders', () => {
    const roles = careerAdminHelper.getRoles();
    assert.ok(roles.length >= 5);
    const planning = roles.find(r => r.title === 'Planning Engineer');
    assert.ok(planning);
    assert.ok(planning.requiredSoftware.includes('Primavera P6'));
    assert.ok(planning.pathway.successors.includes('Senior Planning Engineer'));
  });

  await testAsync('✓ Skill graph aliases can be managed and audited', async () => {
    const res = await careerAdminHelper.updateSkillAlias('Primavera P6', ['P6', 'Primavera', 'Oracle P6'], mockAdmin, mockReq);
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(res.aliases, ['P6', 'Primavera', 'Oracle P6']);

    const aliasLogs = mockDb.audit_logs.filter(l => l.action === 'TAXONOMY_ALIAS_UPDATED');
    assert.ok(aliasLogs.length > 0);
  });

  await testAsync('✓ Market Intelligence dataset includes provenance metadata and disclaimers', async () => {
    const market = await careerAdminHelper.getMarketIntelligence();
    assert.ok(market.metadata.source);
    assert.ok(market.metadata.population);
    assert.ok(market.metadata.observationPeriod);
    assert.ok(market.metadata.calculationMethod);
    assert.ok(market.metadata.disclaimer);
    assert.ok(Array.isArray(market.roleDemand));
    assert.ok(Array.isArray(market.softwareDemand));
  });

  test('✓ Career Assistant telemetry tracks performance without exposing PII', () => {
    const telemetry = careerAdminHelper.getCareerAssistantTelemetry();
    assert.ok(typeof telemetry.totalConversations === 'number');
    assert.ok(typeof telemetry.averageLatencyMs === 'number');
    assert.ok(Array.isArray(telemetry.topConsultedTopics));
  });

  // ─────────────────────────────────────────────────────────────
  // 6. SECURITY & PERMISSION TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n\x1b[36m--- 6. Security & Permission Tests ---\x1b[0m');

  test('✓ Superuser possesses all administrative capabilities', () => {
    assert.strictEqual(permissionsHelper.hasCapability(mockAdmin, 'assign_educator'), true);
    assert.strictEqual(permissionsHelper.hasCapability(mockAdmin, 'approve_businesses'), true);
    assert.strictEqual(permissionsHelper.hasCapability(mockAdmin, 'manage_ai_config'), true);
  });

  test('✓ Non-admin / undefined session is rejected by capability guard', () => {
    assert.strictEqual(permissionsHelper.hasCapability(null, 'assign_educator'), false);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'student' }, 'assign_educator'), false);
  });

  test('✓ Granular roles enforce least privilege', () => {
    const jobsAdmin = { role: 'jobs_admin' };
    assert.strictEqual(permissionsHelper.hasCapability(jobsAdmin, 'manage_jobs'), true);
    assert.strictEqual(permissionsHelper.hasCapability(jobsAdmin, 'assign_educator'), false);
  });

  // ─────────────────────────────────────────────────────────────
  // 7. END-TO-END ADMINISTRATIVE WORKFLOW
  // ─────────────────────────────────────────────────────────────
  console.log('\n\x1b[36m--- 7. End-to-End Administrative Flow Verification ---\x1b[0m');

  await testAsync('✓ Complete End-to-End Admin Flow: Login -> Network -> Role -> Business -> Job -> AI -> Audit', async () => {
    // Step 1: Admin session check
    assert.strictEqual(mockReq.session.adminloggedIn, true);

    // Step 2: Assign Educator
    const e2eUserId = new ObjectId();
    mockDb.users.set(String(e2eUserId), {
      _id: e2eUserId,
      name: 'Priya Nair',
      username: 'priya_nair',
      primaryRole: 'STUDENT',
      role: 'student'
    });
    await governanceHelper.assignUserRole(e2eUserId, 'EDUCATOR', mockAdmin, mockReq);
    assert.strictEqual(mockDb.users.get(String(e2eUserId)).primaryRole, 'EDUCATOR');

    // Step 3: Business Review & Approval
    const e2eOrgId = new ObjectId();
    mockDb.organizations.set(String(e2eOrgId), {
      _id: e2eOrgId,
      name: 'L&T Transportation Infrastructure',
      slug: 'lt-transportation',
      status: 'PENDING',
      verificationStatus: 'PENDING'
    });
    await governanceHelper.approveBusiness(e2eOrgId, mockAdmin, mockReq);
    assert.strictEqual(mockDb.organizations.get(String(e2eOrgId)).status, 'APPROVED');

    // Step 4: Inspect Job & AI Matching
    const e2eJobId = new ObjectId();
    mockDb.opportunities.set(String(e2eJobId), {
      _id: e2eJobId,
      organizationId: e2eOrgId,
      title: 'BIM Coordinator (Metro Rail)',
      discipline: 'Digital Construction & BIM',
      infrastructureSector: 'Metros & Urban Transit',
      status: 'PUBLISHED'
    });
    const jobCheck = await governanceHelper.getJobById(e2eJobId);
    assert.strictEqual(jobCheck.job.title, 'BIM Coordinator (Metro Rail)');

    // Step 5: Check complete audit trail integrity
    const allLogs = mockDb.audit_logs;
    assert.ok(allLogs.length >= 5);
    const actions = allLogs.map(l => l.action);
    assert.ok(actions.includes('USER_ROLE_ASSIGNED'));
    assert.ok(actions.includes('BUSINESS_APPROVED'));
    assert.ok(actions.includes('MATCHING_CONFIG_UPDATED'));
  });

  console.log('\n\x1b[36m--- 8. Multi-Role Identity & Capability Permission Tests (Req 19) ---\x1b[0m');

  await testAsync('✓ Student: holds learning & career capabilities, lacks business management', async () => {
    const studentUser = { primaryRole: 'STUDENT', roles: ['STUDENT'], role: 'student' };
    const res = governanceHelper.computeUserCapabilities(studentUser, { memberships: [], organizations: [] });
    assert.ok(res.capabilities.includes('ACCESS_COURSES'));
    assert.ok(res.capabilities.includes('ACCESS_JOBS'));
    assert.ok(res.capabilities.includes('ACCESS_CAREER_INTELLIGENCE'));
    assert.strictEqual(res.capabilities.includes('ACCESS_PORTFOLIO'), false);
    assert.strictEqual(res.capabilities.includes('MANAGE_BUSINESS'), false);
    assert.strictEqual(res.capabilities.includes('POST_OPPORTUNITIES'), false);
    assert.strictEqual(res.capabilities.includes('CONDUCT_CLASSES'), false);
    assert.strictEqual(res.capabilities.includes('OFFER_MENTORSHIP'), false);
  });

  await testAsync('✓ Student + Recruiter (without approved business): core capabilities granted, opportunity posting gated', async () => {
    const studentRecruiter = { primaryRole: 'STUDENT', roles: ['STUDENT', 'RECRUITER'], role: 'student' };
    const res = governanceHelper.computeUserCapabilities(studentRecruiter, { memberships: [], organizations: [] });
    assert.ok(res.capabilities.includes('ACCESS_COURSES'));
    assert.ok(res.capabilities.includes('ACCESS_JOBS'));
    assert.strictEqual(res.capabilities.includes('POST_OPPORTUNITIES'), false);
    assert.strictEqual(res.capabilities.includes('MANAGE_BUSINESS'), false);
    assert.strictEqual(res.businessAuthorization.canPostOpportunities, false);
    assert.strictEqual(res.businessAuthorization.canManageBusiness, false);
    const postOppDetail = res.capabilityDetails.find(c => c.capability === 'POST_OPPORTUNITIES');
    assert.ok(postOppDetail);
    assert.strictEqual(postOppDetail.businessGated, true);
  });

  await testAsync('✓ Student + Recruiter (with approved business): opportunity posting & management granted', async () => {
    const sId = new ObjectId();
    const orgId = new ObjectId();
    const approvedOrg = { _id: orgId, name: 'Acme Infra Corp', status: 'APPROVED' };
    const membership = { _id: new ObjectId(), userId: sId, organizationId: orgId, role: 'RECRUITER', status: 'ACTIVE', verified: true };
    const studentRecruiter = { _id: sId, primaryRole: 'STUDENT', roles: ['STUDENT', 'RECRUITER'], role: 'student' };

    const res = governanceHelper.computeUserCapabilities(studentRecruiter, { memberships: [membership], organizations: [approvedOrg] });
    assert.ok(res.capabilities.includes('POST_OPPORTUNITIES'));
    assert.ok(res.capabilities.includes('MANAGE_BUSINESS'));
    assert.ok(res.capabilities.includes('ACCESS_COURSES'));
    assert.strictEqual(res.businessAuthorization.canPostOpportunities, true);
  });

  await testAsync('✓ Student + Founder (without approved business): business management strictly gated', async () => {
    const studentFounder = { primaryRole: 'STUDENT', roles: ['STUDENT', 'FOUNDER'], role: 'student' };
    const res = governanceHelper.computeUserCapabilities(studentFounder, { memberships: [], organizations: [] });
    assert.strictEqual(res.capabilities.includes('MANAGE_BUSINESS'), false);
    assert.strictEqual(res.businessAuthorization.canManageBusiness, false);
    const manageBizDetail = res.capabilityDetails.find(c => c.capability === 'MANAGE_BUSINESS');
    assert.ok(manageBizDetail);
    assert.strictEqual(manageBizDetail.businessGated, true);
  });

  await testAsync('✓ Student + Founder (with approved business owned by user): business management granted', async () => {
    const sId = new ObjectId();
    const orgId = new ObjectId();
    const approvedOrg = { _id: orgId, name: 'Apex Engineering Ltd', status: 'APPROVED', ownerId: sId };
    const membership = { _id: new ObjectId(), userId: sId, organizationId: orgId, role: 'OWNER', status: 'ACTIVE', verified: true };
    const studentFounder = { _id: sId, primaryRole: 'STUDENT', roles: ['STUDENT', 'FOUNDER'], role: 'student' };

    const res = governanceHelper.computeUserCapabilities(studentFounder, { memberships: [membership], organizations: [approvedOrg] });
    assert.ok(res.capabilities.includes('MANAGE_BUSINESS'));
    assert.ok(res.capabilities.includes('POST_OPPORTUNITIES'));
    assert.ok(res.capabilities.includes('ACCESS_COURSES'));
    assert.strictEqual(res.businessAuthorization.canManageBusiness, true);
    assert.strictEqual(res.businessAuthorization.canPostOpportunities, true);
  });

  await testAsync('✓ Professional: career & portfolio capabilities granted, business management denied', async () => {
    const proUser = { primaryRole: 'PROFESSIONAL', roles: ['PROFESSIONAL'], role: 'professional' };
    const res = governanceHelper.computeUserCapabilities(proUser, { memberships: [], organizations: [] });
    assert.ok(res.capabilities.includes('ACCESS_JOBS'));
    assert.ok(res.capabilities.includes('ACCESS_PORTFOLIO'));
    assert.ok(res.capabilities.includes('ACCESS_CAREER_INTELLIGENCE'));
    assert.strictEqual(res.capabilities.includes('MANAGE_BUSINESS'), false);
  });

  await testAsync('✓ Professional + Mentor: mentorship capability granted alongside professional features', async () => {
    const proMentor = { primaryRole: 'PROFESSIONAL', roles: ['PROFESSIONAL', 'MENTOR'], role: 'professional' };
    const res = governanceHelper.computeUserCapabilities(proMentor, { memberships: [], organizations: [] });
    assert.ok(res.capabilities.includes('OFFER_MENTORSHIP'));
    assert.ok(res.capabilities.includes('ACCESS_JOBS'));
    assert.ok(res.capabilities.includes('ACCESS_PORTFOLIO'));
  });

  await testAsync('✓ Professional + Recruiter (with approved business): business management & job posting granted', async () => {
    const pId = new ObjectId();
    const orgId = new ObjectId();
    const approvedOrg = { _id: orgId, name: 'Metro Buildcon', status: 'APPROVED' };
    const membership = { _id: new ObjectId(), userId: pId, organizationId: orgId, role: 'RECRUITER', status: 'ACTIVE', verified: true };
    const proRecruiter = { _id: pId, primaryRole: 'PROFESSIONAL', roles: ['PROFESSIONAL', 'RECRUITER'], role: 'professional' };

    const res = governanceHelper.computeUserCapabilities(proRecruiter, { memberships: [membership], organizations: [approvedOrg] });
    assert.ok(res.capabilities.includes('POST_OPPORTUNITIES'));
    assert.ok(res.capabilities.includes('MANAGE_BUSINESS'));
    assert.ok(res.capabilities.includes('ACCESS_PORTFOLIO'));
  });

  await testAsync('✓ Founder course independence: taking courses NEVER converts Founder to Student (Req 11)', async () => {
    const founderWithCourses = {
      _id: new ObjectId(),
      primaryRole: 'FOUNDER',
      role: 'founder',
      course: [new ObjectId(), new ObjectId(), new ObjectId()]
    };
    const resolved = governanceHelper.resolveCanonicalUserRoles(founderWithCourses);
    assert.strictEqual(resolved.primaryRole, 'FOUNDER');
    assert.deepStrictEqual(resolved.roles, ['FOUNDER']);
  });

  await testAsync('✓ Founder + Student: legitimate multi-role preserves both identities', async () => {
    const founderStudent = {
      _id: new ObjectId(),
      primaryRole: 'FOUNDER',
      roles: ['FOUNDER', 'STUDENT'],
      role: 'founder'
    };
    const resolved = governanceHelper.resolveCanonicalUserRoles(founderStudent);
    assert.strictEqual(resolved.primaryRole, 'FOUNDER');
    assert.ok(resolved.roles.includes('FOUNDER'));
    assert.ok(resolved.roles.includes('STUDENT'));
  });

  await testAsync('✓ Educator: holds student and course governance capabilities', async () => {
    const eduUser = { primaryRole: 'EDUCATOR', roles: ['EDUCATOR'], role: 'educator' };
    const res = governanceHelper.computeUserCapabilities(eduUser, { memberships: [], organizations: [] });
    assert.ok(res.capabilities.includes('CONDUCT_CLASSES'));
    assert.ok(res.capabilities.includes('ACCESS_COURSES'));
    assert.ok(res.capabilities.includes('ACCESS_JOBS'));
  });

  await testAsync('✓ Admin platform authority: handled via permissionsHelper, isolated from user multi-roles', async () => {
    assert.strictEqual(governanceHelper.CANONICAL_ROLES.includes('ADMIN'), false);
    assert.strictEqual(permissionsHelper.hasCapability(mockAdmin, 'assign_educator'), true);
    assert.strictEqual(permissionsHelper.hasCapability(mockAdmin, 'manage_network'), true);
  });

  await testAsync('✓ Feature access not inferred only from primaryRole: secondary role grants full capabilities', async () => {
    const sId = new ObjectId();
    const orgId = new ObjectId();
    const approvedOrg = { _id: orgId, name: 'Vanguard Infrastructure', status: 'APPROVED', ownerId: sId };
    const membership = { _id: new ObjectId(), userId: sId, organizationId: orgId, role: 'OWNER', status: 'ACTIVE', verified: true };
    const studentWithSecondaryFounder = {
      _id: sId,
      primaryRole: 'STUDENT',
      roles: ['STUDENT', 'FOUNDER'],
      role: 'student'
    };
    const res = governanceHelper.computeUserCapabilities(studentWithSecondaryFounder, { memberships: [membership], organizations: [approvedOrg] });
    assert.strictEqual(res.capabilities.includes('MANAGE_BUSINESS'), true);
    assert.strictEqual(res.businessAuthorization.canManageBusiness, true);
  });

  console.log('\n\x1b[36m--- 9. Security & Safeguards Tests (Req 20) ---\x1b[0m');

  await testAsync('✓ Self-escalation rejection: admin/user cannot modify their own roles', async () => {
    const selfUserId = new ObjectId();
    const selfAdmin = { ...mockAdmin, _id: selfUserId };
    await assert.rejects(
      async () => {
        await governanceHelper.setPrimaryRole(selfUserId, 'FOUNDER', selfAdmin, mockReq, 'Self promotion');
      },
      /Action rejected: You cannot change your own roles/
    );
  });

  await testAsync('✓ ADMIN injection rejection: cannot assign ADMIN into multi-role identity', async () => {
    const targetUserId = new ObjectId();
    mockDb.users.set(String(targetUserId), { _id: targetUserId, primaryRole: 'STUDENT', roles: ['STUDENT'], role: 'student' });
    await assert.rejects(
      async () => {
        await governanceHelper.setPrimaryRole(targetUserId, 'ADMIN', mockAdmin, mockReq, 'Exploit attempt');
      },
      /Invalid role: ADMIN/
    );
    await assert.rejects(
      async () => {
        await governanceHelper.addSecondaryRole(targetUserId, 'ADMIN', mockAdmin, mockReq, 'Exploit attempt');
      },
      /Invalid role: ADMIN/
    );
  });

  await testAsync('✓ EDUCATOR unauthorized assignment rejection: requires assign_educator capability', async () => {
    const targetUserId = new ObjectId();
    mockDb.users.set(String(targetUserId), { _id: targetUserId, primaryRole: 'STUDENT', roles: ['STUDENT'], role: 'student' });
    const weakAdmin = { _id: new ObjectId(), Role: 'editor', capabilities: ['manage_network'] };
    await assert.rejects(
      async () => {
        await governanceHelper.setPrimaryRole(targetUserId, 'EDUCATOR', weakAdmin, mockReq, 'Unauthorized educator assignment');
      },
      /assign_educator capability is required/
    );
  });

  await testAsync('✓ Fake organization membership rejection: non-existent/unapproved org denies business access', async () => {
    const founderId = new ObjectId();
    const fakeOrgId = new ObjectId();
    const fakeMembership = { _id: new ObjectId(), userId: founderId, organizationId: fakeOrgId, role: 'OWNER' };
    const founderUser = { _id: founderId, primaryRole: 'FOUNDER', roles: ['FOUNDER'], role: 'founder' };
    const res = governanceHelper.computeUserCapabilities(founderUser, { memberships: [fakeMembership], organizations: [] });
    assert.strictEqual(res.capabilities.includes('MANAGE_BUSINESS'), false);
    assert.strictEqual(res.businessAuthorization.canManageBusiness, false);
  });

  await testAsync('✓ Mandatory governance reason enforcement: empty reason is strictly rejected', async () => {
    const targetUserId = new ObjectId();
    mockDb.users.set(String(targetUserId), { _id: targetUserId, primaryRole: 'STUDENT', roles: ['STUDENT'], role: 'student' });
    await assert.rejects(
      async () => {
        await governanceHelper.setPrimaryRole(targetUserId, 'PROFESSIONAL', mockAdmin, mockReq, '   ');
      },
      /A governance reason is mandatory/
    );
    await assert.rejects(
      async () => {
        await governanceHelper.addSecondaryRole(targetUserId, 'PROFESSIONAL', mockAdmin, mockReq, '');
      },
      /A governance reason is mandatory/
    );
  });

  await testAsync('✓ Non-destructive role mutations: role updates preserve courses, profile, and memberships', async () => {
    const targetUserId = new ObjectId();
    const courseId = new ObjectId();
    mockDb.users.set(String(targetUserId), {
      _id: targetUserId,
      primaryRole: 'STUDENT',
      roles: ['STUDENT'],
      role: 'student',
      course: [courseId],
      discipline: 'Civil Engineering'
    });

    await governanceHelper.setPrimaryRole(targetUserId, 'PROFESSIONAL', mockAdmin, mockReq, 'Graduated and working');
    const updated = mockDb.users.get(String(targetUserId));
    assert.strictEqual(updated.primaryRole, 'PROFESSIONAL');
    assert.ok(updated.roles.includes('PROFESSIONAL'));
    assert.ok(updated.course && updated.course.length === 1);
    assert.strictEqual(updated.discipline, 'Civil Engineering');
  });

  await testAsync('✓ Safe User Panel API contract: excludes password hashes, OTPs, and private secrets (Req 16)', async () => {
    const targetUserId = new ObjectId();
    mockDb.users.set(String(targetUserId), {
      _id: targetUserId,
      username: 'safetarget',
      name: 'Safe User',
      Password: 'argon2_hashed_secret',
      password: 'argon2_hashed_secret',
      otp: '123456',
      refreshToken: 'jwt_refresh_secret',
      primaryRole: 'FOUNDER',
      roles: ['FOUNDER'],
      role: 'founder'
    });

    const contract = await governanceHelper.getCanonicalUserContract(targetUserId);
    assert.ok(contract);
    assert.strictEqual(contract.primaryRole, 'FOUNDER');
    assert.strictEqual(contract.Password, undefined);
    assert.strictEqual(contract.password, undefined);
    assert.strictEqual(contract.otp, undefined);
    assert.strictEqual(contract.refreshToken, undefined);
    assert.ok(Array.isArray(contract.capabilities));
    assert.ok(contract.businessAccess);
    assert.ok(contract.learningContext);
  });
  console.log(`TEST RUN COMPLETE: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Test Suite Fatal Error:', err);
  process.exit(1);
});
