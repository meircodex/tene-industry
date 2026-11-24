'use strict';
/*
  Local screenshot fixture only.
  This file is not required by server.js and does not open or write a database.
  Do not import it from production code.
*/
const TODAY = '2026-11-24';
const customers = [
  { id: 1, name: 'אקרשטיין', phone: '03-6102200', email: 'orders@ekerstein.co.il', address: 'ראשון לציון', contact_name: 'יוסי אקרשטיין', order_count: 2, total_weight_sum: 6120, balance: 18400, credit_limit: 250000 },
  { id: 2, name: 'דניה סיבוס', phone: '04-8501000', email: 'site@danya.co.il', address: 'חיפה', contact_name: 'מיכל דן', order_count: 1, total_weight_sum: 2860, balance: 0, credit_limit: 180000 },
  { id: 3, name: 'אלקטרה בנייה', phone: '03-5642222', email: 'rebar@electra.co.il', address: 'אור יהודה', contact_name: 'רון לוי', order_count: 1, total_weight_sum: 1540, balance: 6200, credit_limit: 120000 },
];
const orders = [
  { id: 1042, order_num: 'TB-1042', customer_id: 1, customer_name: 'אקרשטיין', delivery_date: TODAY, delivery_address: 'מתחם האלף, ראשון לציון', site_name: 'מגדל A', status: 'בייצור', priority: 'דחוף', total_weight: 4280, billing_weight: 4280, created_at: '2026-11-22T08:10:00' },
  { id: 1048, order_num: 'TB-1048', customer_id: 2, customer_name: 'דניה סיבוס', delivery_date: TODAY, delivery_address: 'נמל המפרץ, חיפה', site_name: 'מזח 4', status: 'בתור ייצור', priority: 'רגיל', total_weight: 2860, billing_weight: 2860, created_at: '2026-11-22T11:40:00' },
  { id: 1051, order_num: 'TB-1051', customer_id: 3, customer_name: 'אלקטרה בנייה', delivery_date: '2026-11-25', delivery_address: 'שדרות ההסתדרות 12, אור יהודה', site_name: 'חניון תת־קרקעי', status: 'ממתינה לאישור', priority: 'רגיל', total_weight: 1540, billing_weight: 1540, created_at: '2026-11-23T07:05:00' },
];
const machines = [
  { id: 1, name: 'כיפוף 1', label: 'כיפוף 1', status: 'בייצור', connected: 1 },
  { id: 2, name: 'כיפוף 2', label: 'כיפוף 2', status: 'פנוי', connected: 1 },
  { id: 3, name: 'גזירה', label: 'גזירה', status: 'פנוי', connected: 1 },
  { id: 4, name: 'רשת', label: 'רשת', status: 'תקלה', connected: 0 },
];
const queueItems = [
  { id: 501, order_id: 1042, order_num: 'TB-1042', customer_id: 1, customer_name: 'אקרשטיין', diameter: 12, quantity: 240, produced_qty: 80, weight: 860, status: 'בייצור', priority: 'דחוף', machine: 'כיפוף 1', total_length_mm: 2400 },
  { id: 502, order_id: 1042, order_num: 'TB-1042', customer_id: 1, customer_name: 'אקרשטיין', diameter: 16, quantity: 96, produced_qty: 0, weight: 1420, status: 'בתור ייצור', priority: 'דחוף', machine: 'כיפוף 2', total_length_mm: 3200 },
  { id: 503, order_id: 1048, order_num: 'TB-1048', customer_id: 2, customer_name: 'דניה סיבוס', diameter: 10, quantity: 180, produced_qty: 0, weight: 640, status: 'בתור ייצור', priority: 'רגיל', machine: '', total_length_mm: 1800 },
];
const shape = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><line x1="8" y1="20" x2="112" y2="20" stroke="#1A2330" stroke-width="3"/></svg>';
queueItems.forEach(item => { item.shape_svg = shape; });

