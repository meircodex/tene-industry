(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.IronBendDataContracts = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const WIDGET_CONTRACTS = Object.freeze({
    inventoryPurchaseDraft: {
      screen:'inventory.html',owner:'Procurement',
      source:{api:'/api/procurement/plan',fields:['groups.recommended_purchase_kg','purchase_policy.basis','purchase_policy.types.recommended_order_kg']},
      meaning:'Exact shortage kg drives editable supplier roll/bundle counts. Default basis is available stock; physical stock is optional. Min stock 10000 kg, target 30000 kg and minimum supplier order 30000 kg are evaluated separately for coils and straight stock. Other diameters of the same type may fill the minimum; operator must choose them. Length is separate from specification. Export recomputes estimated kg and enforces type/minimum/length; no business data is written.',
      consumers:['purchaseDraftRows','purchaseTotals','inventoryStockBasisSelect'],risk:'D0',
    },
    shapeCatalogueBilling: {
      screen: 'shape-editor.js', owner: 'Orders',
      source: { api: '/api/shape-definitions', fields: ['entries[].itemCode', 'entries[].version', 'entries[].definition', 'entries[].billingPolicy', 'permissions.canManage'] },
      meaning: 'Only the arrow opens a floating catalogue. Numeric SKUs are separate from internal IDs. Thumbnails use template geometry; overlapping sides keep source coordinates and separate labels. Fixed templates retain topology while lengths remain proportional. Managers/admins explicitly edit a versioned catalogue definition. Billing policy and catalogue identity/version are copied into each approved order snapshot. Material kg is counted once; cutting/bending use that kg basis and product add-ons use item quantity. Existing snapshots are not reclassified when the catalogue changes.',
      consumers: ['seItemCode', 'seCatalogPopup', 'seEditCatalogShape', 'seBillingBasis', 'data-overlap-segment', 'data-overlap-span', 'data-overlap-leader', 'order-commercial-summary', 'delivery-certificate'], risk: 'D2',
    },
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
    inventoryDaily: {
      screen: 'inventory.html', owner: 'Inventory',
      source: {api:'/api/procurement/plan',fields:['groups.physical_stock_kg','groups.backlog_kg','groups.incoming_kg','groups.recommended_purchase_kg','mesh_groups.physical_units','mesh_groups.required_units','mesh_groups.recommended_purchase_units']},
      meaning:'Planning by diameter and supply form; kg values display rounded to whole kilograms without changing source precision; sheets remain separate whole units. Recommendations do not place purchase orders. Bar grade, standard and length require review.',
      consumers:['inventoryDailyRows'],risk:'D1',
    },
    inventoryPhysicalTotal: {
      screen:'inventory.html',owner:'Inventory',source:{api:'/api/inventory/summary',fields:['available','total_adjustments']},
      meaning:'Recorded approved bar stock balance in kg, including audited count adjustments. Depends on count accuracy and recorded movements; unreported consumption is not known. Excludes sheet units and does not subtract order reservations.',consumers:['kpiTotal'],risk:'D1',
    },
    inventoryStockBasis: {
      screen:'inventory.html',owner:'Inventory',source:{api:'/api/inventory/summary',fields:['available','diameter']},
      meaning:'The user-approved count is the opening stock basis. Current stock follows approved receipts minus recorded consumption and scrap, with audited count adjustments. Reservations are separate demand and not physical removal. Positive-balance groups define the diameter count. Latest stocktake approval from /api/inventory/stocktakes supplies the displayed basis date. Historic usage and uncertain consumption diagnostics are not displayed on the main inventory screen.',
      consumers:['inventoryStockBasis','kpiDiam'],risk:'D0',
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
