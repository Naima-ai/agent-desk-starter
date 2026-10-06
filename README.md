# Agent Desk and TeamSystem Firm: a guide in plain words

## The big picture

There are two programs. They talk to each other all the time.

| Program | What it is | Address |
|---|---|---|
| **TeamSystem Firm (mock)** | The studio's own accounting system: the list of clients, their invoices, their chart of accounts. It stands in for the real TeamSystem. **This is where the studio keeps and fixes data.** | http://localhost:5680 |
| **Agent Desk** | The team of AI helpers ("agents"). They read a client's invoices from TeamSystem, check them, ask people for missing things, and report the result back to TeamSystem. **This is where you watch the helpers work.** | http://localhost:5173 |

**The simple story of one client:**

1. You open the client in Agent Desk and press **Validate**.
2. The helpers fetch the client's invoices from TeamSystem and check them.
3. They send the result back to TeamSystem.
4. TeamSystem reacts. If everything is fine, it asks the professional to sign. If something is wrong, it opens tasks, emails the client and sets reminders.
5. The studio fixes the problem in TeamSystem (edit a line, upload a document, email the client), then runs Validate again.
6. When it is clean, the professional signs and sends to the Agenzia delle Entrate. **The helpers never send anything to the tax authority themselves. A human always does that.**

---

## How to run it

### Option A: with Docker (one command, same everywhere)

Docker Desktop must be installed and **running** (its whale icon in the taskbar, saying "Engine running").

1. **Open a terminal in the project folder**, the one that contains `docker-compose.yml`:
   ```bash
   cd "E:\Nova Work\Loop.ai\Accountant_agent\agent-desk-starter"
   ```
2. **Create your settings file** and make a password for the system:
   ```bash
   copy .env.docker.example .env
   ```
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Open `.env`, paste that long text after `DESK_ACCESS_TOKEN=`, and save. This is the password you type to sign in. Everything else in the file is optional. Docker refuses to start while `DESK_ACCESS_TOKEN` is empty.
3. **Start everything** (the first time it builds, which takes a few minutes):
   ```bash
   docker compose up -d --build
   ```
4. **Open it**:
   - Agent Desk: http://localhost:5173 (type the token)
   - TeamSystem: http://localhost:5680 (type the same token)

Handy commands:

| What | Command |
|---|---|
| See if everything is healthy | `docker compose ps` |
| Watch the logs | `docker compose logs -f agent-desk` |
| Stop (keeps your data) | `docker compose down` |
| Stop and erase all data | `docker compose down -v` |
| Update after code changes | `docker compose up -d --build` |

If port 5173 or 5680 is "already in use", stop any copy you started from VS Code (Option B) first. Both options use the same ports.

**"docker is not recognized"?** The terminal was opened before Docker was installed. Fully close VS Code (not just the terminal panel), open it again, and try again. To fix just the current terminal without restarting, paste this once, then retry:
```bash
$env:Path += ";C:\Users\Testing\AppData\Local\Programs\DockerDesktop\resources\bin"
```

### Option B: straight from VS Code (no Docker)

Two terminals. Use the **same** token in both.

TeamSystem:
```bash
cd "E:\Nova Work\Loop.ai\Accountant_agent\agent-desk-starter\teamsystem-firm-mock"; npm install; $env:DESK_ACCESS_TOKEN="your-long-random-string"; npm start
```

Agent Desk:
```bash
cd "E:\Nova Work\Loop.ai\Accountant_agent\agent-desk-starter\agent-desk-starter"; npm install; $env:DESK_ACCESS_TOKEN="your-long-random-string"; npm start
```

For local-only testing you can skip the token. Then there is no sign-in, and the programs only listen on your own computer.

## The AI model (Qwen): two ways to run it

Agent Desk uses a small AI model to suggest accounts for unclear invoice lines and to read job descriptions. Without a model it still works, using plain keyword rules, and the badge at the top right says **Offline Heuristic Fallback**. With a model the badge says **Local SLM (qwen2.5:3b)**.

There are two ways to provide the model. Pick **one**.

### Way 1: Use the Ollama already installed on your PC (no big download in Docker)

Good when you run Agent Desk from VS Code (Option B), and also works with Docker.

