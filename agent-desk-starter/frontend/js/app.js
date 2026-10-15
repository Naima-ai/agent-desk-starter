// frontend/js/app.js
(function () {
  const h = React.createElement;
  const { useState } = React;
  const { useBus, usePendingCount, runDemo } = window.AgentDeskAPI;
  const { Sidebar, ViewHeader, Roster, AgentPage, A2AStream, Board, Memory, Approvals, Clients, Team } = window.AgentDeskComponents;

  const VIEW_META = {
    clients:   { title: "Clients" },
    roster:    { title: "Roster" },
    team:      { title: "Team" },
    agent:     { title: "Agent page" },
    stream:    { title: "A2A stream" },
    board:     { title: "Board" },
    memory:    { title: "Memory panel" },
    approvals: { title: "Approvals" },
  };

  function App() {
    const { ev, live } = useBus();
    const [view, setView] = useState("clients");
    const [running, setRunning] = useState(false);
    const [selectedSeat, setSelectedSeat] = useState(null);
    const [lastRunClientId, setLastRunClientId] = useState(null);
    const [selectedClientId, setSelectedClientId] = useState(null); // survives tab switches

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
    if (view === "clients") content = h(Clients, { onValidate: onValidateClient, running, lastRunClientId, selectedClientId, onSelectClient: setSelectedClientId });
    else if (view === "roster") content = h(Roster, { onSelectSeat: goToAgentPage });
    else if (view === "team") content = h(Team, null);
    else if (view === "agent") content = h(AgentPage, { initialSeat: selectedSeat, onSeatChange: setSelectedSeat });
    else if (view === "stream") content = h(A2AStream, { messages: ev.a2a });
    else if (view === "board") content = h(Board, { board: ev.board, feed: ev.feed });
    else if (view === "memory") content = h(Memory, { evidence: ev.evidence, knowledge: ev.knowledge, coa: ev.coa, routing: ev.routing, lastRunClientId, selectedClientId });
    else if (view === "approvals") content = h(Approvals, { ladderEvents: ev.ladder });

    return h("div", { className: "app-shell" },
      h(Sidebar, { view, setView, pendingCount }),
      h("main", { className: "main" },
        h("div", { className: "main-inner" },
          h(ViewHeader, { title: meta.title, live }),
          content)));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
