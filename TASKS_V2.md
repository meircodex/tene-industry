# TASKS_V2 — IronBend V2

לוח המשימות המרכזי לבנייה מחדש. אין לעבוד ממשימות בצ'אט בלבד.

## סטטוסים

- `todo` — מוכן לבחירה.
- `in_progress` — תפוס על ידי סוכן.
- `approval` — מחכה להכרעת מאיר.
- `blocked` — חסום מסיבה כתובה.
- `done` — הושלם.

## כללי תפיסה

1. סוכן בוחר משימה אחת בלבד.
2. לפני עבודה הוא משנה ל־`in_progress`.
3. אם יש התנגשות scope עם משימה אחרת — לא לוקחים.
4. commit רק עם נתיבים מפורשים.
5. לא נוגעים בקבצים מחוץ ל־scope.

---

## ?? בתכנון / לאישור מאיר

### V2-000 — החלטת Repo ומסלול בנייה

- status: approval
- owner: meir
- module: project-management
- scope:
  - repo strategy
- question: האם V2 נבנה בריפו חדש `ironbend-v2` או בתוך הריפו הקיים בתיקייה נפרדת?
- recommendation: ריפו חדש או תיקיית `v2/` נקייה, בלי תלות בקוד הישן.
- definition_of_done:
  - הוחלט איפה V2 חי.
  - הוגדר מה אסור לייבא מהישן.

---

## ?? Sprint 0 — חלוקת משימות אפיון

מטרה: לסיים אפיון מודולרי לפני כתיבת קוד V2. כל משימה כאן היא אפיון בלבד: README/manifest/API/events/screens. לא בונים קוד עד שהאפיון מאושר.

| סדר | משימה | בעלים מומלץ | למה |
|---|---|---|---|
| 1 | `V2-006` Steel/Rebar Industry | gpt | הליבה המקצועית: צורות, חישוקים, ספירלות, משקל ותצוגה ויזואלית. כל ההזמנות נשענות על זה. |
| 2 | `V2-008` Intake/OCR | gpt | חייב להישען על חוקי הצורות; כולל השוואה מול מקור, תיקון צורה ואימון OCR. |
| 3 | `V2-007` Orders | gpt | מרכז התהליך העסקי: לקוח, פריטים, סטטוסים, אישור, מעבר לייצור. |
| 4 | `V2-011` Production Cards | gpt | נגזר מהזמנות ומתעשיית ברזל; כולל כרטיסיות, ברקוד, תחנת עובד, משקל רצוי/מצוי. |
| 5 | `V2-005` Customers | claude/either | עצמאי יחסית: לקוח, אנשי קשר, כתובות, תנאי תשלום, מחירון לקוח. |
| 6 | `V2-009` Pricing | claude/either | עצמאי יחסית אבל חייב להחזיק מחיר קנייה, מכירה, מחיר לקוח ו־snapshot להזמנה. |
| 7 | `V2-002` Auth / Users / Permissions | claude/either | תשתית ליבה; ניתן לאפיין במקביל כי אינו תלוי בצורות. |
| 8 | `V2-004` Licensing Gate | claude/either | רישוי ומכירת מודולים; תלוי ב־module registry אך אפשר לאפיין חוזה במקביל. |
| 9 | `V2-003` Module Registry + Manifest | gpt | מחבר את כל המודולים לטעינה, ownership, consumes/produces ומפת מודולים. |
| 10 | `V2-010` Integration Gate | gpt | שער כניסה לכל עבודה חיצונית; שומר שאין שוב שני עותקים וטלאים. |

### כללי עבודה לספרינט האפיון

- אין קוד. רק אפיון, manifests, API contracts, אירועים, מסכים ותלויות.
- כל מודול חייב לציין: input, output, logic, DB ownership, API, events, screens, permissions, risks.
- מודול שמייצר מסך חייב לכלול mockup plan ותצוגה לפני קוד.
- אם Claude עובד במקביל — הוא לוקח רק משימות שסומנו `claude/either` ולא נוגע במשימות `gpt` בלי תיאום.
- אם יש סתירה בין מסמך חיצוני למסמך V2 — מסמך V2 מנצח, והסתירה נרשמת ב־blocker.

---

## ? מוכן לעבודה

### V2-001 — V2 Core Skeleton

- status: todo
- owner: gpt
- module: core
- priority: critical
- scope:
  - `v2/` או ריפו חדש לאחר החלטת V2-000
- input:
  - `docs/PROJECT_TRUTH_HE.md`
- output:
  - שלד פרויקט נקי
  - תיקיות core/modules/industries/apps/shared/tests
  - test runner בסיסי
  - health endpoint
- logic:
  - אין לוגיקה עסקית.
  - רק תשתית טעינה ובדיקת חיים.
- definition_of_done:
  - הפרויקט עולה מקומית.
  - יש בדיקת health ירוקה.
  - אין תלות בקוד הישן.

### V2-002 — Auth / Users / Permissions Contract

- status: approval
- owner: codex-admin-system-licensing
- module: core-auth
- priority: critical
- scope:
  - core/auth
  - core/permissions
  - modules/admin-users
- input:
  - משתמשים, roles, login credentials
- output:
  - JWT stable auth
  - permissions service
  - user management API
- logic:
  - role לא מגיע מ־header מזויף.
  - JWT secret חובה בייצור.
  - WebSocket auth מתוכנן מהיום הראשון.
- definition_of_done:
  - login/logout/refresh מוגדרים.
  - requireRole/requireAnyRole מוגדרים.
  - בדיקות auth קיימות.

### V2-003 — Module Registry + Manifest Contract

- status: todo
- owner: gpt
- module: core-modules
- priority: critical
- scope:
  - core/module-registry
  - shared/module-contract
- input:
  - module.manifest.js מכל מודול
- output:
  - registry של מודולים
  - consumes/produces map
  - validation למודול
- logic:
  - מודול בלי manifest לא נטען.
  - manifest הוא מקור אמת ל־ownership.
- definition_of_done:
  - מודול דמה נטען.
  - מודול בלי manifest נכשל בבדיקה.
  - map בסיסי מוצג/נוצר.

### V2-004 — Licensing Gate

- status: done
- owner: codex-admin-system-licensing
- module: licensing
- priority: high
- scope:
  - core/licensing
  - core/module-gates
  - test/core-module-gates.test.js
- input:
  - license entitlements
  - module registry
- output:
  - requireModule(moduleId)
  - enabled/disabled modules
- logic:
  - Gate לפני routes.
  - Free/dev mode פתוח.
  - Production customer מקבל רק מה שרכש.
- definition_of_done:
  - מודול כבוי חסום.
  - מודול ליבה לא ננעל בטעות.

### V2-005 — Customers Module Specification

- status: todo
- owner: claude/either
- module: customers
- priority: high
- scope:
  - modules/customers/README_HE.md
  - modules/customers/module.manifest.js
- input:
  - לקוח, אנשי קשר, כתובות, תנאי תשלום, מחירון לקוח
- output:
  - customer profile contract
  - customer API contract
  - customer screen contract
- logic:
  - לקוח הוא entity עצמאי, לא שדה בתוך הזמנה.
- definition_of_done:
  - אפיון מלא לפני קוד.
  - owner/input/output/db/api/events/screens מוגדרים.


### V2-005A — Customer Portal Price List Visibility And Print Template

- status: done
- owner: codex-customer-portal
- module: customers/portal
- priority: high
- latest_change:
    - implemented the official OCR Review Workspace UI layer: dark header with existing TENA logo, detected context cards, compact editable steel-item table, source highlights, and production review actions.
  - removed the legacy TNA logo source from branding defaults, client-side brand cache, and static assets so runtime branding cannot swap the PDF logo back to the old SVG.
  - fixed the PDF logo rollout by cropping the source asset and locking shared navigation logo dimensions so the image cannot expand over dashboard screens.
  - replaced direct Tene logo image references across customer-facing and shared public shells with the uploaded customer price-list PDF logo asset.
- scope:
  - `TASKS_V2.md`
  - `db/coreSchema.js`
  - `db/startup.js`
  - `routes/customers.js`
  - `routes/portal.js`
  - `services/portalAccess.js`
  - `public/customers.html`
  - `public/customer.html`
  - `public/login.html`
  - `public/nav.js`
  - `public/portal.html`
  - `public/production-queue.html`
  - `public/supplier.html`
  - `public/sw.js`
  - `public/theme.css`
  - `public/brand-client.js`
  - `services/branding.js`
  - `services/settings.js`
  - `docs/spec-customer-side.md`
- input:
  - customer profile
  - customer tax id / company id
  - portal price list visibility: none / general / customer
  - active general or customer price book
  - reference PDF: customer printable price list layout
- output:
  - customer card controls whether the portal shows no price list, a general price list, or the customer price list.
  - customer-facing portal never exposes internal price book names, tiers, labels, or management source fields.
  - printable customer price list uses customer fields dynamically: name, tax id, address, phone, email, price date, rows, VAT note, signature area.
- logic:
  - order quote calculation remains separate from price-list visibility.
  - customers with no visible price list can still receive order quotes according to their pricing rules.
  - a customer configured for a visible general price list sees a printable public document, not the internal price book name.
  - a customer configured for a visible customer price list sees the same public document format with customer-specific rows.
- definition_of_done:
  - admin customer detail includes tax id and price-list visibility.
  - portal `/api/c/price-list` returns hidden state unless visibility allows a printable document.
  - portal price list print view matches the uploaded reference structure closely enough for operational use.
  - frontend and backend syntax checks pass.

### V2-005B — Customer Portal Sites, Field Users And Budget Control

- status: in_progress
- owner: codex-customer-portal
- module: customers/portal
- priority: high
- latest_change:
  - fixed customer portal access links to use BASE_URL or the public request host instead of localhost.
  - added first-edit customer profile locking so later portal detail changes become internal approval requests.
  - exposed a customer quote-before-order entry point and a dedicated quote panel before order submission.
  - made the customer portal home project-first with visible new-project actions and an editable customer details panel.
  - clarified the customer portal session action by replacing the confusing switch-customer/logout wording with a simple logout label.
  - added customer-facing site/user controls for foreman assignment, delegated portal permissions, and customer-safe order PDF print output.
  - added role-aware section navigation to the customer portal home screen so orders, sites, finance, price list, and documents open as clear focused areas instead of one long mixed page.
  - collapsed the customer-site creation form once sites exist so the portal shows existing projects first and only opens a new-site form on explicit request.
  - removed the visible old/new portal split by converting legacy customer links into per-user portal tokens on first portal load.
  - fixed the customer portal home view so saved customer sites are shown automatically after refresh instead of hiding behind the Sites button.
  - added customer self-service site creation in the customer portal so authorized customer managers can open their own project sites before placing orders.
  - added the first runtime foundation for customer sites, portal-user site assignments, delegated permission flags, budget fields, audit log, authorized site summaries, and portal order site binding.
  - captured the customer-site hierarchy requirement: customer admins create sites, assign foremen, delegate permissions, control price visibility, and track steel quantity/spend against project budgets.