1. Check the model is on your PC (it prints `qwen2.5:3b`; if it is missing, run `ollama pull qwen2.5:3b` once, about 2 GB):
   ```bash
   ollama list
   ```
2. Make sure Ollama is running (the llama icon near the clock). Nothing else to set up when you use **Option B**: Agent Desk finds it by itself.
3. **Only if you use Docker (Option A)**, tell the containers where your PC's Ollama is. Add this line to `.env` and restart:
   ```
   LOCAL_SLM_URL=http://host.docker.internal:11434/v1/chat/completions
   ```
   ```bash
   docker compose up -d
   ```

### Way 2: Let Docker run the model itself (works the same on any computer)

The model runs in its own container and is downloaded once into a Docker volume. Nothing is needed on the PC. The only difference from the normal start command is `--profile llm`:

```bash
docker compose --profile llm up -d --build
```

- The first time it downloads about 2 GB in the background. Watch it with:
  ```bash
  docker compose --profile llm logs -f ollama-pull
  ```
  When it says `success`, the badge in Agent Desk changes to **Local SLM (qwen2.5:3b)** (it checks every 15 seconds).
- To always include it, add this line to `.env`, and the short `docker compose up -d` will start the model too:
  ```
  COMPOSE_PROFILES=llm
  ```
- Stop it together with everything else, using the same flag:
  ```bash
  docker compose --profile llm down
  ```

### Which one should I use?

| | Way 1: your PC's Ollama | Way 2: Docker runs it |
|---|---|---|
| Extra download | none (already installed) | about 2 GB, once |
| Needs Ollama installed on the PC | yes | no |
| Same result on another computer | no, install Ollama there too | yes |
| Best for | your own testing | handing it to others |

### Not working?
- Badge still says **Offline Heuristic Fallback**: the model is not reachable. If it adds a note that the model "is not installed", run the `ollama pull qwen2.5:3b` command it shows.
- Classifying takes a long time on a normal PC (a minute or more per unclear line). That is the small model thinking on the CPU, not an error.

---

# Part 1: Agent Desk (port 5173)

## The top of every page
- **Model badge** (top right): shows which "brain" is answering right now.
  - *Local SLM (qwen2.5:3b)* means the small model on your computer.
  - *Cloud Fallback (Gemini)* means the online backup.
  - *Offline Heuristic Fallback* means plain built-in rules, with no AI. If it says the model is not installed, it also tells you the command to install it.
- **Live / Offline**: whether the page is receiving live updates from the helpers.
- **Left sidebar**: the tabs below. The red number on **Approvals** is how many things are waiting for a human. "All clear" means nothing is waiting.

## Clients tab
*The starting point. Pick a client and work with them.*

- A **search box**. Nothing is listed until you type (name, VAT number, ATECO code, regime) or click "browse all".
- Press **Enter** to open the first match, **Esc** to clear. The last 5 clients you opened appear as quick buttons.
- Opening a client shows:
  - **The client card** with the **Validate** button. Pressing it starts the checks and jumps you to the Board tab to watch.
  - **Email**: write to the client's email address from here and see the whole thread, including mail they sent back.
  - **TeamSystem, next steps**: what TeamSystem did after the last result (tasks opened, requests sent).

## Roster tab
*Who works here.*

Seven tiles, one per AI helper ("seat"), each with its job in one line and where it runs (at the studio or at the client). Click a tile to open that helper in the Agent page.

| Helper | In one line |
|---|---|
| **Chief of Staff** | Turns a written job description into the helper's settings |
| **IT Expert** | Builds the connections to other systems |
| **L'Addetto IVA** | The VAT clerk: checks each client's VAT batch |
| **Il Classificatore** | Decides which account an unclear invoice line belongs to |
| **L'Amministrativo** | The admin assistant: chases missing documents, talks to the client |
| **Lo Smistatore** | The dispatcher: decides who deals with each message |
| **L'Archivista** | The librarian: remembers confirmed corrections as rules |

## Team tab
*The real people (and agents) that Lo Smistatore sends work to.*

Not the same as Roster. This is the staff directory: who handles which kind of message, for which clients, and whether they are available. You can **add, edit and remove** entries. Changes are saved and used immediately for the next message. If nobody is available, the message goes up to the next level (tier 1, tier 2 and so on).

