// frontend/js/app.js
(function () {
  const h = React.createElement;
  const { useState } = React;
  const { useBus, usePendingCount, runDemo } = window.AgentDeskAPI;
  const { Sidebar, ViewHeader, Roster, AgentPage, A2AStream, Board, Memory, Approvals, Clients, Team } = window.AgentDeskComponents;

  const VIEW_META = {
    clients:   { title: "Clients",      description: "Real client data from TeamSystem \u2014 pick one to pull its VAT batch through the real pipeline." },
    roster:    { title: "Roster",       description: "Every seat on the desk \u2014 who they are and where they run." },
    team:      { title: "Team",         description: "Lo Smistatore's real staff roster \u2014 who it actually routes messages to." },
    agent:     { title: "Agent page",   description: "Compile a seat from its job description and inspect what it produces." },
    stream:    { title: "A2A stream",   description: "Typed, signed messages moving between agents" },
    board:     { title: "Board",        description: "The pre-filing validation flow, step by step, as it runs." },
    memory:    { title: "Memory panel", description: "Cortex memory per client (every action taken, what was learned), plus what's been proven (evidence) and what's believed (knowledge), live." },
    approvals: { title: "Approvals",    description: "Everything waiting on a human \u2014 owner sign-off and missing documents." },
  };

  function App() {
    const { ev, live } = useBus();
    const [view, setView] = useState("clients");
    const [running, setRunning] = useState(false);
    const [selectedSeat, setSelectedSeat] = useState(null);
    const [lastRunClientId, setLastRunClientId] = useState(null);

    // Refreshes whenever new gate/ladder activity arrives on the bus,
    // or every few seconds regardless
    const pendingCount = usePendingCount(ev.gate.length + ev.ladder.length);

    const onValidateClient = async (clientId) => {
      setLastRunClientId(clientId);
      setRunning(true);
      setView("board");
      try { await runDemo(clientId); } finally { setTimeout(() => setRunning(false), 4000); }
    };

    const goToAgentPage = (seatId) => { setSelectedSeat(seatId); setView("agent"); };

    const meta = VIEW_META[view];

    let content;
    if (view === "clients") content = h(Clients, { onValidate: onValidateClient, running, lastRunClientId });
    else if (view === "roster") content = h(Roster, { onSelectSeat: goToAgentPage });
    else if (view === "team") content = h(Team, null);
    else if (view === "agent") content = h(AgentPage, { initialSeat: selectedSeat, onSeatChange: setSelectedSeat });
    else if (view === "stream") content = h(A2AStream, { messages: ev.a2a });
    else if (view === "board") content = h(Board, { board: ev.board, feed: ev.feed });
    else if (view === "memory") content = h(Memory, { evidence: ev.evidence, knowledge: ev.knowledge, coa: ev.coa, routing: ev.routing, lastRunClientId });
    else if (view === "approvals") content = h(Approvals, { ladderEvents: ev.ladder });

    return h("div", { className: "app-shell" },
      h(Sidebar, { view, setView, pendingCount }),
      h("main", { className: "main" },
        h("div", { className: "main-inner" },
          h(ViewHeader, { title: meta.title, description: meta.description, live }),
          content)));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
