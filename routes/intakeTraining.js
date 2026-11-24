const router = require('express').Router();

function required(name, value) {
  if (value === undefined || value === null) throw new Error(`routes/intakeTraining missing dependency: ${name}`);
  return value;
}

module.exports = function createIntakeTrainingRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);

  router.get('/intake/training', requireAnyRole(['manager', 'admin']), (req, res) => {
    const rows = db.prepare(`
      SELECT id, title, document_type, problem_text, correction_text, active, created_at
      FROM intake_training_examples
      WHERE active=1
      ORDER BY id DESC
      LIMIT 100
    `).all();
    res.json(rows);
  });

  router.post('/intake/training', requireAnyRole(['manager', 'admin']), (req, res) => {
    const body = req.body || {};
    const title = String(body.title || '').trim();
    const documentType = String(body.document_type || 'general').trim() || 'general';
    const problemText = String(body.problem_text || '').trim();
    const correctionText = String(body.correction_text || '').trim();
    if (!title || !problemText || !correctionText) {
      return res.status(400).json({ error: 'title, problem_text and correction_text are required' });
    }
    const result = db.prepare(`
      INSERT INTO intake_training_examples (title, document_type, problem_text, correction_text)
      VALUES (?, ?, ?, ?)
    `).run(title.slice(0, 120), documentType.slice(0, 60), problemText.slice(0, 1200), correctionText.slice(0, 1200));
    res.json({ success: true, id: result.lastInsertRowid });
  });

  router.delete('/intake/training/:id', requireAnyRole(['manager', 'admin']), (req, res) => {
    const result = db.prepare('UPDATE intake_training_examples SET active=0 WHERE id=? AND active=1').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'דוגמת ההדרכה לא נמצאה' });
    res.json({ success: true });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  "id": "intake-training",
  "label": "Intake Training",
  "consumes": [
    {
      "table": "intake_training"
    }
  ],
  "produces": []
};
