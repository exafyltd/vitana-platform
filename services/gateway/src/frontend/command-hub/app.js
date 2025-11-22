// app.js – vanilla JS rendering of a simple 3-column task board
// Dummy data – hard-coded, no API calls
const tasks = [
  { title: "Task A", vtid: "VTID-2025-0001", status: "Scheduled", column: "Scheduled" },
  { title: "Task B", vtid: "VTID-2025-0002", status: "In Progress", column: "In Progress" },
  { title: "Task C", vtid: "VTID-2025-0003", status: "Completed", column: "Completed" },
  { title: "Task D", vtid: "VTID-2025-0004", status: "Scheduled", column: "Scheduled" },
  { title: "Task E", vtid: "VTID-2025-0005", status: "In Progress", column: "In Progress" },
  { title: "Task F", vtid: "VTID-2025-0006", status: "Completed", column: "Completed" }
];

// Helper to create a task card element
function createTaskCard(task) {
  const card = document.createElement("div");
  card.className = "task-card";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = task.title;
  const vtid = document.createElement("div");
  vtid.className = "vtid";
  vtid.textContent = task.vtid;
  const status = document.createElement("div");
  status.className = "status";
  status.textContent = task.status;
  card.appendChild(title);
  card.appendChild(vtid);
  card.appendChild(status);
  return card;
}

// Build the three columns and attach cards
function renderBoard() {
  const board = document.getElementById("taskBoard");
  const columns = ["Scheduled", "In Progress", "Completed"];
  columns.forEach(colName => {
    const col = document.createElement("div");
    col.className = "task-column";
    const header = document.createElement("div");
    header.className = "task-column-header";
    header.textContent = colName;
    col.appendChild(header);
    const colTasks = tasks.filter(t => t.column === colName);
    colTasks.forEach(t => col.appendChild(createTaskCard(t)));
    board.appendChild(col);
  });
}

// Initialise when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", renderBoard);
} else {
  renderBoard();
}
