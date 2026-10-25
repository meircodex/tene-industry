(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.IronBendDataContracts = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const WIDGET_CONTRACTS = Object.freeze({
    shapeSideDimensions: {
      screen: 'orders.html', owner: 'Production Cards',
      source: { api: '/api/orders/:id', fields: ['pallets[].items[].shape_svg', 'pallets[].items[].segments'] },
      meaning: 'Canonical side lengths are displayed in centimeters, centered on the outward perpendicular through their own side midpoint. Collision avoidance moves labels outward, never along the side or to a different corner. Rendering does not change stored geometry.',
      consumers: ['item-visual', 'production-card', 'shape-editor'], risk: 'D0',
    },
    orderItemFilters: {
      screen: 'orders.html', owner: 'Orders',
      source: { api: '/api/orders/:id', fields: ['pallets[].items[].id', 'pallets[].items[].diameter', 'pallets[].items[].status', 'pallets[].items[].cancelled_at'] },
      meaning: 'Diameter and status intersect to filter item rows. Diameter summary counts active rows: done/loaded/sent/delivered are completed, other active rows remain to produce; cancelled rows are separate. Counts never sum piece quantities. Filters preserve original row numbers, documents and order totals.',
      consumers: ['detailItemDiameterFilter', 'detailItemStatusFilter', 'detailItemProductionSummary', 'detailItemFilterCount'], risk: 'D0',
    },
    orderItemSummary: {
      screen: 'orders.html', owner: 'Orders',
      source: { api: '/api/orders', fields: ['status', 'delivery_progress.production_status', 'delivery_progress.total_item_count', 'delivery_progress.shipped_item_count', 'delivery_progress.partially_shipped_item_count'] },
      meaning: 'Order notes and delivery badge count item rows, never pieces or produced quantities. Fully and partially shipped rows are separate. Partial delivery is derived shipment information, not a selectable work status; existing partial orders display their projected production stage.',
      consumers: ['order-notes', 'order-status-select', 'deliveryProgressBadge'], risk: 'D0',
    },
    workerLoadingStatus: {
      screen: 'worker-visual.html', owner: 'Production',
      source: { api: '/api/worker-card/:id/status', fields: ['item.status', 'item.order_status', 'receipt'] },
      meaning: 'Phone work actions are waiting, production, done and loaded. Loaded is an item state eligible for delivery certificate issue, never confirmation of customer delivery. Backward corrections reconcile the order while keeping shipment documents and production quantities.',
      consumers: ['worker-status-actions', 'worker-status-pill'], risk: 'D1',
    },
    orderStatusCorrection: {
      screen: 'orders.html',
      owner: 'Orders',
      source: { api: '/api/orders/:id/status-correction-preview', fields: ['current_status', 'target_status', 'affected_items', 'cancelled_loading_session_ids', 'certificates', 'can_cancel_certificates', 'fingerprint'] },
      meaning: 'Returning an order caps advanced active item stages in one transaction. Counts, payment and history remain. Active loading is cancelled with its scan history retained. Certificate cancellation is an explicit optional choice.',
      consumers: ['correctionReasonInfo', 'correctionShipmentEffect'],
      risk: 'D1',
    },
    itemStatusCorrection: {
      screen: 'orders.html',
      owner: 'Production',
      source: { api: '/api/items/:id/status-correction-preview', fields: ['current_status', 'target_status', 'documented_qty', 'certificates', 'can_cancel_certificates', 'fingerprint'] },
      meaning: 'Correction preview separates work status from documented shipment quantities. Unshipped certificate cancellation is explicit and applies to every item on the complete document. Production quantities and inventory history remain unchanged.',
      consumers: ['correctionShipmentEffect'],
      risk: 'D3',
    },
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