function demoBody(url) {
  const path = url.split('?')[0];
  const query = new URLSearchParams(url.split('?')[1] || '');
  if (path.endsWith('/api/access/me')) {
    return { role: 'admin', screens: ['dashboard','orders','new-order','intake','customers','production-queue','inventory','procurement','warehouse','machine','quality','reports','finance','pricing','admin','projects','maintenance','support','bugs','scanner','kiosk'].map(id => ({ id })) };
  }
  if (path.endsWith('/api/license/modules')) return { restricted: false, modules: [] };
  if (path.endsWith('/api/search')) return { results: [] };
  if (path.endsWith('/api/dashboard')) {
    return {
      ordersToday: 3, completedToday: 42, inProduction: 1, pending: 1, portalAwaitingCustomerApproval: 0,
      urgentOpen: 1, totalWeightToday: 8680, producedWeightToday: 18400, producedTonsToday: 18.4,
      itemsInProduction: 4, itemsDone: 42, wasteAvgPct: '2.1', wasteByMachine: [{ machine: 'כיפוף 1', waste: 18, qty: 860 }],
      recentOrders: orders, machines,
    };
  }
  if (path.endsWith('/api/production-queue')) return { items: queueItems, grouped: {} };
  if (path.endsWith('/api/orders')) return query.get('date') ? orders.filter(order => order.delivery_date === query.get('date')) : orders;
  if (path.endsWith('/api/customers')) return customers;
  if (path.endsWith('/api/machines')) return machines;
  if (path.endsWith('/api/alerts')) return [];
  if (path.endsWith('/api/kpi/shift-summary')) return { shiftType: 'morning' };
  if (path.endsWith('/api/kpi/tons-today')) return { tons: 18.4 };
  if (path.endsWith('/api/procurement/plan')) {
    return { groups: [
      { diameter: 12, material_type: 'coil', physical_stock_kg: 820, recommended_purchase_kg: 1400, alert: 'critical' },
      { diameter: 16, material_type: 'straight', physical_stock_kg: 2400, recommended_purchase_kg: 0, alert: 'ok' },
    ] };
  }
  if (path.endsWith('/api/finance/kpis')) {
    return {
      summary: { total_revenue: 186400, total_cost: 121200, total_margin: 65200, avg_margin_pct: 35, order_count: 3, total_tons: 8.68 },
      receivables: { unpaid: 24600, unpaid_count: 2, overdue: 6200, overdue_count: 1 },
      top_customers: [{ name: 'אקרשטיין', revenue: 98000, margin: 34000, margin_pct: 34.7 }],
    };
  }
  if (path.endsWith('/api/portal-requests')) return { pendingCount: 1, unreadCount: 1 };
  if (path.endsWith('/api/packages')) return [];
  if (path.endsWith('/api/deliveries')) return orders.filter(order => order.delivery_date === TODAY);
  if (path.endsWith('/api/purchase-orders')) return [];
  if (path.endsWith('/api/suppliers')) return [{ id: 1, name: 'יהודה פלדות', phone: '04-8412200' }];
  if (path.endsWith('/api/steel-prices')) return [];
  if (path.endsWith('/api/quality/weighing-orders')) return { rows: orders.map(order => ({ id: order.id, order_num: order.order_num, customer_name: order.customer_name, status: order.status })), total: orders.length, customers: customers.map(c => ({ id: c.id, name: c.name })) };
  if (path.endsWith('/api/quality/weighings')) return { rows: [], total: 0, customers: customers.map(c => ({ id: c.id, name: c.name })) };
  if (path.endsWith('/api/quality/stats')) return { total: 12, passed: 11, failed: 1 };
  if (path.endsWith('/api/maintenance/stats')) return { open: 1, wip: 0, total: 4 };
  if (path.endsWith('/api/brand')) return { name: 'IronBend', logo: '/brand/tene-pdf-logo.jpg' };
  return { ok: true, items: [], orders: [], results: [], rows: [], data: [], groups: [], machines: [] };
}

module.exports = { demoBody };
