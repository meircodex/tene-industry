(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.IronBendDataContracts = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const WIDGET_CONTRACTS = Object.freeze({
    intakeRecognitionConfidence: {
      screen: 'intake.html',
      owner: 'Intake / AI',
      source: { api: '/api/intake/log', fields: ['parsed_data.items[].field_confidence', 'parsed_data.items[].fields', 'parsed_data.confidence'] },
      meaning: 'Only source-provided numeric recognition confidence. Missing scores are unknown, never a default percentage. Row score is the minimum of diameter, length, quantity and shape, only when all four are available. Operator approval is a separate state.',
      consumers: ['ocrItemConfidenceCell', 'confidenceDisplay'],
      risk: 'D1',
    },
    kpiOrdersToday: {
      screen: 'dashboard.html',
      owner: 'Dashboard / Orders',
      source: { api: '/api/dashboard', fields: ['ordersToday'] },
      meaning: 'Orders created today. This is not production output.',
      consumers: ['kpiOrdersToday'],
      risk: 'D0',
    },
    kpiWeightToday: {
      screen: 'dashboard.html',
      owner: 'Dashboard / Production',
      source: { api: '/api/dashboard', fields: ['producedWeightToday'] },
      meaning: 'Production output today in kg: measured weight when recorded; otherwise the saved theoretical weight of a completed item, exposed separately as an estimate.',
      consumers: ['kpiWeightToday', 'qsWeight'],
      risk: 'D1',
    },
    kpiInProd: {
      screen: 'dashboard.html',
      owner: 'Dashboard / Production',
      source: { api: '/api/dashboard', fields: ['inProduction', 'itemsInProduction'] },
      meaning: 'Orders and items currently in production.',
      consumers: ['kpiInProd', 'kpiItemsProd'],
      risk: 'D1',
    },
    kpiDone: {
      screen: 'dashboard.html',
      owner: 'Dashboard / Production',
      source: { api: '/api/dashboard', fields: ['completedToday', 'itemsDone'] },
      meaning: 'Production items completed today. This is not order-created count.',
      consumers: ['kpiDone', 'kpiItemsDone', 'kpiDoneBar'],
      risk: 'D1',
    },
    kpiUrgent: {
      screen: 'dashboard.html',
      owner: 'Dashboard / Orders',
      source: { api: '/api/dashboard', fields: ['urgentOpen'] },
      meaning: 'Open urgent orders.',
      consumers: ['kpiUrgent', 'urgentBadge', 'urgentCount'],
      risk: 'D0',
    },
    kpiWaste: {
      screen: 'dashboard.html',
      owner: 'Dashboard / Production',
      source: { api: '/api/dashboard', fields: ['wasteAvgPct', 'wasteByMachine'] },
      meaning: 'Average waste percentage from completed production items today.',
      consumers: ['kpiWaste', 'kpiWasteBar', 'qsWasteA', 'qsWasteB', 'qsWasteC', 'qsWasteD'],
      risk: 'D1',
    },
    kpiPending: {
      screen: 'dashboard.html',
      owner: 'Dashboard / Orders',
      source: { api: '/api/dashboard', fields: ['pending'] },
      meaning: 'Orders waiting for internal approval.',
      consumers: ['kpiPending'],
      risk: 'D0',
    },
    kpiTonsToday: {
      screen: 'dashboard.html',
      owner: 'Dashboard / Production',
      source: { api: '/api/dashboard', fields: ['producedTonsToday'] },
      meaning: 'Production tons reported today. Measured weight takes priority; a completed item without a measurement uses its saved theoretical weight as an explicit estimate. Must match producedWeightToday / 1000.',
      consumers: ['kpiTonsToday'],
      risk: 'D1',
    },
  });

  function contractTitle(id, contract) {
    return [
      `Data contract: ${id}`,
      `Owner: ${contract.owner}`,
      `Source: ${contract.source.api}`,
      `Fields: ${contract.source.fields.join(', ')}`,
      `Meaning: ${contract.meaning}`,
    ].join('\n');
  }

  function applyDataContracts(doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) return;
    Object.entries(WIDGET_CONTRACTS).forEach(([id, contract]) => {
      contract.consumers.forEach(elementId => {
        const el = documentRef.getElementById(elementId);
        if (!el) return;
        el.dataset.contractId = id;
        el.dataset.sourceApi = contract.source.api;
        el.dataset.sourceFields = contract.source.fields.join(',');
        el.title = contractTitle(id, contract);
      });
    });
  }

  return { WIDGET_CONTRACTS, applyDataContracts };
});
