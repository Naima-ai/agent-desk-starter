// frontend/js/components.js
(function () {
  const { useState, useEffect } = React;
  const h = React.createElement;
  const API = () => window.AgentDeskAPI; // read lazily so load order only matters at call time, not parse time

  // ---------------------------------------------------------------- icons --
  const ICONS = {
    roster:    ["M4 5h6v6H4z", "M14 5h6v6h-6z", "M4 13h6v6H4z", "M14 13h6v6h-6z"],
    agent:     ["M12 12a4 4 0 100-8 4 4 0 000 8z", "M4 20c0-3.5 3.5-6 8-6s8 2.5 8 6"],
    stream:    ["M3 8h13", "M12 4l4 4-4 4", "M21 16H8", "M12 20l-4-4 4-4"],
    board:     ["M4 6h16", "M4 12h10", "M4 18h7", "M16.5 16.5l1.8 1.8L22 14"],
    memory:    ["M4 6c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5-3.6 2.5-8 2.5S4 7.4 4 6z", "M4 6v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V6", "M4 12v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6"],
    approvals: ["M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z", "M9 12l2 2 4-4"],
    play:      ["M6 4l14 8-14 8V4z"],
    chevron:   ["M15 5l-7 7 7 7"],
    clients:   ["M4 20V10l8-6 8 6v10", "M9 20v-6h6v6"],
    team:      ["M8 11a3 3 0 100-6 3 3 0 000 6z", "M2 20c0-3 2.5-5 6-5s6 2 6 5", "M17 5a3 3 0 010 6", "M15 15c2.5 0 5 1.5 5 5"],
  };
  function Icon({ name, size = 18 }) {
    return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
      (ICONS[name] || []).map((d, i) => h("path", { d, key: i })));
  }

  // ------------------------------------------------------------- helpers --
  function renderTokens(tokens) {
    return tokens.map((t, i) => (t.cls ? h("span", { className: t.cls, key: i }, t.text) : t.text));
  }

  function StatusDot({ live }) { return h("span", { className: `live-dot${live ? " live" : ""}` }); }

  function ViewHeader({ title, description, live }) {
    return h("div", { className: "view-header" },
      h("div", { className: "view-header-row" },
        h("h1", null, title),
        h("span", { className: "conn-status" }, h(StatusDot, { live }), live ? "Live" : "Offline")
      ),
      h("p", null, description));
  }

  function EmptyState({ children }) { return h("div", { className: "empty-state" }, children); }

  function SeatMonogram({ seat, size = 36 }) {
    return h("div", { className: "monogram", style: { background: seat.color, width: size, height: size, fontSize: Math.round(size * 0.36) } }, seat.initials);
  }

  // -------------------------------------------------------------- sidebar --
  const NAV = [
    { id: "clients",   label: "Clients",      shortLabel: "Clients",  icon: "clients" },
    { id: "roster",    label: "Roster",       shortLabel: "Roster",   icon: "roster" },
    { id: "team",      label: "Team",         shortLabel: "Team",     icon: "team" },
    { id: "agent",     label: "Agent page",   shortLabel: "Agent",    icon: "agent" },
    { id: "stream",    label: "A2A stream",   shortLabel: "A2A",      icon: "stream" },
    { id: "board",     label: "Board",        shortLabel: "Board",    icon: "board" },
    { id: "memory",    label: "Memory panel", shortLabel: "Memory",   icon: "memory" },
    { id: "approvals", label: "Approvals",    shortLabel: "Approve",  icon: "approvals" },
  ];

  function readStoredCollapse() {
    try { return window.localStorage.getItem("agentDeskSidebarCollapsed") === "1"; } catch (e) { return false; }
  }
  function storeCollapse(v) {
    try { window.localStorage.setItem("agentDeskSidebarCollapsed", v ? "1" : "0"); } catch (e) { /* ignore — not critical */ }
  }

  //  1. `.sidebar`          — desktop/tablet, collapsible to icon-only
  //  2. `.mobile-header`     — phone only: brand
  //  3. `.mobile-bottom-nav` — phone only: a real tab bar, o
  function Sidebar({ view, setView, pendingCount }) {
    const [collapsed, setCollapsed] = useState(readStoredCollapse);
    const toggle = () => { const next = !collapsed; setCollapsed(next); storeCollapse(next); };

    return h(React.Fragment, null,
      h("aside", { className: `sidebar${collapsed ? " collapsed" : ""}` },
        h("div", { className: "brand" },
          h("div", { className: "brand-mark" }, "l", h("span", { className: "dot" }, "\u221E"), "p"),
          !collapsed && h("div", { className: "brand-sub" }, "Agent Desk")),
        h("nav", { className: "side-nav" },
          NAV.map((n) => h("button", {
            key: n.id, className: `nav-item${view === n.id ? " active" : ""}`, onClick: () => setView(n.id),
            title: n.label, "aria-label": n.label,
          },
            h(Icon, { name: n.icon, size: 17 }),
            !collapsed && h("span", { className: "nav-label" }, n.label),
            n.id === "approvals" && pendingCount > 0 && h("span", { className: "count" }, pendingCount)))),
        !collapsed && h("div", { className: `attention-block${pendingCount > 0 ? " has-items" : ""}` },
          h("div", { className: "attention-title" }, pendingCount > 0 ? `${pendingCount} need${pendingCount === 1 ? "s" : ""} you` : "All clear"),
          h("div", { className: "attention-sub" }, pendingCount > 0 ? "Pending approvals & document requests" : "No pending approvals right now")),
        h("button", {
          className: "sidebar-toggle", onClick: toggle,
          title: collapsed ? "Expand sidebar" : "Collapse sidebar", "aria-label": collapsed ? "Expand sidebar" : "Collapse sidebar",
        },
          h(Icon, { name: "chevron", size: 15 }),
          !collapsed && h("span", null, "Collapse"))),

      h("header", { className: "mobile-header" },
        h("div", { className: "brand-mark" }, "l", h("span", { className: "dot" }, "\u221E"), "p")),

      h("nav", { className: "mobile-bottom-nav" },
        NAV.map((n) => h("button", {
          key: n.id, className: `mobile-nav-item${view === n.id ? " active" : ""}`, onClick: () => setView(n.id),
          "aria-label": n.label,
        },
          h("span", { className: "mobile-nav-icon" },
            h(Icon, { name: n.icon, size: 19 }),
            n.id === "approvals" && pendingCount > 0 && h("span", { className: "count dot-count" }, pendingCount)),
          h("span", { className: "mobile-nav-label" }, n.shortLabel)))));
  }

  // --------------------------------------------------------------- roster --
  function Roster({ onSelectSeat }) {
    const { SEATS } = API();
    return h("div", { className: "seat-grid" },
      SEATS.map((s) => h("button", { key: s.id, className: "seat-tile", onClick: () => onSelectSeat(s.id) },
        h(SeatMonogram, { seat: s }),
        h("h3", null, s.name),
        h("p", { className: "role" }, s.role),
        h("span", { className: "location-badge" }, s.location === "client_side" ? "runs at the client" : "runs at the studio"))));
  }

  // ------------------------------------------------------- live runtime --
  function LiveRuntimePanel({ clientId }) {
    const { getRuntimeStatus } = API();
    const [status, setStatus] = useState(null);
    useEffect(() => {
      let cancelled = false;
      const refresh = () => getRuntimeStatus(clientId).then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
      refresh();
      const id = setInterval(refresh, 2000);
      return () => { cancelled = true; clearInterval(id); };
    }, [clientId]);

    return h("div", { className: "panel stacked-panel" },
      h("h3", { className: "panel-title" }, "Live runtime \u2014 ", h("span", { className: "panel-subtitle" }, clientId)),
      status
        ? h("div", { className: "runtime-stats" },
            h("div", { className: "runtime-stat" }, h("b", null, status.gates), " pending approval(s)"),
            h("div", { className: "runtime-stat" }, h("b", null, status.docReqs), " open document request(s)"),
            h("div", { className: "runtime-stat" }, h("b", null, status.questions), " open question(s) to the studio"))
        : h(EmptyState, null, "Loading\u2026"));
  }

  // ------------------------------------------------------------ skill sandbox --
  // Exercises the 7 skills directly, with a client-specific on/off list
  function SkillSandbox({ clientId }) {
    const { SKILL_TEST_CONFIG, testSkill, tokenizeJSON } = API();
    const ALL = SKILL_TEST_CONFIG.map((s) => s.id);
    const [enabled, setEnabled] = useState(ALL); // default: all on, matching the real seat's default manifest
    const [activeSkill, setActiveSkill] = useState(ALL[0]);
    const [fieldValues, setFieldValues] = useState({});
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    const config = SKILL_TEST_CONFIG.find((s) => s.id === activeSkill);
    const toggle = (id) => setEnabled((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
    const setField = (key, value) => setFieldValues((prev) => ({ ...prev, [key]: value }));

    const run = async () => {
      setBusy(true); setError(null); setResult(null);
      try {
        const args = {};
        (config.fields || []).forEach((f) => { args[f.key] = fieldValues[f.key] ?? f.default; });
        setResult(await testSkill(activeSkill, clientId, enabled, args));
      } catch (e) { setError(String((e && e.message) || e)); }
      finally { setBusy(false); }
    };

    return h("div", { className: "panel stacked-panel" },
      h("h3", { className: "panel-title" }, "Skill sandbox ", h("span", { className: "panel-subtitle" }, "the 7 skills, switched on per client")),
      h("p", { className: "hint" }, "Each skill checks manifest.skills before doing anything. Switch one off below, then run it \u2014 it should come back skipped rather than running anyway."),
      h("div", { className: "skill-toggle-grid" },
        SKILL_TEST_CONFIG.map((s) => h("label", { key: s.id, className: "checkbox-label" },
          h("input", { type: "checkbox", checked: enabled.includes(s.id), onChange: () => toggle(s.id) }),
          s.label))),
      h("div", { className: "pack-tester-row" },
        h("label", { className: "field-label-inline" }, "Skill to run",
          h("select", { className: "text-input", value: activeSkill, onChange: (e) => { setActiveSkill(e.target.value); setResult(null); setError(null); } },
            SKILL_TEST_CONFIG.map((s) => h("option", { key: s.id, value: s.id }, s.label)))),
        (config.fields || []).map((f) => h("label", { key: f.key, className: "field-label-inline" }, f.label,
          h("input", { className: "text-input", value: fieldValues[f.key] ?? f.default, onChange: (e) => setField(f.key, e.target.value) }))),
        h("button", { className: "btn-primary", onClick: run, disabled: busy }, busy ? "Running\u2026" : "Run skill")),
      !enabled.includes(activeSkill) && h("div", { className: "error-banner" }, `"${config.label}" is switched OFF above \u2014 running it now should come back skipped, not do anything.`),
      error && h("div", { className: "error-banner" }, error),
      result && h("pre", { className: "code-block" }, renderTokens(tokenizeJSON(result))));
  }

  // ------------------------------------------------------- pack delivery --
  // Manual trigger for L'Amministrativo's proactive deliverMonthlyPack() 
  function PackDeliveryTester({ clientId, period, onPeriodChange }) {
    const { deliverPack, tokenizeJSON } = API();
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    const run = async () => {
      setBusy(true); setError(null); setResult(null);
      try { setResult(await deliverPack(clientId, period)); }
      catch (e) { setError(String((e && e.message) || e)); }
      finally { setBusy(false); }
    };

    return h("div", { className: "panel" },
      h("h3", { className: "panel-title" }, "Test: deliver the monthly pack ",
        h("span", { className: "panel-subtitle" }, "proactive \u2014 not triggered by a studio request")),
      h("p", { className: "hint" }, "Calls the seat\u2019s own deliverMonthlyPack() directly, the same way a real schedule trigger would. Summarises whatever this client/period already has recorded \u2014 documents found, still-open requests, still-open questions \u2014 into a single pack_delivered message."),
      h("div", { className: "pack-tester-row" },
        h("label", { className: "field-label-inline" }, "Period",
          h("input", { className: "text-input", value: period, onChange: (e) => onPeriodChange(e.target.value) })),
        h("button", { className: "btn-primary", onClick: run, disabled: busy }, busy ? "Delivering\u2026" : "Deliver now")),
      error && h("div", { className: "error-banner" }, error),
      result && h("div", null,
        h("div", { className: "success-banner" },
          `\u2713 pack_delivered sent \u2014 ${result.pack.docs.length} doc(s), ${result.pack.missing.length} missing, ${result.pack.questions.length} open question(s)`),
        h("pre", { className: "code-block" }, renderTokens(tokenizeJSON(result.pack)))));
  }

  // ------------------------------------------------------------ agent page --
  function AgentPage({ initialSeat, onSeatChange }) {
    const { SEATS, compileSeat, tokenizeJSON } = API();
    const [seat, setSeat] = useState(initialSeat || "l_amministrativo");
    const [jobText, setJobText] = useState("");
    const [out, setOut] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [tab, setTab] = useState("manifest");
    const [packClientId, setPackClientId] = useState("rossi_srl");
    const [packPeriod, setPackPeriod] = useState("2026-Q3");

    useEffect(() => { setSeat(initialSeat || "l_amministrativo"); }, [initialSeat]);
    useEffect(() => { setOut(null); setError(null); }, [seat]);

    const pick = (id) => { setSeat(id); onSeatChange && onSeatChange(id); };
    const compile = async () => {
      setBusy(true); setError(null);
      try { setOut(await compileSeat(seat, jobText)); }
      catch (e) { setError(String((e && e.message) || e)); }
      finally { setBusy(false); }
    };

    return h(React.Fragment, null,
      h("div", { className: "agent-layout" },
        h("div", { className: "panel" },
          h("div", { className: "seat-list" },
            SEATS.map((s) => h("div", {
              key: s.id, className: `seat-list-item${seat === s.id ? " active" : ""}`, onClick: () => pick(s.id),
            }, h(SeatMonogram, { seat: s, size: 26 }), h("span", null, s.name)))),
          h("label", { className: "field-label" }, "Job description (Italian)"),
          h("textarea", {
            className: "job-input",
            placeholder: "es. Recupera i documenti mancanti per il periodo; se non li trovi, chiedi al titolare su WhatsApp\u2026",
            value: jobText, onChange: (e) => setJobText(e.target.value),
          }),
          h("p", { className: "hint" }, "Leave blank to compile the seat\u2019s real job description on file. The NL\u2192manifest step genuinely calls the model gateway (edge SLM \u2192 cloud fallback \u2192 a deterministic offline heuristic if neither is reachable, which is what runs without a local model server configured) \u2014 the manifest below reflects whichever of those actually answered."),
          h("button", { className: "btn-primary", onClick: compile, disabled: busy }, busy ? "Compiling\u2026" : "Compile")),
        h("div", { className: "panel" },
          error && h("div", { className: "error-banner" }, error),
          !error && !out && h(EmptyState, null, "Pick a seat and compile to see its manifest and generated skill here."),
          out && h("div", null,
            out.usedCustomJobText && h("div", { className: "success-banner" }, "\u2713 Compiled using the text you wrote"),
            h("div", { className: "segmented" },
              h("button", { className: tab === "manifest" ? "active" : "", onClick: () => setTab("manifest") }, "Manifest"),
              h("button", { className: tab === "skill" ? "active" : "", onClick: () => setTab("skill") }, "Compiled skill")),
            tab === "manifest"
              ? h("pre", { className: "code-block" }, renderTokens(tokenizeJSON(out.manifest)))
              : h("pre", { className: "code-block plain" }, out.skill)))),
      seat === "l_amministrativo" && h(React.Fragment, null,
        h("div", { className: "panel client-selector" },
          h("label", { className: "field-label-inline" }, "Testing as client",
            h("input", { className: "text-input", value: packClientId, onChange: (e) => setPackClientId(e.target.value) })),
          h("p", { className: "hint" }, "The live runtime, skill sandbox and pack-delivery tester below all act on this client id.")),
        h(LiveRuntimePanel, { clientId: packClientId }),
        h(SkillSandbox, { clientId: packClientId }),
        h(PackDeliveryTester, { clientId: packClientId, period: packPeriod, onPeriodChange: setPackPeriod })));
  }

  // ------------------------------------------------------------ a2a stream --
  function A2AStream({ messages }) {
    const { A2A_TYPE_META, AGENT_COLOR, tokenizeJSON, timeAgo, useNowTick } = API();
    useNowTick();
    const [openId, setOpenId] = useState(null);
    const [typeFilter, setTypeFilter] = useState("all");
    const [onlyLA, setOnlyLA] = useState(false);

    const types = Object.keys(A2A_TYPE_META);
    const filtered = messages.filter((e) => {
      const m = e.message;
      if (typeFilter !== "all" && m.type !== typeFilter) return false;
      if (onlyLA && m.from !== "l_amministrativo" && m.to !== "l_amministrativo") return false;
      return true;
    });

    return h("div", null,
      h("div", { className: "stream-filters" },
        h("select", { className: "text-input", value: typeFilter, onChange: (e) => setTypeFilter(e.target.value) },
          h("option", { value: "all" }, `All types (${messages.length})`),
          types.map((t) => h("option", { key: t, value: t }, A2A_TYPE_META[t].label))),
        h("label", { className: "checkbox-label" },
          h("input", { type: "checkbox", checked: onlyLA, onChange: (e) => setOnlyLA(e.target.checked) }),
          "Only L'Amministrativo")),
      filtered.length === 0
        ? h(EmptyState, null, messages.length === 0 ? "No messages yet \u2014 run the demo to see typed, signed A2A traffic." : "No messages match this filter.")
        : h("div", { className: "panel" },
            filtered.map((e, i) => {
              const m = e.message;
              const meta = A2A_TYPE_META[m.type] || { label: m.type, bg: "#F6F8FC", fg: "#5B6B85" };
              const open = openId === i;
              return h("div", { className: "msg-row", key: i },
                h("div", { className: "msg-parties" },
                  h("span", { style: { color: AGENT_COLOR[m.from] || "#101A2B" } }, m.from), " \u2192 ",
                  h("span", { style: { color: AGENT_COLOR[m.to] || "#101A2B" } }, m.to),
                  h("div", { className: "row-timestamp" }, timeAgo(e.at))),
                h("div", { className: "msg-body" },
                  h("span", { className: "msg-type-pill", style: { background: meta.bg, color: meta.fg } }, meta.label),
                  h("button", { className: "msg-payload-toggle", onClick: () => setOpenId(open ? null : i) }, open ? "hide payload" : "show payload"),
                  open && h("pre", { className: "msg-payload" }, renderTokens(tokenizeJSON(m)))));
            })));
  }

  // ----------------------------------------------------------------- board --
  function Board({ board, feed }) {
    const { AGENT_COLOR, timeAgo, useNowTick } = API();
    useNowTick();
    if (board.length === 0) return h(EmptyState, null, "Run the demo to watch the pre-filing validation flow step through.");
    return h("div", { className: "board-layout" },
      h("div", { className: "panel" },
        h("h3", { className: "panel-title" }, "Steps"),
        h("div", { className: "stepper" },
          board.map((e, i) => h("div", { className: `step${i < board.length - 1 ? " done" : ""}`, key: i },
            h("div", { className: "label" }, e.label),
            h("div", { className: "row-timestamp" }, timeAgo(e.at)))))),
      h("div", { className: "panel" },
        h("h3", { className: "panel-title" }, "Live feed"),
        feed.length === 0 ? h(EmptyState, null, "No agent activity yet.") :
          feed.map((e, i) => h("div", { className: `feed-row ${e.tone || ""}`, key: i },
            h("span", { className: "agent-dot", style: { background: AGENT_COLOR[e.agent] || "#93A1B8" } }),
            h("span", { className: "agent-name" }, e.agent),
            h("span", { className: "text" }, e.text),
            h("span", { className: "row-timestamp" }, timeAgo(e.at))))));
  }

  // ---------------------------------------------------------------- memory --
  // A collapsible <details> section with a title, a plain-language one-line
  // explanation of what it actually is, and a count badge \u2014 the four kinds
  // of record shown here (live proposal / learned rule / client fact /
  // evidence) look superficially similar (all "some agent remembered
  // something") but mean genuinely different things, so each gets its own
  // section instead of being dumped into one list.
  function MemSection({ title, desc, count, defaultOpen, children }) {
    return h("details", { className: "mem-section", open: defaultOpen || undefined },
      h("summary", { className: "mem-summary" },
        h("span", { className: "mem-summary-title" }, title),
        h("span", { className: "mem-count" }, count)),
      h("p", { className: "mem-desc" }, desc),
      count === 0 ? h(EmptyState, null, "Nothing here yet.") : h("div", { className: "mem-body" }, children));
  }

  function Memory({ evidence, knowledge, coa, routing }) {
    if (evidence.length === 0 && knowledge.length === 0 && coa.length === 0 && routing.length === 0) {
      return h(EmptyState, null, "Nothing recorded yet \u2014 run the demo to populate the evidence and knowledge stores.");
    }

    const packs = evidence.filter((e) => e.record.kind === "monthly_pack");
    const generalEvidence = evidence.filter((e) => e.record.kind !== "monthly_pack");
    // L'Archivista's confirmed rules and L'Amministrativo's own client facts
    // are BOTH keyed "client:<id>:..." (same partition convention), so they
    // have to be told apart by `kind`, not just by key prefix.
    const archivistRules = knowledge.filter((e) => e.record.kind === "coa_mapping");
    const clientFacts = knowledge.filter((e) => e.record.kind !== "coa_mapping" && e.record.key && e.record.key.startsWith("client:"));
    const sharedKnowledge = knowledge.filter((e) => e.record.kind !== "coa_mapping" && (!e.record.key || !e.record.key.startsWith("client:")));

    const ruleRow = (e, i) => h("div", { className: "ledger-row", key: "ar" + i },
      h("div", null, h("b", null, e.record.scope || "?"), ` \u00b7 ${e.record.key.split(":coa:")[1] || e.record.key} \u2192 ${e.record.value}`),
      h("div", { className: "payload-line" }, `confirmed by ${e.record.confirmedBy || "?"} \u00b7 confidence ${e.record.confidence}`),
      h("div", { className: "confidence-bar" }, h("span", { style: { width: `${Math.round((e.record.confidence || 0) * 100)}%` } })));

    const COA_SOURCE_LABEL = { memory: "remembered rule", slm: "model call", heuristic: "keyword fallback" };
    const coaRow = (e, i) => h("div", { className: "ledger-row", key: "c" + i },
      `${e.supplier} \u2192 ${e.account} @ ${e.confidence}` + (e.source ? ` (${COA_SOURCE_LABEL[e.source] || e.source})` : ""));

    const factRow = (e, i) => h("div", { className: "ledger-row", key: "cm" + i },
      h("div", null, `${e.record.key.split(":").slice(2).join(":")} \u2192 ${JSON.stringify(e.record.value).slice(0, 140)}`),
      h("div", { className: "confidence-bar" }, h("span", { style: { width: `${Math.round((e.record.confidence || 0) * 100)}%` } })));

    const sharedRow = (e, i) => h("div", { className: "ledger-row", key: "sm" + i },
      h("div", null, `${e.record.key} \u2192 ${JSON.stringify(e.record.value)}`),
      h("div", { className: "confidence-bar" }, h("span", { style: { width: `${Math.round((e.record.confidence || 0) * 100)}%` } })));

    const packRow = (e, i) => h("div", { className: "ledger-row pack-row", key: "p" + i },
      h("div", null, h("b", null, `${e.record.clientId} \u00b7 ${e.record.period}`)),
      h("div", { className: "payload-line" },
        `${e.record.pack.docs.length} doc(s) \u00b7 ${e.record.pack.missing.length} missing \u00b7 ${e.record.pack.questions.length} open question(s)`));

    const evidenceRow = (e, i) => h("div", { className: "ledger-row", key: i },
      h("span", { className: "hash" }, `${e.record.id} \u00b7 ${e.record.hash}  `), JSON.stringify(e.record));

    const routingRow = (e, i) => h("div", { className: "ledger-row", key: "rt" + i },
      e.kind === "routed_task"
        ? `${e.client}: ${e.sourceMessageType} \u2192 ${e.owner}${e.escalated ? ` \u2014 escalated to tier ${e.escalationTier}` : ""}`
        : `${e.client}: ${e.sourceMessageType} \u2192 ESCALATED (${e.reason}, tried tiers ${JSON.stringify(e.triedTiers)})`);

    const leftPanel = h("div", { className: "panel", style: { display: "flex", flexDirection: "column", gap: 14 } },
      h(MemSection, {
        title: "Learned classification rules", count: archivistRules.length, defaultOpen: true,
        desc: "L'Archivista's CONFIRMED supplier \u2192 account mappings. Saved to disk, survives a restart, and auto-applied the next time THIS SAME CLIENT sees this same supplier \u2014 this is what actually shrinks the low-confidence tail over time. Scoped per client, so the same supplier name at a different client needs its own confirmation.",
      }, archivistRules.map(ruleRow)),
      h(MemSection, {
        title: "This run's classification proposals", count: coa.length,
        desc: "What Il Classificatore just suggested for each low-confidence line \u2014 live for THIS run only, not saved memory. Thrown away on the next run unless a human confirms one, which is what turns it into a learned rule above.",
      }, coa.map(coaRow)),
      h(MemSection, {
        title: "Client facts \u2014 L'Amministrativo", count: clientFacts.length,
        desc: "Administrative facts this seat recorded for one specific client \u2014 a logged expense, a delivered pack, an invoice draft. Its own memory, not shared with the studio side.",
      }, clientFacts.map(factRow)),
      sharedKnowledge.length > 0 && h(MemSection, {
        title: "Shared knowledge \u2014 not client-scoped", count: sharedKnowledge.length,
        desc: "Not tied to any one client \u2014 applies everywhere. Rare; almost everything here should be client-scoped.",
      }, sharedKnowledge.map(sharedRow)));

    const rightPanel = h("div", { className: "panel", style: { display: "flex", flexDirection: "column", gap: 14 } },
      packs.length > 0 && h(MemSection, {
        title: "Delivered packs", count: packs.length,
        desc: "L'Amministrativo's pack_delivered runs \u2014 what got proactively assembled and sent for a client/period.",
      }, packs.map(packRow)),
      h(MemSection, {
        title: "Evidence store", count: generalEvidence.length, defaultOpen: true,
        desc: "Immutable, append-only proof that something happened \u2014 a document received, a human asked to confirm a classification, an invoice approved. Never edited or deleted, only added to.",
      }, generalEvidence.map(evidenceRow)),
      h(MemSection, {
        title: "Lo Smistatore \u2014 routing decisions", count: routing.length,
        desc: "Every typed message addressed to Lo Smistatore and who it decided owns it, by competence + client ownership + availability \u2014 real decisions, not narrated. \"Every routing is human-overridable\" per its job description; there's no override control built yet, this section only makes the decisions visible.",
      }, routing.map(routingRow)));

    return h("div", { className: "memory-grid" }, leftPanel, rightPanel);
  }

  // ------------------------------------------------------------ approvals --
  function Approvals({ ladderEvents }) {
    const { getGates, approveGate, denyGate, getDocumentRequests, resolveDocumentRequest, getQuestions, resolveQuestion } = API();
    const [gates, setGates] = useState([]);
    const [docReqs, setDocReqs] = useState([]);
    const [questions, setQuestions] = useState([]);
    const refresh = () => { getGates().then(setGates); getDocumentRequests().then(setDocReqs); getQuestions().then(setQuestions); };
    useEffect(() => { refresh(); const id = setInterval(refresh, 1500); return () => clearInterval(id); }, []);
    useEffect(() => { refresh(); }, [ladderEvents.length]);

    const ladderDots = (remindersSent, escalated) => h("div", { className: "ladder-dots" },
      [0, 1].map((i) => h("span", { key: i, className: `dot${remindersSent > i ? " filled" : ""}` })),
      h("span", { className: `dot${escalated ? " escalated" : ""}` }));

    // Who's actually doing the approving depends on WHAT'S being approved \u2014
    // an invoice send-off is the client owner's call (was always "owner_mario"
    // here); a chart-of-accounts classification is a studio call, nobody's
    // "owner". Recorded as confirmedBy on the learned rule (Memory panel), so
    // getting this right matters, not just cosmetic.
    const approverFor = (action) => (action === "confirm_classification" ? "studio_professional" : "owner_mario");
    const GATE_LABEL = { confirm_classification: "Confirm classification", invoice: "Send invoice" };

    const onApprove = async (id, action) => { await approveGate(id, approverFor(action)); refresh(); };
    const onDeny = async (id) => { await denyGate(id, "declined in demo"); refresh(); };
    const onReceived = async (id) => { await resolveDocumentRequest(id, "IT" + Math.floor(Math.random() * 900 + 100)); refresh(); };
    const onSimulateReply = async (id) => { await resolveQuestion(id); refresh(); }; // no answer/evidenceId -> server fills a plausible default, same spirit as "Mark received"

    return h("div", null,
      h("h3", { className: "section-title" }, "Approvals"),
      gates.length === 0
        ? h(EmptyState, null, "No pending approvals. Run the demo \u2014 a low-confidence classification or a demo invoice needs a human partway through.")
        : gates.map((g) => h("div", { className: `approval-card${g.escalated ? " escalated" : ""}`, key: g.id },
            h("div", { className: "approval-top" },
              h("b", null, GATE_LABEL[g.action] || g.action), ladderDots(g.remindersSent, g.escalated),
              g.escalated && h("span", { className: "pill-escalated" }, "escalated to Lo Smistatore")),
            h("div", { className: "payload-line" }, JSON.stringify(g.payload)),
            h("div", { className: "approval-actions" },
              h("button", { className: "btn-approve", onClick: () => onApprove(g.id, g.action) }, "Approve"),
              h("button", { className: "btn-deny", onClick: () => onDeny(g.id) }, "Deny")))),

      h("h3", { className: "section-title" }, "Document requests"),
      docReqs.length === 0
        ? h(EmptyState, null, "No pending document requests right now.")
        : docReqs.map((r) => h("div", { className: `approval-card${r.escalated ? " escalated" : ""}`, key: r.id },
            h("div", { className: "approval-top" },
              h("b", null, `${r.expected.docType} \u00b7 ${r.expected.supplier}`),
              h("span", { className: "payload-line" }, r.expected.period),
              ladderDots(r.remindersSent, r.escalated),
              r.escalated && h("span", { className: "pill-escalated" }, "escalated to Lo Smistatore")),
            h("div", { className: "approval-actions" },
              h("button", { className: "btn-received", onClick: () => onReceived(r.id) }, "Mark received")))),

      h("h3", { className: "section-title" }, "Open questions to the studio"),
      h("p", { className: "hint" }, "domande_allo_studio \u2014 questions this seat has sent that the studio hasn't answered yet. No ladder here; only gates and document requests get reminded/escalated."),
      questions.length === 0
        ? h(EmptyState, null, "No open questions right now.")
        : questions.map((q) => h("div", { className: "approval-card", key: q.id },
            h("div", { className: "approval-top" }, h("b", null, q.topic)),
            h("div", { className: "payload-line" }, q.body),
            h("div", { className: "approval-actions" },
              h("button", { className: "btn-received", onClick: () => onSimulateReply(q.id) }, "Simulate studio reply")))),

      ladderEvents.length > 0 && h("div", null,
        h("h3", { className: "section-title" }, "Ladder activity"),
        h("div", { className: "panel" },
          ladderEvents.slice(-8).reverse().map((e, i) => h("div", { className: "feed-row", key: i },
            h("span", { className: "agent-dot", style: { background: e.event === "escalate" ? "#C0473C" : "#F08000" } }),
            h("span", null, `${e.kind} ${e.event}`),
            h("span", { className: "text" }, e.gateId || e.requestId))))));
  }

  // ---- Clients: real per-client data ingestion, not just a single "Run
  // demo" button. Lists every client the TeamSystem Firm mock actually has
  // (10 of them, each with real invoices/XML/VAT data), and validating one
  // is a real fetch through the real pipeline, not a canned script. ----
  function Clients({ onValidate, running, lastRunClientId }) {
    const [clients, setClients] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
      fetch("/api/ts-clients").then((r) => r.json()).then(setClients)
        .catch((e) => setError(String(e)));
    }, []);

    if (error) return h(EmptyState, null, `Couldn't reach the TeamSystem Firm mock: ${error}. Is it running (npm start in teamsystem-firm-mock)?`);
    if (!clients) return h(EmptyState, null, "Loading clients from the TeamSystem Firm mock…");

    return h("div", null,
      h("div", { className: "panel" },
        clients.map((c) => h("div", { className: "feed-row", key: c.id, style: { alignItems: "center" } },
          h("div", { style: { flex: 1 } },
            h("div", { style: { fontWeight: 600 } }, c.name),
            h("div", { className: "text" }, `${c.regime} · ATECO ${c.ateco} · P.IVA ${c.piva} · ${c.lineCount} line(s) · ${c.period}`)),
          h("button", {
            className: "run-demo-btn compact",
            disabled: running,
            onClick: () => onValidate(c.id),
            title: `Validate ${c.name}`,
          }, running && lastRunClientId === c.id ? "Running…" : "Validate")))));
  }

  // -------------------------------------------------------------- team --
  // The REAL roster Lo Smistatore routes against — who's on the desk, what
  // they're competent for, which clients they own, whether they're
  // available. NOT the same thing as the "Roster" page (the 7 AI seats) —
  // this is the human/agent staff directory backing route()'s actual
  // decisions, editable and persisted, replacing what used to be a
  // hardcoded fixture file nobody but a developer could change.
  const A2A_MESSAGE_TYPES = [
    "pack_delivered", "document_delivered", "item_missing",
    "question_for_studio", "instruction_from_studio", "answer_with_evidence",
    "escalation_requested", "acknowledgment", "correction_request",
  ];

  function emptyTeamForm() { return { agent: "", competence: [], clients: "*", available: true, tier: 0 }; }

  function Team() {
    const { getRoster, addRosterEntry, updateRosterEntry, removeRosterEntry } = API();
    const [roster, setRoster] = useState(null);
    const [error, setError] = useState(null);
    const [editingId, setEditingId] = useState(null); // null = adding a new entry
    const [form, setForm] = useState(emptyTeamForm);

    const refresh = () => getRoster().then(setRoster).catch((e) => setError(String(e)));
    useEffect(() => { refresh(); }, []);

    const toggleCompetence = (t) => setForm((f) => ({
      ...f, competence: f.competence.includes(t) ? f.competence.filter((x) => x !== t) : [...f.competence, t],
    }));

    const startEdit = (entry) => {
      setEditingId(entry.id);
      setForm({ agent: entry.agent, competence: entry.competence, clients: entry.clients.join(", "), available: entry.available, tier: entry.tier });
      setError(null);
    };
    const cancelEdit = () => { setEditingId(null); setForm(emptyTeamForm()); setError(null); };

    const submit = async () => {
      setError(null);
      const payload = {
        agent: form.agent.trim(),
        competence: form.competence,
        clients: form.clients.split(",").map((c) => c.trim()).filter(Boolean),
        available: form.available,
        tier: Number(form.tier) || 0,
      };
      try {
        if (editingId) await updateRosterEntry(editingId, payload);
        else await addRosterEntry(payload);
        cancelEdit();
        refresh();
      } catch (e) { setError(String((e && e.message) || e)); }
    };

    const remove = async (id) => { await removeRosterEntry(id); refresh(); };
    const toggleAvailable = async (entry) => { await updateRosterEntry(entry.id, { available: !entry.available }); refresh(); };

    if (!roster) return h(EmptyState, null, "Loading the roster…");

    return h("div", null,
      h("p", { className: "hint" },
        "Who Lo Smistatore actually routes messages to — real and editable, saved to disk, read fresh on every routed message (no restart needed). This is different from the “Roster” page, which lists the 7 AI seats — this is the staff directory route() reads competence, client ownership, and availability from."),
      h("div", { className: "panel stacked-panel" },
        h("h3", { className: "panel-title" }, editingId ? "Edit staff entry" : "Add staff entry"),
        h("div", { className: "pack-tester-row" },
          h("label", { className: "field-label-inline" }, "Agent id",
            h("input", { className: "text-input", value: form.agent, placeholder: "e.g. l_amministrativo, studio_lead", onChange: (e) => setForm({ ...form, agent: e.target.value }) })),
          h("label", { className: "field-label-inline" }, "Clients (comma-separated, or *)",
            h("input", { className: "text-input", value: form.clients, placeholder: "*", onChange: (e) => setForm({ ...form, clients: e.target.value }) })),
          h("label", { className: "field-label-inline" }, "Tier (0 = primary, 1 = backup, …)",
            h("input", { className: "text-input", type: "number", value: form.tier, onChange: (e) => setForm({ ...form, tier: e.target.value }) })),
          h("label", { className: "checkbox-label" },
            h("input", { type: "checkbox", checked: form.available, onChange: (e) => setForm({ ...form, available: e.target.checked }) }),
            "Available")),
        h("div", { className: "field-label" }, "Competence — which message types this entry can take"),
        h("div", { className: "skill-toggle-grid" },
          A2A_MESSAGE_TYPES.map((t) => h("label", { key: t, className: "checkbox-label" },
            h("input", { type: "checkbox", checked: form.competence.includes(t), onChange: () => toggleCompetence(t) }),
            t))),
        h("div", { className: "pack-tester-row" },
          h("button", { className: "btn-primary", onClick: submit, disabled: !form.agent.trim() || form.competence.length === 0 },
            editingId ? "Save changes" : "Add to roster"),
          editingId && h("button", { className: "btn-secondary", onClick: cancelEdit }, "Cancel")),
        error && h("div", { className: "error-banner" }, error)),
      h("div", { className: "panel" },
        h("h3", { className: "panel-title" }, `Current roster (${roster.length})`),
        roster.length === 0 ? h(EmptyState, null, "Nobody on the roster — every message will escalate to “ladder exhausted.”") :
          roster.map((r) => h("div", { className: "feed-row", key: r.id, style: { alignItems: "center", flexWrap: "wrap", gap: 8 } },
            h("div", { style: { flex: 1, minWidth: 200 } },
              h("div", { style: { fontWeight: 600 } }, `${r.agent} · tier ${r.tier}${r.available ? "" : " — unavailable"}`),
              h("div", { className: "text" }, `Handles: ${r.competence.join(", ") || "(none)"} · Clients: ${r.clients.join(", ") || "(none)"}`)),
            h("button", { className: "btn-secondary", onClick: () => toggleAvailable(r) }, r.available ? "Mark unavailable" : "Mark available"),
            h("button", { className: "btn-secondary", onClick: () => startEdit(r) }, "Edit"),
            h("button", { className: "btn-secondary", onClick: () => remove(r.id) }, "Remove")))));
  }

  window.AgentDeskComponents = {
    Icon, StatusDot, ViewHeader, EmptyState, SeatMonogram, Sidebar,
    Roster, AgentPage, A2AStream, Board, Memory, Approvals, Clients, Team,
  };
})();