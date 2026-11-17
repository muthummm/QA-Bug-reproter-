# Bug Log

A free bug tracker for a tester and developers.
**Frontend:** React (Vite) · **Backend:** Node.js + Express · **Database:** SQLite (built into Node, nothing extra to install)

## What it does
- After signing in you **pick a project** (or create one); its bug page opens. Each project has its own bugs, counts and CSV export.
- **Import CSV** (button on the bug page, or `npm run import -- "file.csv" --project "Project name"`) brings in a bug spreadsheet.
  It understands section rows like "Agent panel" (saved as the bug's Panel), blank Module cells (continues the module above),
  statuses Done / Not Done / Re-test, priorities P 1–P 4, and day-first dates (17/11/2026). Re-importing the same sheet skips bugs already there.
  Assignees who don't have an account yet are added; they set a password by choosing "Create an account" with their username (e.g. `kishore`).
- Testers and developers each create an account (role: Tester or Developer).
- Report a bug with: Module, Description, Steps to Reproduce, Expected Result, Actual Result,
  Status, Assignee, Priority, Date Reported, Screenshot/Link (plus image upload or paste), Notes.
- Bugs get IDs like `BUG-001`.
- **Roles** (chosen when creating an account):
  - **Tester:** reports bugs, imports CSV, edits all fields, and verifies fixes. Any status, including **Closed** and **Reopened**.
  - **Developer:** can't report or edit bug details. Moves bugs to In Progress, Fixed, Ready for Retest or Not a Bug, adds comments and edits **Notes**.
    Closing or reopening is left to the tester after retesting (same idea as Bugzilla, MantisBT and Jira's bug workflow).
  Every change is saved in the bug's **History** with who did it and when.
- Filter by status, priority or assignee, search by ID or text, sort, and **Export CSV** (opens in Excel).
- The list refreshes every 15 seconds, so you see developers' status changes without reloading.
- Only the person who reported a bug can delete it.

## Run it on your computer
Needs **Node.js 22.13 or newer** (you have Node 26).

```bash
npm install
npm run build
npm start
```
Open http://localhost:3001. Create a Tester account for yourself; developers create Developer accounts.

For development with live reload, run `npm run dev` and open http://localhost:5173.

Data is stored in the `data/` folder (`data/bugs.db` plus `data/uploads/` for screenshots).
**Back up that folder** to keep your bugs. Set `DATA_DIR` to store it somewhere else and `PORT` to change the port.

## Putting it online for free
SQLite saves to a file, so the host must keep files between restarts. Free options that work:

| Option | Cost | Good for | Catch |
|---|---|---|---|
| **Same office network** | Free | Team on the same Wi-Fi/LAN | Your PC must be on. Developers open `http://<your-PC-IP>:3001` (allow port 3001 in Windows Firewall). |
| **Your PC + Cloudflare Tunnel** | Free | Developers anywhere | Your PC must be on. Run `cloudflared tunnel --url http://localhost:3001` to get a public https link. |
| **Oracle Cloud "Always Free" VM** | Free | Always online, real hosting | Needs a card for sign-up verification and some Linux setup: install Node, copy the project, `npm install && npm run build`, run with `pm2 start server/index.js`. |

Avoid free tiers **without a persistent disk** (for example Render's free web service): the SQLite file is wiped on every restart and you lose your bugs.
Free-tier terms change, so check each provider's current limits before you rely on one.
