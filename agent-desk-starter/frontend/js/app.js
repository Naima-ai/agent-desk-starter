// frontend/js/app.js
(function () {
  const h = React.createElement;
  const { useState } = React;
  const { useBus, usePendingCount, runDemo } = window.AgentDeskAPI;
  const { Sidebar, ViewHeader, Roster, AgentPage, A2AStream, Board, Memory, Approvals } = window.AgentDeskComponents;

  const VIEW_META = {
    roster:    { title: "Roster",       description: "Every seat on the desk \u2014 who they are and where they run." },
    agent:     { title: "Agent page",   description: "Compile a seat from its job description and inspect what it produces." },
    stream:    { title: "A2A stream",   description: "Typed, signed messages moving between agents" },
    board:     { title: "Board",        description: "The pre-filing validation flow, step by step, as it runs." },
    memory:    { title: "Memory panel", description: "What's been proven (evidence) and what's believed (knowledge), live." },
    approvals: { title: "Approvals",    description: "Everything waiting on a human \u2014 owner sign-off and missing documents." },
  };

  function App() {
    const { ev, live } = useBus();
    const [view, setView] = useState("roster");
    const [running, setRunning] = useState(false);
    const [selectedSeat, setSelectedSeat] = useState(null);

    // Refreshes whenever new gate/ladder activity arrives on the bus, 
    // or every few seconds regardless
    const pendingCount = usePendingCount(ev.gate.length + ev.ladder.length);

    const onRunDemo = async () => {
      setRunning(true);
      try { await runDemo(); } finally { setTimeout(() => setRunning(false), 4000); }
    };

    const goToAgentPage = (seatId) => { setSelectedSeat(seatId); setView("agent"); };

    const meta = VIEW_META[view];

    let content;
    if (view === "roster") content = h(Roster, { onSelectSeat: goToAgentPage });
    else if (view === "agent") content = h(AgentPage, { initialSeat: selectedSeat, onSeatChange: setSelectedSeat });
    else if (view === "stream") content = h(A2AStream, { messages: ev.a2a });
    else if (view === "board") content = h(Board, { board: ev.board, feed: ev.feed });
    else if (view === "memory") content = h(Memory, { evidence: ev.evidence, knowledge: ev.knowledge, coa: ev.coa });
    else if (view === "approvals") content = h(Approvals, { ladderEvents: ev.ladder });

    return h("div", { className: "app-shell" },
      h(Sidebar, { view, setView, pendingCount, onRunDemo, running }),
      h("main", { className: "main" },
        h("div", { className: "main-inner" },
          h(ViewHeader, { title: meta.title, description: meta.description, live }),
          content)));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