## Agent page tab
*Look inside one helper.*

- Pick a helper on the left. Write or leave blank a **job description** (in Italian) and press **Compile**. You see the helper's settings ("manifest") and the instruction file generated from it.
- **Important:** the compile can only make a helper *stricter* (add things it refuses to do). It cannot change what the helper is able to do. This is on purpose, because a small AI model once broke a helper that way.
- For **L'Amministrativo** there are three extra test panels:
  - **Live runtime**: how many approvals, document requests and open questions are pending for the client you are testing.
  - **Skill sandbox**: run any of its 7 skills by hand, and switch skills off to see them refuse to run.
  - **Deliver the monthly pack**: makes it send its monthly summary now.

## A2A stream tab
*The helpers talking to each other.*

"A2A" means agent to agent. Every message between helpers is listed: who sent it, who received it, and its type (for example "item missing", "document delivered", "correction request", "escalation requested"). Click **show payload** to see the full signed message. You can filter by type or show only L'Amministrativo's messages. Use this to understand *why* something happened.

## Board tab
*Watch a check as it happens.*

- **Steps** (left): the stages of one validation, in order. Batch loaded, checked, problems found, fixed, re-checked, sent back to TeamSystem.
- **Live feed** (right): each helper saying what it just did, in plain sentences, with colours (grey is info, orange is a warning, green is good news).

You land here automatically when you press Validate.

## Memory panel tab
*What the system remembers and can prove.*

At the top is **Cortex memory for one client** (pick the client in the dropdown):
- how many validation runs happened, and the trend over runs (is the client getting cleaner?)
- **recurring problems**: the same issue showing up again and again
- **learned rules**: "this supplier always goes to this account", confirmed by a person
- **every action taken** in the latest run, step by step

