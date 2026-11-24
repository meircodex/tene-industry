'use strict';

/**
 * routes/access.js — Module-based permission matrix API
 *
 * GET  /api/access/me     — screens visible to my role (for nav + page guard)
 * GET  /api/access/matrix — full matrix for admin (role × screen)
 * PUT  /api/access/matrix — save override for (screen, role, level)
 */

function createAccessRouter({ requireRole, accessControl }) {
  if (!requireRole)     throw new Error('routes/access missing dependency: requireRole');
  if (!accessControl)   throw new Error('routes/access missing dependency: accessControl');

  const express = require('express');
  const router  = express.Router();

  // GET /api/access/me — returns screens + access level for the caller's role
  router.get('/access/me', requireRole('viewer'), (req, res) => {
    const role = req.userRole || req.auth?.role;
    if (!role) return res.status(401).json({ error: 'Authentication required' });
    const screens = accessControl.screensForRole(role);
    res.json({ role, screens });
  });

  // GET /api/access/matrix — full role × screen matrix (admin only)
  router.get('/access/matrix', requireRole('admin'), (req, res) => {
    res.json(accessControl.matrix());
  });

  // PUT /api/access/matrix — save an override { screenId, role, level }
  router.put('/access/matrix', requireRole('admin'), (req, res) => {
    const { screenId, role, level } = req.body || {};
    if (!screenId || !role || !level) {
      return res.status(400).json({ error: 'screenId, role, level are required' });
    }
    try {
      accessControl.applyOverride(screenId, role, level);
      res.json({ success: true, screenId, role, level });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createAccessRouter;

module.exports.manifest = {
  id: 'access',
  label: 'הרשאות',
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  consumes: [],
  produces: [],
};