- scope:
  - `TASKS_V2.md`
  - `docs/modules/portal.md`
  - `db/coreSchema.js`
  - `db/startup.js`
  - `routes/customers.js`
  - `routes/portal.js`
  - `services/portalAccess.js`
  - `public/customer.html`
  - future: `public/customers.html`
- input:
  - customer
  - customer sites/projects
  - customer portal users
  - site assignment and default site
  - delegated permissions from customer manager to finance/project/field users
  - project budget in money and steel quantity
  - order totals, delivery totals, invoice totals
- output:
  - customer portal users see only the sites they are authorized for.
  - a field manager assigned to one site opens orders directly for that site without choosing a site.
  - multi-site users can choose only from their authorized sites.
  - customer managers can create sites and invite/manage users when Tene grants that capability.
  - budget dashboards show ordered/approved/delivered/invoiced steel and spend per site, respecting price permissions.
  - field users can be blocked from seeing prices while finance users can see money, budgets, invoices, and overruns.
- logic:
  - permission delegation is hierarchical: a user can grant only permissions they already have and only inside their allowed sites.
  - Tene controls the top-level customer capabilities: portal active, can manage users, can create sites, can set budgets, can expose prices to customer users.
  - customer managers control their own internal users inside the limits granted by Tene.
  - every order created in the portal must resolve to an authorized `site_id`; client-provided site IDs are never trusted without server validation.
  - budget usage should be visible in layers: ordered, approved, delivered, invoiced.
  - budget overrun requires an explicit approval path by a user with `can_approve_budget_overrun`.
  - every permission change is audit logged with actor, target user, before/after, time, and affected sites.
- definition_of_done:
  - DB contract exists for customer sites, portal users, site assignments, permissions, budgets, and audit log.
  - portal auth response includes role, allowed sites, default site, and capability flags.
  - single-site field users never see a site picker when opening an order.
  - customer admin can create sites and assign users according to delegated permissions.
  - price/budget/invoice visibility is enforced server-side and reflected in the UI.
  - site dashboard summarizes steel quantity and money usage without leaking prices to unauthorized users.
  - tests cover site authorization, price visibility, budget overrun approval, and forbidden cross-site access.

### V2-005C — Customer Finance Control Dashboard

- status: in_progress
- owner: codex-customer-portal
- module: customers/portal
- priority: high
- latest_change:
  - started runtime implementation for the customer finance control dashboard: explicit finance/payment-alert permission, customer-scoped finance APIs, and portal UI dashboard.
- scope:
  - `TASKS_V2.md`
  - `docs/spec-customer-finance-control-dashboard.md`
  - future: `routes/portal.js`
  - future: `public/customer.html`
  - future: `test/client-auth-contract.test.js`
- input:
  - customer sites/projects
  - customer portal users and site assignments
  - delegated finance permissions
  - project budgets in money and steel quantity
  - order history
  - delivery notes
  - invoices
  - payment terms
- output:
  - finance-manager dashboard inside the customer portal.
  - visual cards for due now, due soon, open exposure, budget usage, and over-budget sites.
  - per-site breakdown of ordered, approved, delivered, invoiced, paid, and unpaid amounts.
  - payment alerts that pop when due dates arrive according to payment terms.
  - order history prepared for future customer document generation.
- logic:
  - the customer defines its own sites and internal users inside the capabilities granted by Tene.
  - a single-site field manager never chooses a site; their orders are automatically bound to their assigned site.
  - finance users can see prices, budgets, invoices, payment alerts, and document history according to explicit permissions.
  - field users do not receive money fields unless they have explicit price permissions.
  - `canApprove` is not a shortcut for creating sites, viewing money, or managing users; use explicit capabilities.
  - payment due dates are calculated from the configured payment-term anchor: invoice date, delivery-note date, order-approval date, or manual due date.
- definition_of_done:
  - customer finance dashboard specification exists and is linked from this task.
  - implementation exposes finance summary, sites breakdown, payments due, and order history through customer-scoped APIs.
  - UI shows payment alerts and site budget status without leaking money fields to unauthorized users.
  - tests cover finance manager visibility, field manager restrictions, single-site order binding, and payment due calculations.

### V2-006 — Steel/Rebar Industry Specification

- status: todo
- owner: gpt
- module: industry-steel-rebar
- priority: critical
- scope:
  - industries/steel-rebar/README_HE.md
  - industries/steel-rebar/module.manifest.js
- input:
  - קוטר, צורה, צלעות, זוויות, ספירלה, כמות
- output:
  - shape contract
  - weight contract
  - visual SVG contract
- logic:
  - ישר בלי זוויות.
  - מקופף עם צלעות וזוויות.
  - ספירלה עם קוטר ברזל, קוטר ספירלה, מספר כריכות.
  - חישוק עם סימון פנימי קבוע.
- definition_of_done:
  - כל סוג צורה מוגדר.
  - אין ambiguity בין ספירלה/חישוק/מקופף.

### V2-006A — Shape Editor Angle Quick Controls

- status: done
- owner: codex-shape-editor
- module: industry-steel-rebar/shape-editor
- priority: high
- scope:
  - public/index.html
  - public/intake.html
  - public/customer.html
  - public/shape-editor.js
  - test/shape-geometry.test.js
- input:
  - כל זווית בעורך צורות
  - קיצור מהיר ל־90, -90 ול־45
- output:
  - שדה זווית ניתן לעריכה בטווח ‎-360 עד 360 מעלות.
  - כפתורי shortcut מהירים ל־90, -90 ול־45 בתוך טבלת הצלעות.
  - מסכי הזמנה/קליטה/לקוח טוענים גרסת shape-editor חדשה כדי לעקוף cache ישן.
- logic:
  - ערכי זווית נשמרים בטווח ‎-360–360.
  - סנכרון תצוגת 3D ממשיך להישען על ערכי הזווית המעודכנים.
- definition_of_done:
  - input זווית בעורך מאפשר `min=-360` ו־`max=360`.
  - `_setAngle` מגביל לטווח ‎-360–360 במקום 179.
  - קיימים כפתורי 90, -90 ו־45 עם מצב active יציב.
  - `shape-editor.js` נטען ב־`v46` במסכים שמשתמשים בעורך.
  - בדיקת shape geometry מכסה את החוזה.

### V2-006B — Shape Editor Clean Preview Mockup

- status: done
- owner: codex-shape-editor
- module: industry-steel-rebar/shape-editor
- priority: high
- scope:
  - docs/mockups/shape-editor-v2-preview.html
- input:
  - השראה ממסכי Easybar שצורפו בצילומי מסך
  - דרישה למסך נקי בלי הרבה חלונות
- output:
  - תצוגה מקדימה אינטראקטיבית לעורך צורות V2.
  - מסך יחיד עם קנבס מרכזי, פאנל ימני דינמי ורשימת פריטים שמאלית.
  - גלריית צורות עם סינון בלי modal נוסף.
- logic:
  - בחירת צורה מחליפה את שדות הפאנל במקום לפתוח חלון.
  - ציור SVG נוצר מאותו state שמייצג את הנתונים.
  - שדות מתקדמים נשארים סגורים כברירת מחדל.
- definition_of_done:
  - קיים mockup HTML עצמאי שנפתח בדפדפן.
  - יש לפחות מוט, פיגורה, חישוק, ספירלה, רשת וכלונס.
  - השדות והציור מתעדכנים באותו מסך.

### V2-006C — Shape Editor Fullscreen Clean Runtime

- status: done
- owner: codex-shape-editor
- module: industry-steel-rebar/shape-editor
- priority: high
- scope:
  - public/index.html
  - public/intake.html
  - public/customer.html
  - public/shape-editor.js
  - test/shape-geometry.test.js
- input:
  - דרישה שעורך הצורות ייפתח במסך מלא.
  - השראה ממסך נקי שבו שינוי זווית משנה מיד את השרטוט והמספרים ניתנים לעריכה גם על הצורה.
- output:
  - מודל עורך הצורות נפתח כ-workspace מלא, נקי ורחב בכל המסכים שמחברים אליו.
  - תוויות אורך וזווית בתוך השרטוט מאפשרות דאבל-קליק לעריכה מהירה.
  - טעינת `shape-editor.js` קודמה ל-`v47` כדי לעקוף cache ישן.
- logic:
  - אין חלון נוסף מעל חלון: אותו עורך קיים הופך למסך עבודה מלא.
  - קליק רגיל על תווית ממשיך למקד את השורה, דאבל-קליק פותח עריכה מהירה ומעדכן state/preview.
- definition_of_done:
  - `#seModal` משתמש ב-`100vw` ו-`100vh` ללא override קומפקטי בפורטל הלקוח.
  - קיימות פונקציות עריכת תוויות ישירה לאורך ולזווית.
  - בדיקת shape geometry מכסה את חוזה המסך המלא והעריכה מהאיור.
### V2-006D — Shape Editor Direct-Open Page State Fix

- status: done
- owner: codex-shape-editor
- module: industry-steel-rebar/shape-editor
- priority: high
- scope:
  - TASKS_V2.md
  - public/shape-editor.js
  - test/shape-geometry.test.js
- input:
  - בפתיחה מקליטת הזמנה לעורך הצורות נשאר מסך בחירת מספר צלעות מעל מסך העריכה.
- output:
  - פתיחת צורה קיימת עוברת למסך עריכה יחיד ונקי ללא מסך count פתוח מעליו.
- logic:
  - `_goToEdit` מאפס במפורש את מצב כל עמודי העורך, כולל `sePageCount`.
- definition_of_done:
  - `sePageCount` מוסתר בכל כניסה למסך עריכה.
  - קיימת בדיקת מקור שמכסה את חוזה הניווט הזה.
### V2-006E — Shape Editor One-Screen Edit Layout

- status: done
- owner: codex-shape-editor
- module: industry-steel-rebar/shape-editor
- priority: high
- scope:
  - TASKS_V2.md
  - public/shape-editor.js
  - test/shape-geometry.test.js
- input:
  - עריכת צורה אחת צריכה להיכנס במסך בלי גלילת עמוד.
- output:
  - מסך העריכה משתמש בגובה viewport מלא עם פוטר נמוך וקנבס דחוס.
  - טבלת הצלעות מקבלת גלילה פנימית רק כשיש הרבה שורות.
- logic:
  - `#sePageEdit` מקבל גובה מחושב לפי `100vh` והמודל נשאר `overflow:hidden`.
  - אזור השרטוט מקבל גובה מחושב יציב שאינו דוחף את הפוטר מחוץ למסך.