Below that:
- **Learned classification rules**: the same rules across clients.
- **This run's classification proposals**: what Il Classificatore suggested, how sure it was, and whether it came from memory, the AI model or plain keywords. Orange means "needs a human to confirm".
- **Client facts (L'Amministrativo)**: things it noted about a client.
- **Delivered packs**: monthly summaries that were sent.
- **Evidence store**: the permanent log of what happened. Things are only ever added, never changed or deleted.
- **Lo Smistatore, routing decisions**: who each message was sent to, and why.

## Approvals tab
*Everything waiting for a human.*

1. **Approvals (gates)**: a helper stopped and needs a yes/no. For example "confirm that this supplier belongs to this account" or "send this invoice". Press **Approve** or **Deny**. If nobody answers, it reminds, then escalates.
2. **Document requests**: a document the helpers could not find.
   - **Contact the client** opens a real form. Choose **Email** or **WhatsApp**.
     - Email: To, Subject, Message (already filled in, edit as you like).
     - WhatsApp: phone number in international form (+39…), template name, document, period.
   - Tick the box to also save the address or phone on the client's TeamSystem record.
   - Everything you send is logged under the request.
   - **Mark received** closes it once the document has arrived.
   - Until email or WhatsApp is configured, sending is a safe **practice mode**: it records the message and says clearly that nothing was really sent.
3. **Open questions to the studio**: questions a helper asked. **Simulate studio reply** answers one in the demo.
4. **Ladder activity**: the log of reminders and escalations.

---

# Part 2: TeamSystem Firm (port 5680)

One screen with a client list on the left and the selected client on the right.

## Left side: the client list
- **+ New client**: add a client (name, email, phone, VAT number, ATECO, regime, source format, period). The VAT number is checked with the real Italian check-digit rule.
- **The list**: click a client to open it. Each shows regime, ATECO and the number of invoice lines.

## Right side: one client

### Header
The name, VAT number, regime, ATECO, **email** and **phone**, and the **Edit client** button. Edit changes name, email, phone, VAT number, tax code, ATECO and regime. Add a reason; it is kept in the edit history.

### Messages from Agent Desk
Each time Agent Desk finishes a check, a message appears here: green if the batch is clean, orange if something is still open, with the filing deadline.

### Workflow: what TeamSystem does next
The heart of the system. For each period it shows a **stage** and a list of **tasks**:

| Stage | Meaning | What you do |
|---|---|---|
| needs review | Problems were found | Fix them (see below), then tick the task **Mark done** |
| ready for revalidation | All review tasks are done | Press **Re-run in Agent Desk** |
| awaiting signature | Clean. Waiting for the professional | Press **Sign** |
| signed | Signed | Press **Transmit to AdE** |
| filed | Sent. Has a protocol number | Nothing. It is locked. |

It also shows the **emails TeamSystem sent to the client** (correction requests, missing-document requests, reminders), whether each was really delivered, the **reminders** scheduled, and a full **timeline**.

If you change the data *after* a clean check, the signature is cancelled and the period goes back to re-validation, because what you would sign is no longer what was checked.

### Chart of accounts
The client's list of accounts, each with a **VAT rate** and a **Natura** code.
- A number like 22% is the normal rate.
- **0% with N4** means exempt (for example insurance, interest). **0% with N2.2** means outside VAT (for example salaries, depreciation).
- **n/a** means VAT does not apply (balance-sheet accounts).
- **Add account** adds a new account.

### VAT batch
Every invoice line of the period: supplier, description, net, VAT, account, the supplier's VAT number and the confidence score.
- **Edit** changes a line (supplier, amounts, account, supplier VAT number, date, Natura). Add a why.
- **view XML** shows the line as an electronic invoice (FatturaPA).
- This is how you fix problems such as "wrong VAT rate" or "invalid supplier VAT number".

### Expected but not received
Invoices that should have arrived (for example a monthly supplier) but have not.

### Attachments
Supporting PDFs, each linked to a line when it was recognised as an invoice.

### Email (the client's name)
Write to the client from here. You see the **thread**: what you sent and what the client sent back. Documents the client emails back (PDF, XML or CSV) are filed into this client's record automatically. Mail from unknown addresses is ignored.

### Edit history
Every change ever made: when, who, what, before, after, why. **Revert all edits** puts the original data back. Closed (filed) periods cannot be edited or reverted.

### Add documents
Upload an XML invoice, a CSV file or a PDF. XML and CSV become invoice lines. A readable PDF invoice also becomes a line. Any other PDF is kept as supporting evidence.

---

# A full example: fixing Rossi Srl

1. **Agent Desk → Clients**: search "rossi", open it, press **Validate**.
2. **Board**: watch. It finds a hotel invoice with 22% VAT where 10% is expected, a supplier with an invalid VAT number, and a missing invoice.
3. **TeamSystem → Rossi Srl**: the Workflow shows **needs review**, tasks, and emails already sent to the client.
4. In the **VAT batch**, press **Edit** on the hotel line and set the VAT to 10%. Edit the supplier line with the correct VAT number. Give a reason each time.
5. Tick the review task **Mark done**, then press **Re-run in Agent Desk**.
6. The Workflow now says **awaiting signature**. The professional presses **Sign**, then **Transmit to AdE**. A protocol number appears.
7. **Agent Desk → Memory panel → Rossi Srl**: the trend shows the problems going from 3 to 0, and the full list of actions taken.

---

# Words you will meet

| Word | Meaning |
|---|---|
| **Validate** | Check a client's batch of invoices for mistakes |
| **LIPE** | The quarterly VAT communication sent to the tax authority |
| **Partita IVA (P.IVA)** | Italian VAT number (11 digits, with a check digit) |
| **Natura** | The reason code when an invoice has 0% VAT (N1 to N7) |
| **Tail** | The invoice lines the system is not sure how to classify |
| **Gate** | A stop where a human must say yes or no |
| **Escalation** | Nobody answered, so it goes up to the next person |
| **Stub / practice mode** | The real connection (email, WhatsApp) is not set up, so the action is only recorded |
| **Seat** | One AI helper's role |
| **Manifest** | A helper's settings: what it may use and what it must never do |

# Where data is kept

| What | Where |
|---|---|
| Agent Desk memory, evidence, rules, staff list, email log | `agent-desk-starter/data/` (Docker: the `agent-data` volume) |
| TeamSystem custom clients, edits, workflow, uploads | `teamsystem-firm-mock/backend/data/` (Docker: the `ts-state` volume) |

The command `npm test` in Agent Desk **erases** its `data/` folder first. Do not run it on data you want to keep.
