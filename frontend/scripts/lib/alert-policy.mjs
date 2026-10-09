const HEALTHY = 'healthy';
const DEGRADED = 'degraded';

export function initialAlertState() {
  return {
    phase: HEALTHY,
    consecutiveMonitorFailures: 0,
    activeErrorKeys: [],
    incidentSeverity: null,
  };
}

function errorKey(error) {
  return String(error.requestId ?? error.traceId ?? error.id ?? `${error.route ?? 'unknown'}:${error.timestamp ?? 'unknown'}`);
}

export function evaluateAlertTransition(previous, observation) {
  const state = previous ?? initialAlertState();

  if (!observation.monitorSucceeded) {
    const consecutiveMonitorFailures = state.consecutiveMonitorFailures + 1;
    const becomesIncident = consecutiveMonitorFailures >= 2 && state.phase !== DEGRADED;

    return {
      state: {
        ...state,
        phase: becomesIncident ? DEGRADED : state.phase,
        incidentSeverity: becomesIncident ? 'P1' : state.incidentSeverity,
        consecutiveMonitorFailures,
      },
      notification: becomesIncident
        ? { type: 'failure', severity: 'P1', reason: 'monitor_failed_twice' }
        : null,
    };
  }

  const activeErrorKeys = (observation.workerErrors ?? []).map(errorKey).sort();
  const previousKeys = new Set(state.activeErrorKeys);
  const newErrorKeys = activeErrorKeys.filter((key) => !previousKeys.has(key));
  const siteUnavailable = observation.siteStatus !== 'active' || !observation.liveUrlPresent;

  if (siteUnavailable) {
    const shouldNotify = state.phase !== DEGRADED || state.incidentSeverity !== 'P1';
    return {
      state: {
        phase: DEGRADED,
        consecutiveMonitorFailures: 0,
        activeErrorKeys,
        incidentSeverity: 'P1',
      },
      notification: shouldNotify
        ? { type: state.phase === DEGRADED ? 'failure_update' : 'failure', severity: 'P1', reason: 'site_unavailable' }
        : null,
    };
  }

  if (activeErrorKeys.length > 0) {
    const shouldNotify = state.phase !== DEGRADED || newErrorKeys.length > 0;
    return {
      state: {
        phase: DEGRADED,
        consecutiveMonitorFailures: 0,
        activeErrorKeys,
        incidentSeverity: state.incidentSeverity === 'P1' ? 'P1' : 'P2',
      },
      notification: shouldNotify
        ? {
            type: state.phase === DEGRADED ? 'failure_update' : 'failure',
            severity: 'P2',
            reason: 'worker_error',
            newErrorKeys,
          }
        : null,
    };
  }

  const recovered = state.phase === DEGRADED;
  return {
    state: initialAlertState(),
    notification: recovered
      ? { type: 'recovery', severity: state.incidentSeverity, reason: 'site_healthy_no_active_errors' }
      : null,
  };
}
