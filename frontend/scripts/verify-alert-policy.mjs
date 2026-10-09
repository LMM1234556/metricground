import assert from 'node:assert/strict';
import { evaluateAlertTransition, initialAlertState } from './lib/alert-policy.mjs';

const healthy = {
  monitorSucceeded: true,
  siteStatus: 'active',
  liveUrlPresent: true,
  workerErrors: [],
};

const steps = [];
let state = initialAlertState();

function apply(name, observation, expectedNotification) {
  const result = evaluateAlertTransition(state, observation);
  assert.equal(result.notification?.type ?? null, expectedNotification?.type ?? null, `${name}: notification type`);
  assert.equal(result.notification?.severity ?? null, expectedNotification?.severity ?? null, `${name}: severity`);
  assert.equal(result.notification?.reason ?? null, expectedNotification?.reason ?? null, `${name}: reason`);
  state = result.state;
  steps.push({ name, phase: state.phase, notification: result.notification?.type ?? 'silent' });
}

apply('healthy baseline stays silent', healthy, null);
apply('first monitor failure stays silent', { monitorSucceeded: false }, null);
apply('second monitor failure opens P1', { monitorSucceeded: false }, {
  type: 'failure', severity: 'P1', reason: 'monitor_failed_twice',
});
apply('repeated monitor failure is deduplicated', { monitorSucceeded: false }, null);
apply('monitor recovery sends one recovery', healthy, {
  type: 'recovery', severity: 'P1', reason: 'site_healthy_no_active_errors',
});
apply('new worker error opens P2', { ...healthy, workerErrors: [{ requestId: 'req-1', route: '/api/agent/plan' }] }, {
  type: 'failure', severity: 'P2', reason: 'worker_error',
});
apply('same worker error is deduplicated', { ...healthy, workerErrors: [{ requestId: 'req-1', route: '/api/agent/plan' }] }, null);
apply('new error during incident sends update', { ...healthy, workerErrors: [
  { requestId: 'req-1', route: '/api/agent/plan' },
  { requestId: 'req-2', route: '/api/task-runs' },
] }, { type: 'failure_update', severity: 'P2', reason: 'worker_error' });
apply('empty error window sends one recovery', healthy, {
  type: 'recovery', severity: 'P2', reason: 'site_healthy_no_active_errors',
});
apply('repeated healthy observation stays silent', healthy, null);
apply('missing live URL opens P1', { ...healthy, liveUrlPresent: false }, {
  type: 'failure', severity: 'P1', reason: 'site_unavailable',
});
apply('site recovery sends one recovery', healthy, {
  type: 'recovery', severity: 'P1', reason: 'site_healthy_no_active_errors',
});

assert.deepEqual(state, initialAlertState(), 'drill must finish in the healthy baseline state');

console.log(JSON.stringify({
  checksPassed: true,
  scenarioCount: steps.length,
  notificationCount: steps.filter((step) => step.notification !== 'silent').length,
  finalPhase: state.phase,
  steps,
}, null, 2));
