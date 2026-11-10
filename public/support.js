(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const state = { currentSession: null, poller: null, consolePoller: null, frame: null };
  const user = window.IronBendAuth?.currentUser?.() || {};
  const operator = user.role === 'admin';
  $('#support-user').textContent = user.username ? `${user.username} · ${user.role || 'user'}` : 'נדרשת התחברות';
  $('#operator-card').hidden = !operator;

  async function api(path, init = {}) {
    const response = await fetch(path, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.user_message || body.error || 'support_request_failed');
    return body;
  }

  function message(id, value = '') { value=window.IronBendMessages?.text(value)??value; $(id).textContent = value; }
  function statusLabel(status) {
    return ({ requested:'ממתין להפעלה', agent_ready:'מסך משותף', control_requested:'ממתין לאישור שליטה', control_granted:'שליטה אושרה', ended:'הסתיים', expired:'פג תוקף', rejected:'נדחה' })[status] || status;
  }
  function renderSessions(sessions) {
    const holder = $('#session-list');
    holder.replaceChildren();
    if (!sessions.length) { holder.textContent = 'אין סשנים קודמים.'; return; }
    for (const session of sessions) {
      const line = document.createElement('div'); line.className = 'session-row';
      const left = document.createElement('span'); left.textContent = `#${session.id} · ${new Date(session.created_at).toLocaleString('he-IL')}`;
      const status = document.createElement('span'); status.className = `state ${session.status}`; status.textContent = statusLabel(session.status);
      line.append(left, status); holder.append(line);
    }
  }
  async function loadSessions() {
    try { renderSessions((await api('/api/remote-support/sessions')).sessions || []); } catch (error) { message('#request-message', error.message); }
  }
  async function createSession() {
    message('#request-message');
    try {
      const result = await api('/api/remote-support/sessions', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      state.currentSession = result.session;
      $('#support-code').textContent = result.support_code;
      $('#expires-at').textContent = `בתוקף עד ${new Date(result.session.expires_at).toLocaleTimeString('he-IL')}`;
      $('#request-result').hidden = false;
      await loadSessions();
    } catch (error) { message('#request-message', error.message); }
  }
  async function downloadAgent() {
    try {
      const link = document.createElement('a');
      link.href = '/downloads/IronBend-Support.exe';
      link.download = 'IronBend-Support.exe';
      document.body.append(link); link.click(); link.remove();
    } catch (error) { message('#request-message', error.message); }
  }
  async function claimSession() {
    try {
      const support_code = $('#claim-code').value.trim();
      const result = await api('/api/remote-support/claim', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ support_code }) });
      state.currentSession = result.session; $('#operator-session').hidden = false; message('#operator-message');
      pollConsole();
    } catch (error) { message('#operator-message', error.message); }
  }
  function renderConsole(result) {
    const session = result.session; state.currentSession = session;
    $('#operator-status').textContent = statusLabel(session.status);
    $('#request-control').disabled = session.status !== 'agent_ready';
    const image = $('#remote-screen'); const placeholder = $('#screen-placeholder');
    if (result.frame?.data) { state.frame = result.frame; image.src = result.frame.data; image.hidden = false; placeholder.hidden = true; }
    else { image.hidden = true; placeholder.hidden = false; placeholder.textContent = session.status === 'expired' ? 'פג תוקף הסשן.' : 'ממתין לאישור שיתוף מסך במפעל…'; }
  }
  async function pollConsole() {
    if (!state.currentSession || !operator) return;
    try {
      const result = await api(`/api/remote-support/sessions/${state.currentSession.id}/console`);
      renderConsole(result);
      if (['ended','expired','rejected'].includes(result.session.status)) { clearInterval(state.consolePoller); return; }
    } catch (error) { message('#operator-message', error.message); }
  }
  async function requestControl() {
    try { await api(`/api/remote-support/sessions/${state.currentSession.id}/request-control`, { method:'POST' }); await pollConsole(); }
    catch (error) { message('#operator-message', error.message); }
  }
  async function endSession() {
    if (!state.currentSession || !confirm('לסיים תמיכה מרחוק עכשיו?')) return;
    try { await api(`/api/remote-support/sessions/${state.currentSession.id}/end`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ reason:'operator_ended' }) }); await pollConsole(); await loadSessions(); }
    catch (error) { message('#operator-message', error.message); }
  }
  async function sendCommand(command) {
    if (!state.currentSession || state.currentSession.status !== 'control_granted') return;
    try { await api(`/api/remote-support/sessions/${state.currentSession.id}/commands`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(command) }); }
    catch (error) { message('#operator-message', error.message); }
  }
  $('#create-session').addEventListener('click', createSession);
  $('#download-agent').addEventListener('click', downloadAgent);
  $('#claim-session')?.addEventListener('click', claimSession);
  $('#request-control')?.addEventListener('click', requestControl);
  $('#end-session')?.addEventListener('click', endSession);
  $('#remote-key')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); const key = event.target.value.trim(); if (key) { sendCommand({ type:'key', key }); event.target.value = ''; } } });
  $('#remote-screen')?.addEventListener('click', event => {
    if (!state.frame || state.currentSession?.status !== 'control_granted') return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width * state.frame.width;
    const y = (event.clientY - box.top) / box.height * state.frame.height;
    sendCommand({ type:'pointer', action:'left_click', x, y });
  });
  state.poller = setInterval(loadSessions, 6000); loadSessions();
  if (operator) state.consolePoller = setInterval(pollConsole, 1000);
})();
