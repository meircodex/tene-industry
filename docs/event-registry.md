# Event Registry

Source-of-truth registry required by Volume 10. Current realtime events are sent
through `wsBroadcast(type, data)` from `realtime/ws.js`; audit events are separately
written through `auditLog(...)`. The spec requires these concepts to converge
into a universal event/audit model.

## Current Realtime Event Types

| Event Type | Owner Module | Current Producer Context | Notes |
| --- | --- | --- | --- |
| `machines_state` | Production | WebSocket connection initial state | Snapshot, not business event. |
| `machine_update` | Production | Modbus/machine update, maintenance fault | Needs event contract. |
| `machine_assign` | Production | Machine assignment routes | Should audit operator/user and reason. |
| `machine_complete` | Production | Machine complete route | Should tie to item/order/worker/shift. |
| `machine_state` | Production | Machine state route | Needs state machine audit. |
| `end_of_day` | Production | Machine end of day | Shift/day lifecycle event. |
| `order_complete` | Orders / Production | Order completion helper | Should be formal order lifecycle event. |
| `new_order` | Orders | Order creation/import/portal/BVBS | Multiple producers; needs source/channel field. |
| `order_status` | Orders | Status approval/update routes | Must be audited and state-machine checked. |
| `item_status` | Orders / Production | Item status route and transactional order rollback | Order rollback emits each corrected item only after the transaction commits. |
| `alert` | Platform Core | Alert routes/helper | Should also become persisted alert/event. |
| `driver_location` | Delivery | Driver location update | External portal auth needed. |
| `delivery_depart` | Delivery | Delivery depart route | Delivery state machine. |
| `delivery_confirm` | Delivery | Delivery confirm route | Delivery state machine. |
| `new_intake` | Orders | WhatsApp intake | External source, unsafe content. |
| `new_intake_email` | Orders | `jobs/scheduler.js` email polling | External source, unsafe content. |
| `new_invoice` | Finance | Invoice creation | Sensitive financial event. |
| `cost_update` | Finance | Cost recalculation | Sensitive financial event. |

## Current Audit Actions Seen

| Audit Action | Owner Module | Notes |
| --- | --- | --- |
| `status_change` | Orders | Used for order status changes. |
| `lock` | Orders | Order lock after shipment. |
| `unlock` | Orders | Unlock action. |


## Planned V2 Event Types

| Event Type | Owner Module | Producer | Consumers | Required Payload |
| --- | --- | --- | --- | --- |
| `production.card.created` | Production Cards | Card generation from approved order | Production, Reports | `eventId`, `orderId`, `cardId`, `itemId`, `quantity`, `targetWeightKg`, `createdAt` |
| `production.card.started` | Production Cards | Worker station start action | Production, Orders | `eventId`, `cardId`, `orderId`, `workerId`, `stationId`, `startedAt` |
| `production.card.completed` | Production Cards | Worker station complete action | Orders, Reports | `eventId`, `cardId`, `orderId`, `workerId`, `quantityDone`, `completedAt` |
| `production.card.reprinted` | Production Cards | Manager reprint action | Orders, Audit | `eventId`, `orderId`, `cardIds`, `reason`, `actorUserId`, `createdAt` |
| `production.card.weightCaptured` | Production Cards | Weight entry or scale integration | Reports, Quality | `eventId`, `cardId`, `targetWeightKg`, `actualWeightKg`, `capturedAt`, `device` |
| `production.card.weightDeviation` | Production Cards | Weight tolerance check | Alerts, Quality, Manager | `eventId`, `cardId`, `targetWeightKg`, `actualWeightKg`, `deviationPct`, `thresholdPct`, `requiresApproval` |

### Intake/OCR Events

| Event Type | Owner Module | Producer | Consumers | Required Payload |
| --- | --- | --- | --- | --- |
| `intake.source.received` | Intake/OCR | Document upload / WhatsApp / email / CSV import | Dashboard, Audit | `eventId`, `sourceId`, `sourceChannel`, `sourceHash`, `receivedAt`, `actorUserId` |
| `intake.parse.started` | Intake/OCR | User action or background worker | UI realtime, Audit | `eventId`, `sourceId`, `draftId`, `parserType`, `startedAt`, `actorUserId` |
| `intake.parse.completed` | Intake/OCR | OCR/parser worker | UI realtime, Orders draft queue | `eventId`, `sourceId`, `draftId`, `itemCount`, `confidenceSummary`, `completedAt` |
| `intake.review.required` | Intake/OCR | OCR/parser validation | UI, Manager alerts | `eventId`, `sourceId`, `draftId`, `reviewItemId`, `field`, `reason`, `confidence`, `createdAt` |
| `intake.item.corrected` | Intake/OCR | User correction | OCR Training, Audit | `eventId`, `sourceId`, `draftId`, `itemId`, `field`, `oldValue`, `newValue`, `actorUserId`, `createdAt` |
| `intake.duplicate.detected` | Intake/OCR | Duplicate check | UI, Audit | `eventId`, `sourceId`, `draftId`, `matchedSourceId`, `matchReason`, `confidence`, `createdAt` |
| `intake.draft.approved` | Intake/OCR | Human approval | Orders, Audit | `eventId`, `sourceId`, `draftId`, `approvedBy`, `approvedAt`, `orderDraftPayload` |
| `intake.draft.rejected` | Intake/OCR | Human rejection | Audit | `eventId`, `sourceId`, `draftId`, `rejectedBy`, `reason`, `createdAt` |
| `intake.priceListImport.analyzed` | Intake/OCR + Pricing | Pricing OCR upload analysis | Pricing, Audit | `eventId`, `sourceId`, `requestedByModule`, `requestedUseCase`, `targetModule`, `draftItemCount`, `confidenceSummary`, `createdAt` |
| `intake.training.example.created` | Intake/OCR Training | User-approved correction | OCR Training | `eventId`, `sourceId`, `draftId`, `correctionId`, `customerId`, `formatHint`, `createdAt` |
## Required Event Contract

Every important event should eventually include:

- `eventId`
- `eventType`
- `module`
- `entityType`
- `entityId`
- `entityRef`
- `actorUserId`
- `actorRole`
- `source`
- `device`
- `oldValue`
- `newValue`
- `reasonCode`
- `createdAt`
- `result`
- `kpiImpact`

## Recovery Decisions

1. Keep `wsBroadcast` for realtime transport, but stop treating it as the event
   system.
2. Define a persisted event table or extend `audit_log` before broad module
   refactors.
3. Every status/state transition must create both a persisted event and a
   realtime notification when relevant.
4. External-source events must preserve raw source and sanitized display value.
5. AI events stay frozen until governance fields are available.
