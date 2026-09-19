// frontend/js/api.js
(function () {
  const { useState, useEffect } = React;

  // ---- seat metadata (Roster + Agent page share this) ----------------------
  const SEATS = [
    { id: "chief_of_staff",     name: "Chief of Staff",     role: "Compiles every seat from its job description", location: "studio_edge",  color: "#07234F", initials: "CS" },
    { id: "it_expert",          name: "IT Expert",          role: "Builds the connectors every seat needs",        location: "studio_edge",  color: "#5B6B85", initials: "IT" },
    { id: "l_addetto_iva",      name: "L'Addetto IVA",      role: "VAT Clerk — validates the periodic batch",      location: "studio_edge",  color: "#0A63E0", initials: "IV" },
    { id: "il_classificatore",  name: "Il Classificatore",  role: "Resolves the low-confidence tail",              location: "studio_edge",  color: "#6C5CE7", initials: "CL" },
    { id: "l_amministrativo",   name: "L'Amministrativo",   role: "Admin Assistant — runs at the client",          location: "client_side",  color: "#F08000", initials: "AM" },
    { id: "lo_smistatore",      name: "Lo Smistatore",      role: "Dispatcher — routes typed A2A messages",        location: "studio_edge",  color: "#0EA5A5", initials: "SM" },
    { id: "l_archivista",       name: "L'Archivista",       role: "Turns confirmed fixes into durable rules",      location: "studio_edge",  color: "#1F9D6B", initials: "AR" },
  ];
  const SEAT_BY_ID = SEATS.reduce((acc, s) => { acc[s.id] = s; return acc; }, {});
  const AGENT_COLOR = Object.assign({ teamsystem: "#93A1B8" }, SEATS.reduce((acc, s) => { acc[s.id] = s.color; return acc; }, {}));

  // ---- A2A message type -> how it reads at a glance -------------------------
  const A2A_TYPE_META = {
    pack_delivered:            { label: "pack delivered",          bg: "#E4F6EE", fg: "#177355" },
    document_delivered:        { label: "document delivered",      bg: "#E4F6EE", fg: "#177355" },
    item_missing:              { label: "item missing",            bg: "#FDEEDC", fg: "#9A5B12" },
    question_for_studio:       { label: "question for studio",     bg: "#E7F0FD", fg: "#0A63E0" },
    instruction_from_studio:   { label: "instruction from studio", bg: "#EAF0FB", fg: "#07234F" },
    answer_with_evidence:      { label: "answer with evidence",    bg: "#E7F0FD", fg: "#0A63E0" },
    escalation_requested:      { label: "escalation requested",    bg: "#FBEAE8", fg: "#C0473C" },
    acknowledgment:            { label: "acknowledgment",          bg: "#F6F8FC", fg: "#5B6B85" },
  };

  // ---- SSE bus ---------------------------------------------------------------
  // Subscribes once, buckets every event by its channel, and reports whether
  // the connection is currently live so the UI can show it honestly.
  function useBus() {
    const [ev, setEv] = useState({ a2a: [], feed: [], board: [], evidence: [], knowledge: [], coa: [], gate: [], ladder: [] });
    const [live, setLive] = useState(false);
    useEffect(() => {
      const es = new EventSource("/events");
      es.onopen = () => setLive(true);
      es.onerror = () => setLive(false);
      es.onmessage = (m) => {
        const e = JSON.parse(m.data);
        setEv((s) => ({ ...s, [e.channel]: [...(s[e.channel] || []), e] }));
      };
      return () => es.close();
    }, []);
    return { ev, live };
  }

  // Authoritative pending count for the sidebar badge 
  function usePendingCount(refreshKey) {
    const [count, setCount] = useState(0);
    useEffect(() => {
      let cancelled = false;
      const refresh = () => Promise.all([getGates(), getDocumentRequests()])
        .then(([gates, docReqs]) => { if (!cancelled) setCount(gates.length + docReqs.length); })
        .catch(() => {});
      refresh();
      const id = setInterval(refresh, 4000); // safety net if the SSE stream drops
      return () => { cancelled = true; clearInterval(id); };
    }, [refreshKey]);
    return count;
  }

  // ---- REST calls --------------------------------------------------------
  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
  }
  async function postJSON(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
  }

  const runDemo               = () => getJSON("/api/run-demo");
  const getGates               = () => getJSON("/api/gates");
  const approveGate            = (id, approvedBy) => postJSON(`/api/gate/${id}/approve`, { approvedBy });
  const denyGate                = (id, reason) => postJSON(`/api/gate/${id}/deny`, { reason });
  const getDocumentRequests    = () => getJSON("/api/document-requests");
  const resolveDocumentRequest = (id, sdiId) => postJSON(`/api/document-requests/${id}/resolve`, { sdiId });
  const getQuestions           = () => getJSON("/api/questions");
  const resolveQuestion        = (id, answer, evidenceId) => postJSON(`/api/questions/${id}/resolve`, { answer, evidenceId });
  const compileSeat = (seatId, jobText) =>
    jobText && jobText.trim() ? postJSON(`/api/compile/${seatId}`, { jobText }) : getJSON(`/api/compile/${seatId}`);
  const deliverPack = (clientId, period) => postJSON(`/api/deliver-pack/${encodeURIComponent(clientId)}/${encodeURIComponent(period)}`, {});
  const getRuntimeStatus = (clientId) => getJSON(`/api/runtime-status/${encodeURIComponent(clientId)}`);
  const testSkill = (skill, clientId, skills, args) => postJSON(`/api/test-skill`, { skill, clientId, skills, args });

  // Shared config for the Agent page's skill sandbox — 
  // one entry per one of L'Amministrativo's 7 skills
  const SKILL_TEST_CONFIG = [
    { id: "raccolta_documenti", label: "Document collection", fields: [
        { key: "supplier", label: "Supplier", default: "Verdi Srl" },
        { key: "period", label: "Period", default: "2026-Q3" },
        { key: "docType", label: "Doc type", default: "invoice" },
      ] },
    { id: "fatturazione", label: "Invoicing (opens a gate)", fields: [
        { key: "customer", label: "Customer", default: "Cliente Demo Srl" },
        { key: "amount", label: "Amount", default: "500" },
      ] },
    { id: "incassi_e_solleciti", label: "Collections & reminders", fields: [
        { key: "name", label: "Debtor name", default: "Cliente Ritardatario" },
        { key: "amount", label: "Amount", default: "300" },
        { key: "due", label: "Due date", default: "2026-10-01" },
      ] },
    { id: "presenze_note_spese", label: "Attendance & expenses", fields: [
        { key: "id", label: "Entry id", default: "spesa-test" },
        { key: "amount", label: "Amount", default: "50" },
        { key: "note", label: "Note", default: "Test expense" },
      ] },
    { id: "sportello_dipendenti", label: "Employee desk", fields: [
        { key: "employee", label: "Employee", default: "employee_1" },
        { key: "question", label: "Question", default: "Can I deduct this?" },
      ] },
    { id: "scadenze_pagamenti", label: "Deadlines & payments", fields: [
        { key: "what", label: "What", default: "F24" },
        { key: "due", label: "Due date", default: "2026-09-20" },
        { key: "reminderWindowDays", label: "Reminder window (days)", default: "30" },
      ] },
    { id: "domande_allo_studio", label: "Questions to the studio", fields: [
        { key: "topic", label: "Topic", default: "test_topic" },
        { key: "body", label: "Body", default: "A test question." },
      ] },
  ];

  function useNowTick(intervalMs = 5000) {
    const [, setTick] = useState(0);
    useEffect(() => {
      const id = setInterval(() => setTick((t) => t + 1), intervalMs);
      return () => clearInterval(id);
    }, [intervalMs]);
  }

  // ---- small formatting helpers ----------------------------------------
  function timeAgo(iso) {
    if (!iso) return "";
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
  }

  // Hand-rolled JSON syntax highlighter
  function tokenizeJSON(value) {
    const json = JSON.stringify(value, null, 2);
    const regex = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;
    const tokens = [];
    let lastIndex = 0;
    let m;
    while ((m = regex.exec(json)) !== null) {
      if (m.index > lastIndex) tokens.push({ cls: null, text: json.slice(lastIndex, m.index) });
      const token = m[0];
      let cls = "n"; // number, default
      if (/^"/.test(token)) cls = /:\s*$/.test(token) ? "k" : "s";
      else if (/^(true|false)$/.test(token)) cls = "b";
      else if (token === "null") cls = "u";
      tokens.push({ cls, text: token });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < json.length) tokens.push({ cls: null, text: json.slice(lastIndex) });
    return tokens;
  }

  window.AgentDeskAPI = {
    SEATS, SEAT_BY_ID, AGENT_COLOR, A2A_TYPE_META, SKILL_TEST_CONFIG,
    useBus, usePendingCount, useNowTick, runDemo, getGates, approveGate, denyGate,
    getDocumentRequests, resolveDocumentRequest, getQuestions, resolveQuestion,
    compileSeat, deliverPack, getRuntimeStatus, testSkill,
    timeAgo, tokenizeJSON,
  };
})();