- definition_of_done:
  - עריכת צורה רגילה אינה דורשת גלילת עמוד.
  - קיימת בדיקת מקור שמכסה את חוזה הפריסה החדשה.
### V2-006F — Shape Editor One Row Per Side

- status: done
- owner: codex-shape-editor
- module: industry-steel-rebar/shape-editor
- priority: high
- scope:
  - TASKS_V2.md
  - public/shape-editor.js
  - test/shape-geometry.test.js
- input:
  - פאנל מידות צריך להציג כל צלע בשורה אחת נקייה כמו בדוגמת Easybar.
- output:
  - כל צלע מוצגת כשורה אחת עם אות צלע, אורך וזווית באותה שורה.
  - שורות כיפוף נפרדות הוסרו ממסך 2D כדי לצמצם גובה וגלילה.
- logic:
  - האותיות A/B/C מגיעות מאינדקס הצלע כדי להתאים לסימון שעל השרטוט.
  - קיצורי הזווית נשארים באותה שורה ולא יוצרים שורת מידע נוספת.
- definition_of_done:
  - אין רינדור `se-bend-row` נוסף במצב 2D.
  - קיימת בדיקת מקור שמכסה צלע אחת = שורה אחת.
### V2-006G — Shape Editor Mesh And Pile Icon Gallery

- status: done
- owner: codex-shape-editor
- module: industry-steel-rebar/shape-editor
- priority: high
- scope:
  - TASKS_V2.md
  - public/shape-editor.js
  - public/index.html
  - public/intake.html
  - public/customer.html
  - test/shape-geometry.test.js
- input:
  - דרישה להוסיף אופציה לרשתות וכלונסאות.
  - דרישה שגלריית עורך הצורות תהיה בסגנון Easybar בלי שמות גלויים לכל צורה.
- output:
  - מסך בחירת צורה כולל טאבים למוטות, רשת וכלונסאות.
  - נוספו presets בסיסיים לרשת סימטרית ולכלונס בסיס.
  - כפתורי צורה מוצגים כאייקונים עגולים בלבד, עם שם רק ב-tooltip/aria-label.
  - טעינת `shape-editor.js` קודמה ל-`v48` במסכים שמשתמשים בעורך.
- logic:
  - פתיחת עורך ללא צורה קיימת מגיעה ישירות למסך סוג/צורה כדי שרשת וכלונסאות יהיו זמינים מיד.
  - בחירת מספר צלעות עדיין מסננת מוטות רגילים, אבל לא חוסמת משפחות רשת/כלונס.
- definition_of_done:
  - קיימים `mesh1` ו-`pile1` בקטלוג הפרסטים.
  - קיימים `SHAPE_FAMILIES` ו-`seFamilyTabs`.
  - פרסטים מובנים אינם מרנדרים span גלוי עם שם הצורה.
  - קיימת בדיקת מקור שמכסה את חוזה הגלריה החדשה.

### V2-006L ? Steel Rebar Shape Data Contracts

- status: done
- owner: codex-shape-editor
- module: industry-steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `docs/modules/steel-rebar-shape-data-contracts.md`
  - `test/steel-rebar-shape-data-contracts.test.js`
- input:
  - families: bars, mesh, piles
  - requirement for database schema, saved JSON, machine output, and validation rules
- output:
  - canonical data-contract document for steel-rebar shape payloads.
  - contract test that guards all required sections and family boundaries.
- logic:
  - bars use `sides[]` and `angles[]`.
  - mesh and piles must not use `sides[]` or `angles[]`.
  - machine output is derived from saved JSON, not separately authored by UI.
- definition_of_done:
  - contracts define database schema, saved JSON, machine output, and validation rules for bars.
  - contracts define database schema, saved JSON, machine output, and validation rules for mesh.
  - contracts define database schema, saved JSON, machine output, and validation rules for piles.
  - no UI or rendering files are changed.


### V2-006M ? Shape Editor Approval Data Contract

- status: done
- owner: codex-shape-editor
- module: industry-steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `SHAPE_DATA_CONTRACT.md`
- input:
  - required Shape Editor approval return contract for bars, mesh, and piles
  - downstream consumers: Orders/Items, Production Cards, Pricing/Weight
- output:
  - documentation-only contract defining production-ready structured shape data returned on approval.
- logic:
  - Shape Editor must not return only drawing data.
  - bars return sides, angles, diameter, quantity, totalLengthMm, weightKg, bendCount.
  - mesh returns dimensions, diameters, spacing, edges, bar counts, totalLengthMm, weightKg.
  - piles return pile/cage fields, spiral zones, total longitudinal/spiral lengths, weightKg.
  - BVBS and machine integration are explicitly not implemented.
- definition_of_done:
  - contract covers user fields, saved JSON, calculated fields, validation, machine output fields, Orders/Items fields, Production Card fields, and Pricing/Weight fields for all three families.
  - no UI files changed.
  - no rendering files changed.
  - no code files changed.


### V2-006N - Shape Data Contract V2 Ownership Corrections

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `SHAPE_DATA_CONTRACT_V2.md`
- Output:
  - Documentation-only V2 contract for approved Shape Editor payloads.
  - Removes `quantity` from Shape ownership and assigns quantity to Order Item.
  - Adds mandatory shape identity: `shapeId`, `shapeType`, `family`.
  - Adds mandatory shape versioning: `contractVersion`, `shapeVersion`.
  - Replaces flat machine output with `machineOutput.generic` and `machineOutput.machineProfiles` placeholders for `MEP`, `PEDAX`, and `SCHNELL`.
  - Adds Shape vs Order Item ownership chapter.
- Guardrails:
  - No UI changes.
  - No rendering changes.
  - No code changes.
  - No new shape families.

### V2-006O - Implement Shape Data Contract V2 Approval Payload

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `public/index.html`
  - `test/shape-geometry.test.js`
- Output:
  - Shape approval now returns the full `SHAPE_DATA_CONTRACT_V2` envelope.
  - Adds `shapeId`, `shapeType`, `shapeVersion`, `contractVersion`, `validation`, `machineOutput.generic`, and `machineOutput.machineProfiles`.
  - Removes `quantity` from Shape-owned data and machine output.
  - Keeps legacy top-level fields during transition so existing order/intake/portal callers can keep reading sides/angles/family fields.
- Guardrails:
  - No UI changes.
  - No rendering changes.
  - No new shape families.
- Verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`

### V2-006AO - Shape V2 Integration Across Orders Production Intake

- status: done
- owner: codex-shape-editor / codex-orders / codex-intake-ocr / codex-production-cards-printing
- module: Shape V2 integration
- priority: critical
- scope:
  - `services/orderContracts.js`
  - `services/orders.js`
  - `services/intakeWorkflow.js`
  - `routes/orders.js`
  - `public/index.html`
  - `public/shape-editor.js`
  - `services/productionCards.js`
  - `test/*.test.js`
- output:
  - Orders creation/edit/add-item paths persist full Shape V2 snapshots.
  - Production cards and display routes prefer Shape V2 snapshots and canonical SVG output.
  - Intake/OCR approval creates a full Shape V2 snapshot from OCR rows.
  - Quantity remains item-owned and is not stored as Shape-owned data.
- verification:
  - `npm test` passed with 353/353 tests.

### V2-006P - Pile Cage Editor Visual Systems

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- Output:
  - Pile cage editor now exposes pile-specific controls for spiral type, no-wrap spiral zones, hoops, and longitudinal bar pattern.
  - Pile cage preview now visually distinguishes spiral zones, no-wrap regions, hoops, straight bars, and L/alternate longitudinal bars.
  - Field focus metadata was extended so pile-specific controls highlight the matching visual system.
  - Shape Data Contract V2 approval payload remains unchanged.
- Guardrails:
  - No full-screen redesign.
  - No new shape families.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- Verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`

### V2-006Q - Shape Editor Engineering Workspace Mockup

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `docs/mockups/shape-editor-engineering-workspace.html`
- Output:
  - Mockup-only visual direction for a unified engineering Shape Editor.
  - Keeps the right side as a compact parameter input panel, visible even in the in-app browser width.
  - Covers bends, mesh, and pile cages with one workspace structure.
  - Uses ASCII labels temporarily to avoid local encoding corruption during visual review.
- Guardrails:
  - No live UI changes.
  - No rendering engine changes.
  - No shape contract changes.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- Verification:
  - Local URL returns HTTP 200: `docs/mockups/shape-editor-engineering-workspace.html`.

### V2-006R - Shape Editor Bypass Legacy Selection Screen

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- Output:
  - New Shape Editor opens directly in the edit workspace with a default bars preset.
  - The legacy shape selection gallery is no longer shown as an intermediate screen.
  - Family tabs switch directly to the matching editor preset for bars, mesh, or piles.
- Guardrails:
  - No UI redesign.
  - No new shapes or shape families.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- Verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`

### V2-006S - Shape Editor Compact Bend Parameters And Angle Markers

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- Output:
  - Bend parameter rows are more compact and technical, matching the pile-cage visual direction.
  - Length tags on the drawing are smaller and less dominant.
  - Non-90 bend angles render as a small arc with a small value label, without a boxed tag.
  - 90-degree bends keep the right-angle marker.
- Guardrails:
  - No full UI redesign.
  - No new shapes or shape families.
  - No rendering-engine contract changes.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- Verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`


### V2-006T - Shape Editor Reduce Empty Bend Windows

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- Output:
  - Rows without a bend angle use a compact dash instead of a large empty angle window.
  - Compact bend editor tests cover the reduced field proportions.
- Guardrails:
  - No full UI redesign.
  - No new shapes or shape families.
  - No rendering-engine contract changes.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- Verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`


### V2-006U - Shape Editor Prevent Bend Parameter Overlap

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- Output:
  - Right-side bend parameter panel gets more width from the drawing area.
  - 3D bend rows use stable non-equal columns so length, bend angle, and Z angle do not overlap.
  - Parameter inputs, icons, and row badges are reduced slightly to keep compact rows readable.
- Guardrails:
  - No full UI redesign.
  - No new shapes or shape families.
  - No rendering-engine contract changes.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- Verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`


### V2-006V - Shape Editor Z Angle Field Focus Fix

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- Output:
  - Z angle inputs focus their own field instead of switching to side-length editing.
  - `data-el="0"` and other indexed bar fields keep their parameter metadata.
  - Tests guard that Z uses `bar-z-*` focus keys and `[data-el]` selection.
- Guardrails:
  - No full UI redesign.
  - No new shapes or shape families.
  - No rendering-engine contract changes.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- Verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`


### V2-006W - Shape Editor Default Added Side Bend To 90

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- Output:
  - Newly added bar sides default to a 90-degree bend in both 2D and true-3D bend fields.
  - Tests guard that `_addSide()` no longer initializes 3D azimuth bends as `0`.
- Guardrails:
  - No full UI redesign.
  - No new shapes or shape families.
  - No rendering-engine contract changes.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- Verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`


### V2-006X - Shape Editor Positive Default Bend And Quantity Handoff

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `public/index.html`
  - `test/shape-geometry.test.js`
- Output:
  - 90-degree bends map to positive `+90` 3D turn values instead of `-90`.
  - Shape editor footer quantity is editable and returned as `orderItemQuantity` outside the shape contract.
  - Manual add-item flow opens the shape editor first and creates the item only after approval.
- Guardrails:
  - No full UI redesign.
  - No new shapes or shape families.
  - Shape contract still removes shape-owned `quantity`.
  - No Production, Pricing, Warehouse, OCR, API, or DB changes.
- Verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`


### V2-006Z - Shape Editor Active Segment Highlight Stroke Size

- Status: done
- Owner: codex-shape-editor
- Module: industry-steel-rebar/shape-editor
- Scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- Output:
  - Active side coloring in the shape preview is disabled; editing focus no longer recolors the drawn bar.
  - 2D bars and closed-stirrup bodies draw with their normal bar color while fields are focused.
  - Removed focus-mode stroke/fill overrides from SVG focus hits so selection does not color the shape.
  - Bumped the index page shape-editor asset query so the cloud UI loads the updated renderer.
- Guardrails:
  - No UI redesign.
  - No new shape families or presets.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- Verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`


### V2-007 — Orders Module Specification

- status: todo
- owner: gpt
- module: orders
- priority: critical
- scope:
  - modules/orders/README_HE.md
  - modules/orders/module.manifest.js
- input:
  - customer, order items, pricing snapshot, intake approval
- output:
  - order, order_items, status events, production request
- logic:
  - עריכה עורכת הזמנה קיימת.
  - שינוי כרטיסיות אחרי ייצור מחייב מסלול הדפסה מחדש.
- definition_of_done:
  - lifecycle מוגדר.
  - status transitions מוגדרים.
  - API/screen/db/events מוגדרים.

### V2-007A - Order Item Contract

- Status: done
- Owner: codex-shape-editor
- Module: orders / industry-steel-rebar integration
- Scope:
  - `TASKS_V2.md`
  - `ORDER_ITEM_CONTRACT.md`
- Output:
  - Documentation-only source of truth for Order Item identity, immutable shape snapshots, lifecycle, production, warehouse, finance, portal visibility, and field ownership.
  - Defines Order Item as the central object connecting Orders, Shapes, Production, Machines, Warehouse, Finance, and Customer Portal.
  - Preserves Shape ownership from `SHAPE_DATA_CONTRACT_V2.md`: Shape owns geometry; Order Item owns quantity and operational/commercial state.
- Guardrails:
  - No UI changes.
  - No rendering changes.
  - No code changes.
  - No new shape families.

### V2-007B - New Order Customer Site Autofill And Draft Return

- status: done
- owner: codex-orders
- module: orders/customers integration
- priority: high
- scope:
  - `TASKS_V2.md`
  - `public/index.html`
  - `modules/steel-rebar/shapes.js`
  - `services/orders.js`
  - `test/client-auth-contract.test.js`
  - `test/security-routes.test.js`
- output:
  - selecting a customer loads customer details and fills available profile fields.
  - one customer site is applied automatically; multiple sites show a site picker.
  - opening Customers from a draft order saves a local draft for return.
  - saved orders persist selected site_id only when it belongs to the selected customer.
  - new-order save clears stale customer/site bindings before submit and shows server save errors.
  - new-order save treats rows with spiral diameter and turns as spiral items even when source labels are generic.
  - new-order save treats long simple imported cut lengths as coil/spiral items instead of validating them as bar segments.
  - office users can delete pending/unapproved test orders while approved or production-started orders remain protected.
- guardrails:
  - Orders/customer integration only.
  - No Production, Portal, Finance, OCR, pricing, or UI redesign.
- verification:
  - `node --test test\client-auth-contract.test.js test\security-routes.test.js`
  - `npm test`
### V2-008 — Intake/OCR Module Specification

- status: in_progress
- owner: codex-intake-ocr
- module: intake-ocr
- priority: critical
- latest_change:
  - OCR draft autosave no longer fails when OCR training-example persistence is unavailable; row approval remains saved and training is skipped with a warning.
  - Intake/OCR spiral rows keep bar diameter, spiral diameter, and turn count separate; 60 turns stays 60 instead of guessed 160.
  - normalized OCR spiral rows as first-class steel items: bar diameter, spiral diameter, and turn count stay separate, with cut length calculated without guessing 160 when source says 60.
  - added source-field highlighting from parser bounding boxes and row-level OCR learning examples on approved review rows.
  - added foundation rebar-list OCR guidance so Vision extracts rows 1-2, U-shape side sequences, straight singles, and coil rows instead of skipping non-straight rows.
  - tightened OCR source highlighting so large parser row boxes render as a single compact row band.
  - added OCR compare hover mode linking table rows and source PDF targets without saving data.
  - reduced OCR compare fallback source highlights to one compact row band when exact boxes are missing.
  - reconstructed post-order OCR review tables from existing order items when legacy OCR parsed items are empty.
  - persisted post-order OCR row approvals through a review-only Intake endpoint so row counters and approved Orders stay consistent.
  - connected the main analyze-image PDF route to the steel parser so extractable PDFs create populated review drafts instead of empty OCR items.
  - added a steel-document parser layer for order OCR: TASSA/Easybar rows are reconstructed from positioned PDF/OCR tokens by page, row, column and source bbox, with per-field confidence and structured review notes.
  - TASSA/Easybar OCR now separates table total length from sketch side dimensions so 6.90m + 670cm can recover the missing 20cm leg.
  - straight OCR labels no longer erase visible shape parameters; straight is now a fallback only when no geometry/bend evidence exists.
  - visible OCR numbers are now classified by context instead of treating values like 20/180 as special risky markers; L-leg recovery is derived from total-length checksum.
  - corrected the OCR length contract: total length is cut length for weight, while sketch dimensions own shape geometry and mismatches require review.
  - added strict OCR shape classification protection: straight bars remain angle-free, shape markers stay review candidates, and straight lengths drive recalculated weights.
  - changed OCR row-number approval to a reversible toggle and anchored source highlights inside the PDF zoom layer for closer row alignment.
  - separated manual OCR row approval from legacy accepted status and requested clean embedded PDF source view without viewer side panels.
  - corrected OCR review colors: green is operator-approved only, yellow is OCR confidence, red is missing.
  - added OCR recognition refresh and persistent row-number approval states for partial review sessions.
    - show non-default OCR bend angles visually while hiding standard 90/180 labels.
    - suppressed raw segment text for straight OCR bars so source bend-angle columns do not look like shaped geometry.
    - stopped treating straight-bar 180 display angles as L-shape hook legs in OCR review rows.
    - tightened OCR post-order review alignment and moved mini-shape side labels away from the drawing stroke.
    - normalized legacy OCR review rows on screen load so saved 180 L markers render as a 20 cm hook leg and corrected total length/weight.
    - corrected OCR L-shape normalization so 180 remains an angle and the visible 20 cm hook leg contributes to length and weight.
    - aligned OCR mini shape previews vertically inside the item row so each item remains a single readable table row.
    - removed the text label under OCR mini shape previews and enlarged the preview drawing area.
    - improved OCR Review usability: wider non-blurry source PDF sizing, capped outer zoom, and compact detected-context cards that expand only on click.
    - changed post-order OCR review tasks to show the same source-versus-item table first, with review notes below instead of replacing the table.
    - restored OCR Review Workspace runtime to the official baseline view from b83f2f0 so further changes start from the approved visual state.
    - hotfixed OCR Review PDF sizing back to the prior readable layout while keeping duplicate mini-shape dimension text hidden.
    - removed duplicate mini-shape dimension text and enlarged the OCR source PDF workspace default zoom for faster visual review.
    - refined the OCR Review Workspace for factory review speed: compact detected-context cards, 60/40 source-heavy layout, bottom workflow actions, persistent progress, and automatic source/table highlighting.\n  - aligned order OCR comparison with production-card table format: element name, customer shape description, editable shape drawing, row-level review save.
  - added module-origin OCR context for pricing imports: uploads from pricing/price_list stay in Pricing and use `/api/pricing/price-books/analyze-upload`, not order intake.
- scope:
  - modules/intake/README_HE.md
  - modules/intake/module.manifest.js
  - docs/event-registry.md
  - routes/intake.js
  - routes/intakeReview.js
  - routes/catalog.js
  - public/intake.html
  - public/pricing.html
  - test/client-auth-contract.test.js
- input:
  - PDF, image, WhatsApp, email, manual, CSV
  - requested_by_module / requested_use_case / target_module from modules that request OCR
- output:
  - source document, OCR draft, corrections, approval
  - order OCR rows with `item_number`, `element_name`, `shape_description`, geometry, quantities, lengths, calculated weight, and row review status
  - price_list_import draft to Pricing when requested by pricing / price_list context
- logic:
  - OCR יוצר טיוטה בלבד.
  - OCR context from the calling module is a strong routing hint; `pricing / price_list` requests must not become order intake.
  - אישור מול מקור ויזואלי.
  - תיקון צורה פותח shape editor.
  - comparison rows follow the production-card/table format and can be marked reviewed one row at a time.
- definition_of_done:
  - compare flow מוגדר.
  - training flow מוגדר.
  - approval path מוגדר.
  - איפיון מסך קליטת מסמכים והשוואת OCR הועבר ל-modules/intake/README_HE.md.
  - ממתין לאישור מאיר לפני קוד.

### V2-009 — Finance/Pricing Domain Split

- status: done
- owner: codex-finance-pricing
- module: finance-pricing
- priority: high
- scope:
  - `TASKS_V2.md`
  - future: `modules/pricing/README_HE.md`
  - future: `modules/pricing/module.manifest.js`
  - future: `modules/costing/README_HE.md`
  - future: `modules/costing/module.manifest.js`
  - future: `modules/invoicing/README_HE.md`
  - future: `modules/invoicing/module.manifest.js`
  - future: `modules/credit/README_HE.md`
  - future: `modules/credit/module.manifest.js`
  - future: `modules/payment-terms/README_HE.md`
  - future: `modules/payment-terms/module.manifest.js`
  - future: `modules/payments/README_HE.md`
  - future: `modules/payments/module.manifest.js`
- input:
  - `docs/spec-dual-pricing.md`
  - `docs/modules/finance.md`
  - purchase price, sales price, customer price, quote date
  - invoices, credit exposure, payment terms, guarantees, clearing provider
- output:
  - פירוק תחום Finance/Pricing למודולים עצמאיים.
  - גבולות ownership ברורים לכל מקור מחיר/עלות/חיוב/אשראי/סליקה.
  - משימות אפיון נפרדות לפני כתיבת קוד.
- logic:
  - Pricing עונה: כמה הלקוח צריך לשלם.
  - Costing עונה: כמה זה עולה לנו.
  - Invoicing עונה: מה חויב רשמית.
  - Credit עונה: האם מותר להמשיך לעבוד מול הלקוח.
  - Payment Terms / Guarantees עונה: אילו תנאים חייבים להתקיים לפני עבודה/אשראי.
  - Payments עונה: איך תשלום בפועל נסלק/מתועד מול ספק חיצוני.
  - אסור לערבב מחיר קנייה עם מחיר מכירה.
  - אסור לחשב רווחיות ממחיר מכירה במקום מעלות.
  - כל מודול יקבל README/manifest/API/events/screens/permissions/risks משלו לפני קוד.
- definition_of_done:
  - V2-009A עד V2-009F קיימות כמשימות אפיון נפרדות.
  - ברור איזה מודול owns כל טבלה/אירוע/API.
  - אין תלות בקוד V1 או ב-`server.js`.
  - אין עבודה מחוץ ל-Finance/Pricing.

### V2-009A — Pricing Module Specification

- status: todo
- owner: codex-finance-pricing
- module: pricing
- priority: high
- scope:
  - future: `modules/pricing/README_HE.md`
  - future: `modules/pricing/module.manifest.js`
- input:
  - sales price
  - customer price
  - customer pricing source
  - discount
  - quote date
- output:
  - quote price
  - pricing snapshot for order
  - price source label
- logic:
  - מחירון כללי ומחירון לקוח הם שני מקורות מחיר בלבד להצעה.
  - לקוח עם מחירון אישי לא נופל אוטומטית למחירון כללי.
  - `discount_pct` חל רק אחרי בחירת מקור מחיר.
  - snapshot מחיר נשמר בהזמנה ואינו משתנה בדיעבד.
  - Pricing לא מחזיק מחיר קנייה ולא מחשב עלות.
- definition_of_done:
  - README/manifest/API/events/screens/permissions/risks מוגדרים.
  - מוגדר API חישוב מחיר להצעה.
  - מוגדר snapshot מחיר להזמנה.
  - מוגדר status `price_list_requires_update`.

### V2-012A — Inventory Deduction Source Selection

- status: done
- owner: codex-inventory-procurement
- module: inventory/procurement
- priority: high
- latest_change:
  - added default FIFO inventory deduction for new orders with per-item batch override and a system setting to require manual selection or disable deduction.
- scope:
  - `TASKS_V2.md`
  - `services/inventory.js`
  - `services/orders.js`
  - `services/settings.js`
  - `db/coreSchema.js`
  - `db/startup.js`
  - `server.js`
  - `public/index.html`
  - `test/app-smoke.test.js`
  - `test/module-governance.test.js`
- input:
  - approved/manual order item
  - raw material batches by diameter
  - optional selected raw material batch per item
  - inventory allocation default policy
- output:
  - order item consumes matching raw material by default using FIFO.
  - selected batch overrides default allocation.
  - consumption is recorded in `raw_material_usage` and reflected in `raw_material.weight_used`.
- logic:
  - default policy `INVENTORY_ALLOCATION_POLICY=auto_fifo`.
  - `manual_required` requires a matching batch or fails the order.
  - `disabled` or item-level `raw_material_id=none` skips deduction.
  - manual batch must match diameter/material and have enough available stock.
- definition_of_done:
  - new order creation deducts stock when matching inventory exists.
  - order item can choose a specific inventory batch from the new-order screen.
  - tests cover automatic stock deduction and usage audit rows.

### V2-012B ? Inventory Shortage Procurement Handoff

- status: done
- owner: codex-inventory-procurement
- module: inventory/procurement
- priority: high
- scope:
  - `TASKS_V2.md`
  - `services/inventory.js`
  - `services/orders.js`
  - `test/app-smoke.test.js`
  - `test/module-governance.test.js`
- input:
  - order items
  - inventory allocation result
  - missing diameter/material quantity
- output:
  - open alert for stock shortage on the order
  - procurement request in `purchase_orders` with status `inventory_shortage`
  - API response includes created procurement requests
- logic:
  - automatic FIFO still consumes stock when available.
  - when no matching stock exists or stock is insufficient, the order is created and the missing material is handed to procurement.
  - shortages are grouped by diameter and material type.
- definition_of_done:
  - stockless order creates an inventory shortage alert.
  - stockless order creates a procurement request visible to procurement.
  - tests cover the shortage handoff.

### V2-009A-UI — Pricing Manager Runtime Screen

- status: done
- owner: codex-finance-pricing
- module: pricing
- priority: high
- latest_change:
  - added the PDF bottom section to Pricing: editable תנאים והערות, customer approval fields, and signed-copy email line saved with the price book.
  - tightened the Pricing document editor to match the printable PDF more closely: app chrome hidden on pricing, A4-like page sizing, plain editable table cells, PDF date/quantity formatting, and reference-style table spacing.
  - changed Pricing Manager into a document-style price-list editor based on the uploaded printable PDF format: minimal toolbar, editable page fields, inline row editing, add row/section, save and print.
  - prepared the main IronBend Render blueprint for cloud access to pricing: persistent `/data` disk, `/data/ironbend.db`, `/data/backups`, license server URL, and external `BASE_URL`.
  - added pricing OCR import flow: PDF/image recognition creates an editable draft before assigning it to a general or customer price book.
- scope:
  - `docs/mockups/pricing-manager.html`
  - `public/pricing.html`
  - `public/nav.js`
  - `public/finance.html`
  - `public/index.html`
  - `routes/catalog.js`
  - `routes/portal.js`
  - `services/pricer.js`
  - `db/coreSchema.js`
  - `db/financeSchema.js`
  - `db/seed.js`
  - `test/pricer.test.js`
  - `test/app-smoke.test.js`
  - `test/client-auth-contract.test.js`
  - `test/module-governance.test.js`
  - `test/security-routes.test.js`
- input:
  - `docs/spec-dual-pricing.md`
  - sample PDF price list from customer/vendor
- output:
  - מוקאפ HTML עצמאי למסך ניהול מחירונים.
  - מסך מערכת אמיתי לניהול מחירונים, מק״טים ושורות מחיר.
  - API לשמירת מחירונים ושורות מחיר הניתנות לעריכה/הוספה.
  - הסרת מחירון הקוטר הישן (`price_list`) מהמסך, ה-API, ה-schema וה-seed.
  - חלון יבוא מחירון מ-PDF/Excel/CSV.
  - חלון עריכת שורת מחירון עם מק״ט, קטגוריה, יחידה, מחיר, מטבע, חריגה ותוקף.
- logic:
  - המוקאפ אושר כהכוונת UI ומוטמע במסך מערכת.
  - מחירונים חדשים נשמרים כטיוטה עד הפעלה ידנית.
  - מחירון כללי ומחירון לקוח מוצגים ומנוהלים כהפרדה ברורה.
  - מסך המחירון מציג את המחירון כמסמך עבודה אחד לפי פורמט PDF, ולא כפאנל ניהול עם חלונות עריכה.
  - הערות/תנאים ואישור לקוח מופיעים בתחתית המסמך ונשמרים עם המחירון.
  - תנאי תשלום אינם שדה במחירון; הם שייכים למודול Payment Terms / Customers.
  - תאריך מחירון אינו מוזן ידנית; כל שינוי מעדכן `updated_at` ומוצג כ"עודכן".
  - כל שורת מחירון חייבת להיות ניתנת לעריכה/הוספה.
  - מחירון מיובא נשמר כטיוטה עד השוואה ואישור.
- definition_of_done:
  - ניתן ליצור מחירון חדש מתוך התוכנה.
  - ניתן להוסיף, לערוך ולמחוק שורות מק״ט.
  - אין במסך המחירון תנאי תשלום או תאריך תוקף ידני.
  - בדיקות הרשאות ו-governance מכסות את API המחירונים.

### V2-009B — Costing Module Specification

- status: todo
- owner: codex-finance-pricing
- module: costing
- priority: high
- scope:
  - future: `modules/costing/README_HE.md`
  - future: `modules/costing/module.manifest.js`
- input:
  - purchase price
  - steel price history
  - order item weight
  - labor cost rules
  - overhead cost rules
- output:
  - cost basis
  - material cost
  - labor cost
  - overhead cost
  - margin input for Finance reports
- logic:
  - מחיר קנייה מגיע ממקור עלות בלבד, לא ממחיר מכירה.
  - אם חסר מחיר קנייה, מחזירים `cost_basis_missing`.
  - Costing לא יוצר הצעת מחיר ללקוח ולא מציג מחיר בפורטל.
  - Cost snapshot ננעל לפי אירוע הזמנה מוגדר.
- definition_of_done:
  - README/manifest/API/events/screens/permissions/risks מוגדרים.
  - מקור האמת למחיר קנייה מוגדר.
  - מוגדר API חישוב עלות.
  - מוגדר מתי cost snapshot נוצר וננעל.

### V2-009C — Invoicing Module Specification

- status: todo
- owner: codex-finance-pricing
- module: invoicing
- priority: high
- scope:
  - future: `modules/invoicing/README_HE.md`
  - future: `modules/invoicing/module.manifest.js`
- input:
  - approved order
  - pricing snapshot
  - customer billing details
  - payment status
- output:
  - invoice
  - invoice items
  - payment mark
  - cancellation/credit-note contract if approved
- logic:
  - חשבונית נוצרת ממקור עסקי מאושר, לא מטיוטת מחיר.
  - סכום חשבונית נשען על snapshot, לא על מחירון חי.
  - ביטול/זיכוי הוא מסלול מפורש, לא מחיקה שקטה.
  - Invoicing לא מנהל מסגרת אשראי ולא מחשב עלות.
- definition_of_done:
  - README/manifest/API/events/screens/permissions/risks מוגדרים.
  - lifecycle חשבונית מוגדר.
  - API list/create/pay/cancel מוגדר.
  - אירועי invoice מוגדרים.

### V2-009D — Credit Module Specification

- status: todo
- owner: codex-finance-pricing
- module: credit
- priority: high
- scope:
  - future: `modules/credit/README_HE.md`
  - future: `modules/credit/module.manifest.js`
- input:
  - customer
  - credit limit
  - ledger balance
  - open orders
  - unpaid invoices
- output:
  - credit exposure
  - credit block status
  - credit transaction log
  - order approval gate result
- logic:
  - Credit מחליט האם מותר להמשיך לעבוד מול הלקוח.
  - לא מערבבים בין ledger חשבונאי לבין מסגרת אשראי תפעולית בלי חוזה ברור.
  - חסימת אשראי היא תוצאה מפורשת עם סיבה, לא side effect מוסתר.
  - Credit לא יוצר חשבונית ולא מחשב מחיר.
- definition_of_done:
  - README/manifest/API/events/screens/permissions/risks מוגדרים.
  - מוגדר מודל חשיפה וחסימה.
  - מוגדר API בדיקת אשראי.
  - מוגדרים אירועים לשינוי מסגרת/חסימה.

### V2-009E — Payment Terms And Guarantees Module Specification

- status: todo
- owner: codex-finance-pricing
- module: payment-terms
- priority: high
- scope:
  - future: `modules/payment-terms/README_HE.md`
  - future: `modules/payment-terms/module.manifest.js`
- input:
  - customer
  - payment terms
  - signed guarantee
  - required guarantee amount
  - customer onboarding status
- output:
  - terms contract
  - guarantee status
  - pre-work eligibility
  - required action for customer/admin
- logic:
  - לקוח ללא תנאי תשלום חייב תשלום/אשראי מראש לפי החלטה עסקית.
  - לקוח עם תנאי תשלום חייב ערבות חתומה אם כך הוגדר.
  - תנאי תשלום וערבות הם חוזה לקוח, לא שדה צדדי בהזמנה.
  - המודול לא סולק תשלום בפועל ולא יוצר חשבונית.
- definition_of_done:
  - README/manifest/API/events/screens/permissions/risks מוגדרים.
  - מוגדר חוזה תנאי תשלום.
  - מוגדר חוזה ערבות.
  - מוגדרת בדיקת eligibility להזמנה/עבודה.

### V2-009F — Payments Module Specification

- status: todo
- owner: codex-finance-pricing
- module: payments
- priority: medium
- scope:
  - future: `modules/payments/README_HE.md`
  - future: `modules/payments/module.manifest.js`
- input:
  - invoice
  - payment request
  - clearing provider response
  - receipt/reference number
- output:
  - payment attempt
  - payment status
  - provider reference
  - invoice payment event
- logic:
  - Payments מחבר לספק סליקה חיצוני; לא בונים ספק סליקה פנימי.
  - כל ניסיון תשלום נשמר עם provider/reference/status.
  - הצלחת תשלום מעדכנת Invoicing דרך אירוע/חוזה מוגדר.
  - Payments לא מחליט מחיר, עלות, אשראי או תנאי תשלום.
- definition_of_done:
  - README/manifest/API/events/screens/permissions/risks מוגדרים.
  - מוגדר חוזה provider adapter.
  - מוגדר payment lifecycle.
  - מוגדרת אינטגרציה נקייה מול Invoicing.


### V2-010 — Integration Gate + Licensing Source of Truth

- status: todo
- owner: gpt
- module: project-management/licensing
- priority: critical
- scope:
  - `docs/V2_INTEGRATION_PROTOCOL_HE.md`
  - `START_HERE_V2.md`
  - `TASKS_V2.md`
  - future: `core/licensing`
  - future: `core/module-registry`
- input:
  - עבודה שנעשתה אצל Claude/GPT מחוץ לריפו
  - קטלוג מודולים קיים
  - שרת רישיונות קיים
  - החלטות מאיר לגבי מכירת מודולים
- output:
  - שער קליטה אחד לכל עבודה חיצונית
  - חוזה רישוי V2 נקי
  - הפרדה בין מודולי מוצר למודולי תעשייה
  - כלל: מה שלא נכנס דרך TASKS_V2 לא נכנס לפרויקט
- logic:
  - לא מעתיקים קוד צדדי כטלאי.
  - כל עבודה חיצונית מקבלת כרטיס, scope, owner ו־Definition of Done.
  - רישוי מחובר ל־module registry, לא מפוזר במסכים/routes.
  - Free/dev mode פתוח; production נאכף לפי entitlements.
- definition_of_done:
  - פרוטוקול הקליטה מתועד.
  - START_HERE_V2 מפנה לפרוטוקול.
  - כל משימת רישוי עתידית חייבת לעבור דרך core/licensing + module registry.

### V2-011 — Production Cards Module Specification

- status: in_progress
- owner: codex-production-cards-printing
- module: production-cards
- priority: high
- latest_change:
  - separated production-card printing from the A4 order summary: card print stays 8 fixed cards per A4, while print-a4 owns logo, QR, and production weight summary.
  - started worker-phone scan flow: printed card tokens open the responsive worker card screen directly for status and weight updates.
- scope:
  - `docs/modules/production-cards.md`
  - `services/productionCardPrintPage.js`
  - `public/worker-visual.html`
  - `test/client-auth-contract.test.js`
  - future: `modules/production-cards/README_HE.md`
  - future: `modules/production-cards/module.manifest.js`
- input:
  - approved order
  - steel-rebar shape snapshot
  - worker scan/photo
  - target weight and actual weight
- output:
  - production cards
  - print/reprint jobs
  - worker progress
  - weight deviation alerts
- logic:
  - כרטיסיות נוצרות רק מהזמנה מאושרת.
  - עובד רואה צורה, מידות, כמות, משקל רצוי וכפתורי פעולה — לא מלל ארוך.
  - משקל מצוי מושווה למשקל רצוי ומייצר התראת חריגה רכה.
  - צילום כרטיסייה מזהה כרטיס, לא יוצר הזמנה חדשה.
- definition_of_done:
  - manifest מלא.
  - API/screen/db/events מוגדרים.
  - mockup ויזואלי לתחנת עובד וניהול כרטיסיות.
  - אין תלות ב־server.js הישן.

### V2-011A — Production Card A4 Print Density

- status: done
- owner: codex-orders
- module: production-cards/orders
- priority: high
- scope:
  - `TASKS_V2.md`
  - `services/productionCardPrintPage.js`
  - `test/client-auth-contract.test.js`
- input:
  - בקשת מאיר: כרטיסייה היא בגודל 105 מ״מ רוחב × 75 מ״מ גובה, ולשאוף לפריסת 8 כרטיסיות בדף A4.
- output:
  - מצב הדפסה של כרטיסיות ייצור משתמש ב־A4 portrait.
  - מצב ההדפסה משתמש בכרטיסיות בגודל פיזי 105×75 מ״מ.
  - הגריד מוגדר ל־2 עמודות, ללא רווחים וללא שולי דף, כדי לנצל את A4 עד קצה המגבלה הפיזית.
- logic:
  - לא משנים יצירת כרטיסיות, פיצול כמות, ברקוד, מאסטר או סטטוסים.
  - השינוי חל רק ב־`@media print` כדי לא לפגוע בתצוגת המסך.
- definition_of_done:
  - `@page` מוגדר כ־A4 portrait.
  - מידת כרטיסייה מוגדרת ל־105×75 מ״מ.
  - בדיקת חוזה מגנה על מידות ההדפסה.
---

## ? אסור כרגע

- לא לתקן עוד מסכים במערכת הישנה בלי החלטה מפורשת.
- לא להוסיף משימות V2 לתוך `TASKS.md` הישן.
- לא לערבב קוד V2 עם server.js הישן.
- לא להעתיק DB schema ישן בלי אפיון ownership.

---

### V2-006AA - Shape Editor Downward Bar Preview Orientation

- status: done
- owner: codex-steel-rebar-shape-editor
- module: steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- input:
  - U/bar editor screenshot where 300/1000/300 appears standing on its side.
- output:
  - Generic 2D bar previews normalize display orientation so the dominant side is horizontal and the shape body sits downward.
- guardrails:
  - Display-only change in the shape editor.
  - No shape data, orders, pricing, production, OCR, or machine output changes.
- verification:
  - `node --test test\shape-geometry.test.js`


### V2-006AB - Shape Editor Bottom Base Orientation

- status: done
- owner: codex-steel-rebar-shape-editor
- module: steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- input:
  - U/bar editor screenshot where the long base appears at the top.
- output:
  - Generic 2D bar previews normalize display orientation so the dominant base side sits at the bottom.
- guardrails:
  - Display-only change in the shape editor.
  - No shape data, orders, pricing, production, OCR, or machine output changes.
- verification:
  - `node --test test\shape-geometry.test.js`


### V2-006AC - Shape Editor Visual Flip Control

- status: done
- owner: codex-steel-rebar-shape-editor
- module: steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- input:
  - Ambiguous bar orientation needs a manual flip option in the editor.
- output:
  - Shape editor exposes a visual-only flip button near the 2D/3D controls.
  - Flip changes the preview orientation without changing sides, angles, order data, or machine output.
- guardrails:
  - No UI redesign.
  - No new shapes or shape families.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- verification:
  - `node --test test\shape-geometry.test.js`

## ? הושלם

### V2-DOC-001 — מסמך אמת V2

- status: done
- owner: gpt
- artifact:
  - `docs/PROJECT_TRUTH_HE.md`
  - Google Docs: IronBend V2 - מסמך אמת מודולרי


### V2-006AD - Shape Editor Visual 90 Degree Rotation Control

- status: done
- owner: codex-steel-rebar-shape-editor
- module: steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- input:
  - The orientation control must rotate the whole preview by 90 degrees, not mirror it vertically.
- output:
  - Shape editor exposes a visual-only 90-degree rotation button near the 2D/3D controls.
  - Rotation changes only the preview orientation and labels together; sides, angles, quantity, order data, and machine output are unchanged.
- guardrails:
  - No UI redesign.
  - No new shapes or shape families.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`

### V2-006AE - New Order Item Shape Thumbnail Fallback

- status: done
- owner: codex-steel-rebar-shape-editor
- module: steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `public/index.html`
  - `test/shape-geometry.test.js`
- input:
  - Order item rows must show the visible shape in the right-side shape cell even when the item only has a length and no explicit `shapeSides`.
- output:
  - New-order item rows derive preview sides from `shapeSides`, Shape snapshot data, or length fallback.
  - Opening the Shape Editor from that row uses the same derived sides, so a length-only item opens as a visible straight bar instead of an empty/icon-only shape.
  - Shape Editor asset query is bumped for cloud cache refresh.
- guardrails:
  - No UI redesign.
  - No new shapes or shape families.
  - No Orders, Production, Pricing, Warehouse, OCR, API, or DB changes.
- verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`

### V2-006AF - Shape Editor Unified Asset Cache Version

- status: done
- owner: codex-production-cards-printing
- module: steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `public/index.html`
  - `public/orders.html`
  - `public/intake.html`
  - `public/customer.html`
  - `test/order-shape-editor-add.test.js`
  - `test/shape-geometry.test.js`
- input:
  - Runtime screens were loading different `shape-editor.js` cache versions, causing inconsistent shape visuals between order, intake, customer, and production-related flows.
- output:
  - All active screens load `shape-editor.js?v=56`.
  - Existing version-contract tests were updated to protect the unified cache version.
- guardrails:
  - Cache-bust only.
  - No shape engine, order lifecycle, production workflow, OCR logic, portal logic, pricing, finance, warehouse, API, or DB changes.
- verification:
  - `node --test test\order-shape-editor-add.test.js test\client-auth-contract.test.js`


---


### V2-006AI - Pile Cage Foundation Elements And Hoop Controls

- status: done
- owner: codex-steel-rebar-shape-editor
- module: steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- input:
  - Pile cage editor must show the foundation elements that compose the cage.
  - Internal hoop controls must be compact and edited from one row: enabled, bar diameter, spacing, start, end, and start side.
  - Internal hoop diameter must be derived from cage diameter and longitudinal bar diameter, without hidden concrete-cover subtraction.
- output:
  - Pile cage editor shows a compact element breakdown for longitudinal bars, spiral zones, internal hoops, and per-bar overrides.
  - Internal hoop controls are consolidated into one compact row with a start-side selector.
  - Hoop positions are calculated from the selected side and included in manufacturing breakdown.
- guardrails:
  - No Orders, Production, Pricing, Warehouse, OCR, Portal, API, or DB changes.
  - No new shape families.
  - No full UI redesign.
- verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`
  - `node --test test\pile-cage-engine.test.js`

---

### V2-011D ג€” Worker Dashboard Inline Production Controls

- status: done
- owner: codex-production-cards-printing
- module: production-cards / worker-dashboard
- scope:
  - `TASKS_V2.md`
  - `public/worker-visual.html`
  - `test/client-auth-contract.test.js`
- goal:
  - Worker can update card status, produced quantity, actual weight, and notes directly on each visible card.
  - No modal or collapsed details section is required for the core worker update flow.
- guardrails:
  - Preserve existing production APIs and status flow.
  - Do not change Orders, Finance, Portal, OCR, Warehouse, or Shape V2 contract.
  - No database migration.
- verification:
  - Worker visual contract test covers inline controls and prevents reverting to collapsed worker-more details.

---

### V2-011E ג€” Auto-sync Order Status From Production Item Status

- status: done
- owner: codex-production-cards-printing
- module: production-cards / worker-dashboard
- scope:
  - `TASKS_V2.md`
  - `routes/production.js`
  - `test/production-item-boundaries.test.js`
- goal:
  - Updating a production card to in-production automatically moves the parent order to in-production.
  - Completing the final production card automatically moves the parent order to done / waiting pickup.
  - Worker-visible item statuses stay aligned with server-side allowed production statuses.
- guardrails:
  - Preserve Orders lifecycle transition contract.
  - Do not change Finance, Portal, OCR, Warehouse, or Shape V2 contract.
  - No database migration.
- verification:
  - Production boundary tests cover automatic order status sync from item status updates.

---

### V2-011F - Canonical Server Shape SVG For Display Views

- status: done
- owner: codex-production-cards-printing
- module: production-cards / printing / order-detail
- scope:
  - `TASKS_V2.md`
  - `server.js`
  - `routes/orders.js`
  - `routes/orderDocuments.js`
  - `routes/orderPrintA4.js`
  - `public/orders.html`
  - `test/client-auth-contract.test.js`
- goal:
  - Order detail and A4 production/document display views prefer the canonical server-rendered production shape SVG.
  - Shape Editor remains the editing surface; display-only views do not each invent their own drawing.
  - Legacy client drawing remains only as fallback when no server SVG is available.
- guardrails:
  - Preserve Production workflow, Orders lifecycle, QR routing, Finance, Portal, OCR, Warehouse, and Shape V2 contract.
  - No database migration.
- verification:
  - `node --test test\client-auth-contract.test.js`
  - `npm test`


---

### V2-006AG - Pile Cage Engineering Engine Slice

- status: in_progress
- owner: codex-steel-rebar-shape-editor
- module: steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `modules/steel-rebar/pile-cage-engine.js`
  - `test/pile-cage-engine.test.js`
- input:
  - Pile cage is an engineering product, not a generic bent-bar shape.
  - Primary module is Shapes / Engineering Engine, not Orders, Production, Printing, OCR, Pricing, Finance, Portal, or DB.
  - Default spiral pitch mode is uniform; zones must cover the active spiral length when enabled.
  - No-spiral gaps are allowed only at the start/end, not in the middle.
  - Longitudinal bars may use uniform, alternating, grouped, or individual diameter/type patterns.
- output:
  - PileCageModel returns `general`, `longitudinalBars`, `spiral`, `hoops`, `calculations`, `manufacturingBreakdown`, `validation`, and `views`.
  - Shape V2 envelope is preserved with `shapeType = round_pile_cage`, `family = piles`, `machineOutput`, and legacy compatibility fields.
  - No A4 screen, production card, live Shape Editor UI, or cross-module rewrite is included in this slice.
- guardrails:
  - Do not change Orders, Production, Printing, Pricing, Warehouse, OCR, API, DB, Portal, or live Shape Editor UI.
  - Do not add new shape families.
  - Keep this as pile-cage-only engineering model groundwork before mesh work.
- verification:
  - `node --check modules\steel-rebar\pile-cage-engine.js`
  - `node --test test\pile-cage-engine.test.js`

---

### V2-006AH - Pile Cage Shape Editor 2D Engineering Preview

- status: done
- owner: codex-steel-rebar-shape-editor
- module: steel-rebar/shape-editor
- priority: high
- scope:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- input:
  - Stage A: make the pile cage preview look like the engineering reference without adding 3D.
  - Use the existing Shape Editor screen and the existing PileCageEngine renderer only.
- latest_change:
  - Pile cage editor dimensions are treated as centimeters and converted to millimeters for contract/calculation output; drawing pitch values are read-only labels.
  - Pile cage editor now labels every rebar diameter explicitly and derives the internal hoop/ring diameter from pile diameter, cover, and longitudinal bar diameter.
- output:
  - Pile cage preview draws a large side view with L, zone dimensions, pitch labels, spiral loops, hoops, and D.
  - Pile cage preview draws a top/cross-section view with longitudinal bars, D, and spiral diameter.
  - 3D helper output is intentionally removed from this stage.
- guardrails:
  - No Orders, Production, Printing/A4/cards, OCR, API, DB, Pricing, Portal, or Warehouse changes.
  - No new shape families.
  - No 3D work in this stage.
- verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js test\pile-cage-engine.test.js`

---
### V2-011G - Unit Progress For Pile Cages

- status: done
- owner: codex-production-cards-printing
- module: production-cards / worker-dashboard
- scope:
  - `TASKS_V2.md`
  - `routes/production.js`
  - `public/worker-visual.html`
  - `test/production-item-boundaries.test.js`
  - `test/client-auth-contract.test.js`
  - `test/module-governance.test.js`
- goal:
  - Pile cage / unit-based production can update produced quantity per completed unit.
  - Partial produced quantity moves released work into production without completing the whole item.
  - Full produced quantity completes the item and lets existing order completion logic run.
- guardrails:
  - Do not change Orders lifecycle, Finance, Portal, OCR, Warehouse, or Shape V2 contract.
  - No database migration.
- verification:
  - `node --test test\production-item-boundaries.test.js test\client-auth-contract.test.js test\module-governance.test.js`
  - `npm test`


---

### V2-011H - Pile Cage Production Card Breakdown

- status: done
- owner: codex-production-cards-printing
- module: production-cards / pile-cages
- scope:
  - `TASKS_V2.md`
  - `modules/steel-rebar/pile-cage-engine.js`
  - `services/productionCardPrintPage.js`
  - `public/worker-visual.html`
  - `test/pile-cage-engine.test.js`
  - `test/production-print-page.test.js`
- goal:
  - Pile cage items print one master card for each pile unit.
  - Each pile unit also prints production component cards from the pile cage manufacturing breakdown.
  - Component cards keep QR routing to the parent production item while carrying pile unit/component suffixes.
- guardrails:
  - No database migration.
  - Do not change Orders lifecycle, Finance, Portal, OCR, Warehouse, or pricing.
- verification:
  - `node --check modules\steel-rebar\pile-cage-engine.js`
  - `node --test test\pile-cage-engine.test.js test\production-print-page.test.js`

---

### V2-011I - Pile Component Shape Visuals Use Engine Output

- status: done
- owner: codex-production-cards-printing
- module: production-cards / pile-cages / printing
- scope:
  - `TASKS_V2.md`
  - `services/productionCardPrintPage.js`
  - `services/productionCards.js`
  - `public/shape-editor.js`
  - `test/production-print-page.test.js`
  - `test/shape-geometry.test.js`
- goal:
  - Pile cage component cards do not fall back to straight-bar drawing for spiral and hoop components.
  - Printed cards prefer the shape SVG produced by the shape contract / shape engine when available.
  - Shape Editor pile contract exposes manufacturing breakdown and production card metadata from the pile cage engine.
- guardrails:
  - Preserve production status flow, QR routing, Orders lifecycle, Finance, Portal, OCR, Warehouse, Pricing, and DB schema.
  - No UI redesign.
- verification:
  - `node --check public\shape-editor.js`
  - `node --check services\productionCardPrintPage.js`
  - `node --check services\productionCards.js`
  - `node --test test\shape-geometry.test.js test\pile-cage-engine.test.js test\production-print-page.test.js`
  - `npm test`

---

### V2-011J - Server Spiral Item Shape Rendering

- status: done
- owner: codex-production-cards-printing
- module: production-cards / order-display / printing
- scope:
  - `TASKS_V2.md`
  - `services/productionCards.js`
  - `services/productionCardPrintPage.js`
  - `routes/orders.js`
  - `routes/production.js`
  - `routes/orderPrintA4.js`
  - `routes/orderDeliveryCertificate.js`
  - `test/shape-geometry.test.js`
  - `test/client-auth-contract.test.js`
- goal:
  - Display and print views recognize saved spiral items from item fields or legacy shape snapshots.
  - Spiral items no longer fall back to straight-bar SVG when `segments` is empty.
  - Existing saved spiral rows work retroactively when `spiral_diameter_mm` and `spiral_turns` are present.
- guardrails:
  - Preserve Orders lifecycle, Production status flow, QR routing, Shape V2 contract, Finance, Portal, OCR, Warehouse, Pricing, and DB schema.
  - No UI redesign.
- verification:
  - `node --check services\productionCards.js`
  - `node --check routes\orders.js routes\production.js routes\orderPrintA4.js routes\orderDeliveryCertificate.js services\productionCardPrintPage.js`
  - `node --test test\client-auth-contract.test.js test\production-print-page.test.js test\security-routes.test.js`


---

### V2-011K - Spiral Shape Editor Order Handoff

- status: done
- owner: codex-production-cards-printing
- primary_module: Production / Cards / Printing + Shape Editor handoff
- files:
  - `public/index.html`
  - `services/orderContracts.js`
  - `test/client-auth-contract.test.js`
  - `test/security-routes.test.js`
- goal:
  - New order rows preserve approved Shape V2 contracts from the shape editor.
  - Spiral items keep bar diameter, spiral diameter, turns, and total length from the editor instead of becoming straight length rows.
  - Spiral bar diameter is edited through the shape editor; the order table reflects it and opens the editor for changes.
- guardrails:
  - Preserve Orders lifecycle, Production status flow, QR routing, Shape V2 contract, Finance, Portal, OCR, Warehouse, Pricing, and DB schema.
  - No UI redesign.
- verification:
  - `node --test test\client-auth-contract.test.js`
  - `node --test test\security-routes.test.js`
  - `index.html` inline script syntax check
---

### V2-011L - Spiral Production Card Visual Labels

- status: done
- owner: codex-production-cards-printing
- primary_module: Production / Cards / Printing
- files:
  - `services/productionCards.js`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- goal:
  - Spiral production cards visually distinguish spiral diameter from turn count.
  - Printed cards show fixed visual labels for spiral diameter and wrap count instead of unclear English shorthand.
  - Pile cage internal hoop/ring visual calculation stays aligned with pile diameter, cover, and longitudinal bar diameter.
- guardrails:
  - Preserve 8-per-A4 card grid, QR routing, Production status flow, Orders lifecycle, Shape V2 contract, Finance, Portal, OCR, Warehouse, Pricing, and DB schema.
  - No UI redesign.
- verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`
  - `npm test`
---

### V2-011M - Pile Cage Editor Live Derived Rows

- status: done
- owner: codex-production-cards-printing
- primary_module: Production / Cards / Printing + Shape Editor handoff
- files:
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- latest_change:
  - Compact pile-cage editor rows reduce empty vertical space in the parameter panel.
  - Longitudinal bars now support editable per-bar overrides for bar number, diameter, straight/L shape, and L-leg length.
- goal:
  - Pile cage internal hoop/ring diameter updates immediately when pile diameter or bar diameter changes.
  - Straight longitudinal bars do not show an L-leg field.
  - Mixed longitudinal bars show separate visual editors for bar A and bar B.
- guardrails:
  - Preserve Production status flow, QR routing, Orders lifecycle, Finance, Portal, OCR, Warehouse, Pricing, and DB schema.
  - No module rewrite.
- verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`
  - `npm test`


---

### V2-011O - Worker Dashboard Canonical Shape SVG Only

- status: done
- owner: codex-production-cards-printing
- primary_module: Production / Cards / Printing + Shape Editor handoff
- files:
  - `public/worker-visual.html`
  - `test/client-auth-contract.test.js`
- goal:
  - Worker collection cards no longer use a separate local shape drawing fallback.
  - Worker display prefers server-provided `shape_svg`; if missing, it shows an explicit missing-shape placeholder instead of a wrong shape.
- guardrails:
  - Preserve Production status flow, QR routing, Orders lifecycle, Finance, Portal, OCR, Warehouse, Pricing, and DB schema.
  - No UI redesign beyond removing inconsistent fallback drawing.
- verification:
  - `node --test test\client-auth-contract.test.js`
---

### V2-011N - Worker Dashboard Canonical Shape Feed

- status: done
- owner: codex-production-cards-printing
- primary_module: Production / Cards / Printing
- files:
  - `routes/production.js`
  - `test/client-auth-contract.test.js`
- goal:
  - Worker card collection dashboard receives the same shape contract fields used by printed cards and order displays.
  - Dashboard shape visuals prefer the server-rendered production shape SVG, including spiral and pile-derived shapes.
  - Local drawing in `worker-visual.html` remains fallback only when no canonical SVG is returned.
- guardrails:
  - Preserve Production status flow, QR routing, Orders lifecycle, Finance, Portal, OCR, Warehouse, Pricing, and DB schema.
  - No UI redesign.
- verification:
  - `node --check routes\production.js`
  - `node --test test\client-auth-contract.test.js`
  - `npm test`

---

### V2-011P - Public Worker Card Scan Updates

- status: done
- owner: codex-production-cards-printing
- primary_module: Production / Cards / Printing
- files:
  - `routes/production.js`
  - `public/worker-visual.html`
  - `test/production-item-boundaries.test.js`
  - `test/client-auth-contract.test.js`
  - `test/route-auth-coverage.test.js`
- goal:
  - A worker scanning a production card QR can open that specific card without logging in.
  - Public scan mode can update only production-owned card fields: status, produced quantity, actual weight, and notes.
  - Full production queue and other system screens remain behind normal role-based authentication.
- guardrails:
  - Preserve Orders lifecycle, Production status gates, QR routing, Shape V2 contract, Finance, Portal, OCR, Warehouse, Pricing, and DB schema.
  - Do not expose the full worker queue without authentication.
  - Temporary/no-login QR update mode only until worker permissions are finalized.
- verification:
  - `node --check routes\production.js`
  - `node --test test\production-item-boundaries.test.js test\client-auth-contract.test.js test\route-auth-coverage.test.js`
  - `npm test`

---

### V2-006AJ - Pile Cage Hoop Row Readability

- status: done
- owner: codex-steel-rebar-shape-editor
- primary_module: steel-rebar / shape-editor / piles
- files:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
- goal:
  - Make the pile cage internal hoop row readable by giving the right parameter panel more width and reducing compact-row chrome.
  - Preserve the existing editor flow, pile calculations, rendering engine, and shape families.
- guardrails:
  - No Orders, Production lifecycle, Pricing, Portal, Warehouse, DB, or machine integration changes.
  - No redesign and no new shape family.
- verification:
  - `node --check public\shape-editor.js`

---

### V2-011Q - Production Card Proportional Short Bend Rendering

- status: done
- owner: codex-production-cards-printing
- primary_module: Production / Cards / Printing + Shape Editor handoff
- files:
  - `TASKS_V2.md`
  - `services/productionCards.js`
  - `services/productionCardPrintPage.js`
  - `test/shape-geometry.test.js`
- goal:
  - Production card drawings keep short bent legs visually readable when a very long bar segment would otherwise flatten them.
  - Printed labels and calculated lengths remain true to the real dimensions; only the drawing scale gets a visual minimum for extreme ratios.
- guardrails:
  - Preserve Orders lifecycle, Production status flow, QR routing, Shape V2 contract, Finance, Portal, OCR, Warehouse, Pricing, and DB schema.
  - No UI redesign and no new shape families.
- verification:
  - `node --check services\productionCards.js`
  - `node --check services\productionCardPrintPage.js`
  - `node --test test\shape-geometry.test.js`
  - `node --test test\production-print-page.test.js`

---

### V2-006AK - Pile Cage Hoop Row Marker Cleanup

- status: done
- owner: codex-steel-rebar-shape-editor
- primary_module: steel-rebar / shape-editor / piles
- files:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
- goal:
  - Remove the small field codes and marker bubbles from the internal hoop compact row so the values remain readable.
  - Hide marker icons/codes across the pile cage parameter table.
  - Do not display pitch markers for zones marked no-wrap.
- guardrails:
  - No Orders, Production lifecycle, Pricing, Portal, Warehouse, DB, or rendering engine changes.
- verification:
  - `node --check public\shape-editor.js`
---

### V2-006AL - Pile Cage Engineering Workspace Slice

- status: done
- owner: codex-steel-rebar-shape-editor
- primary_module: steel-rebar / shape-editor / piles
- files:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
- goal:
  - Make the pile cage editor feel closer to an engineering workspace by giving the canvas more width and moving properties into grouped sections.
  - Keep the work parameter-driven and preserve the existing PileCageEngine calculations and renderer.
- guardrails:
  - No Orders, OCR, Worker, Printing, Pricing, Finance, Warehouse, Portal, Shape Contract, API, or DB schema changes.
  - No 3D implementation in this slice.
- verification:
  - `node --check public\shape-editor.js`
---

### V2-006AM - Pile Cage Editor Usability Fix

- status: done
- owner: codex-steel-rebar-shape-editor
- primary_module: steel-rebar / shape-editor / piles
- files:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- goal:
  - Make the current pile cage editor usable with readable accordion sections, summaries, validation feedback, and section-to-drawing focus.
  - Preserve the current data model, calculations, shape contract, APIs, and renderer.
- guardrails:
  - No Orders, OCR, Worker, Printing, Pricing, Finance, Warehouse, Portal, Shape Contract, API, or DB schema changes.
  - No 3D and no full editor rewrite.
- verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`
---

### V2-006AN - Pile Cage Panel Clipping Cleanup

- status: done
- owner: codex-steel-rebar-shape-editor
- primary_module: steel-rebar / shape-editor / piles
- files:
  - `TASKS_V2.md`
  - `public/shape-editor.js`
  - `test/shape-geometry.test.js`
- goal:
  - Stop pile cage accordion sections from clipping internal hoops and production breakdown content.
  - Reduce wasted empty space inside pile cage editor sections by making full-width rows actually span the panel.
- guardrails:
  - No Orders, OCR, Worker, Printing, Pricing, Finance, Warehouse, Portal, Shape Contract, API, DB, renderer, or calculation changes.
- verification:
  - `node --check public\shape-editor.js`
  - `node --test test\shape-geometry.test.js`

---

### V2-006AP - Pile Cage Hoop Diameter And Weld Spacing

- status: done
- owner: codex-steel-rebar-shape-editor
- primary_module: steel-rebar / shape-editor / piles
- files:
  - `TASKS_V2.md`
  - `modules/steel-rebar/pile-cage-engine.js`
  - `public/shape-editor.js`
  - `test/pile-cage-engine.test.js`
  - `test/shape-geometry.test.js`
- goal:
  - Calculate internal hoop diameter from pile diameter minus spiral bar and longitudinal bars on both sides.
  - Expose hoop cut length, longitudinal bar center-to-center spacing, and clear spacing for production/welding.
  - Keep the pile cage editor focused on existing pile fields without redesigning other modules.
- guardrails:
  - No Orders, OCR, Worker, Printing, Pricing, Finance, Warehouse, Portal, DB, or unrelated module changes.
  - No new shape families and no 3D implementation.
- verification:
  - `node --check public\shape-editor.js`
  - `node --check modules\steel-rebar\pile-cage-engine.js`
  - `node --test test\shape-geometry.test.js`
  - `node --test test\pile-cage-engine.test.js`
