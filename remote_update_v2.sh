#!/bin/bash
set -euo pipefail

echo "🚀 Starting Command Hub V2 Remote Update..."

# Define paths
FRONTEND_DIR="$HOME/vitana-platform/services/gateway/src/frontend/command-hub"
GATEWAY_DIR="$HOME/vitana-platform/services/gateway"

# Ensure directory exists
mkdir -p "$FRONTEND_DIR"

echo "📝 Writing V2 files to $FRONTEND_DIR..."

# 1. index.html
cat > "$FRONTEND_DIR/index.html" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vitana Command Hub</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="root"></div>
  <script src="./app.js"></script>
</body>
</html>
EOF

# 2. package.json
cat > "$FRONTEND_DIR/package.json" << 'EOF'
{
  "name": "command-hub-frontend",
  "version": "1.0.0",
  "description": "Command Hub Frontend V2",
  "main": "app.js",
  "scripts": {
    "build": "esbuild app.jsx --bundle --outfile=app.js --minify --sourcemap --loader:.js=jsx"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "esbuild": "^0.19.0"
  }
}
EOF

# 3. styles.css
cat > "$FRONTEND_DIR/styles.css" << 'EOF'
/* --- Original Shell Styles --- */
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e1a; color: #e4e4e7; height: 100vh; overflow: hidden; }
.app-container { display: flex; flex-direction: column; height: 100vh; }
.app-header { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-bottom: 1px solid #334155; padding: 0; display: flex; flex-direction: column; }
.header-top { padding: 1rem 1.5rem; display: flex; justify-content: space-between; align-items: center; }
.app-title { font-size: 1.5rem; font-weight: 700; color: #60a5fa; display: flex; align-items: center; gap: 0.5rem; }
.status-indicator { display: flex; align-items: center; gap: 0.75rem; font-size: 0.875rem; color: #94a3b8; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.nav-tabs { display: flex; gap: 0; padding: 0 1.5rem; background: #0f172a; }
.nav-tab { padding: 0.75rem 1.5rem; background: transparent; border: none; color: #94a3b8; font-size: 0.875rem; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.2s ease; }
.nav-tab:hover { color: #e4e4e7; background: rgba(96, 165, 250, 0.05); }
.nav-tab.active { color: #60a5fa; border-bottom-color: #60a5fa; }
.app-content { flex: 1; overflow: hidden; position: relative; }
.tab-panel { display: none; height: 100%; overflow: auto; }
.tab-panel.active { display: block; }

/* Live Console Styles */
.live-console { display: flex; height: 100%; }
.event-ticker { width: 40%; border-right: 1px solid #334155; padding: 1.5rem; overflow-y: auto; }
.event-ticker h2 { font-size: 1.25rem; color: #60a5fa; margin-bottom: 1rem; }
.event-item { background: #1e293b; border-radius: 6px; padding: 0.875rem; margin-bottom: 0.75rem; border-left: 3px solid #60a5fa; font-size: 0.875rem; }
.event-type { font-weight: 600; margin-bottom: 0.25rem; color: #e4e4e7; }
.event-meta { font-size: 0.75rem; color: #64748b; margin-top: 0.5rem; }
.chat-panel { width: 60%; display: flex; flex-direction: column; }
.chat-header { padding: 1.5rem; border-bottom: 1px solid #334155; }
.chat-header h2 { color: #60a5fa; font-size: 1.25rem; margin-bottom: 0.25rem; }
.chat-subtitle { font-size: 0.75rem; color: #64748b; }
.chat-messages { flex: 1; padding: 1.5rem; overflow-y: auto; }
.message { background: #1e293b; border-radius: 6px; padding: 0.875rem; margin-bottom: 0.875rem; border-left: 3px solid #60a5fa; }
.message.user { border-left-color: #10b981; }
.chat-input-box { padding: 1.5rem; border-top: 1px solid #334155; display: flex; gap: 0.75rem; }
.chat-input { flex: 1; padding: 0.75rem; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e4e4e7; font-size: 0.875rem; }
.chat-input:focus { outline: none; border-color: #60a5fa; }
.send-btn { padding: 0.75rem 1.5rem; background: #60a5fa; color: #fff; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; transition: background 0.2s ease; }
.send-btn:hover { background: #3b82f6; }

/* --- Golden Board Styles --- */
.task-board {
  display: flex;
  justify-content: space-between;
  padding: 1rem;
  gap: 1rem;
  height: 100%;
  background: #0a0e1a;
}

.task-column {
  flex: 1;
  background-color: #1e1e1e;
  border-radius: 8px;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  border: 1px solid #334155;
}

.task-column-header {
  font-size: 1.1rem;
  font-weight: 600;
  text-align: center;
  margin-bottom: 0.75rem;
  color: #60a5fa;
  position: sticky;
  top: 0;
  background-color: #1e1e1e;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #334155;
  z-index: 10;
}

.task-card {
  background-color: #2a2a2a;
  border-radius: 6px;
  padding: 0.875rem;
  margin: 0.25rem 0;
  border-left: 4px solid #f59e0b;
  cursor: pointer;
  transition: background-color 0.2s;
}

.task-card:hover {
  background-color: #334155;
}

.task-card .title {
  font-weight: 500;
  margin-bottom: 0.25rem;
  color: #e4e4e7;
}

.task-card .vtid {
  font-size: 0.75rem;
  color: #94a3b8;
  font-family: monospace;
}

.task-card .status {
  font-size: 0.75rem;
  color: #60a5fa;
  margin-top: 0.25rem;
  text-transform: uppercase;
}

.loading, .error {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  font-size: 1rem;
  color: #94a3b8;
}

.error {
  color: #ef4444;
}
EOF

# 4. app.jsx
cat > "$FRONTEND_DIR/app.jsx" << 'EOF'
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

/* --- Components --- */

const TaskCard = ({ task }) => (
  <div className="task-card">
    <div className="title">{task.title || task.description || 'Untitled Task'}</div>
    <div className="vtid">{task.vtid}</div>
    <div className="status">{task.displayStatus}</div>
  </div>
);

const TaskColumn = ({ title, tasks }) => (
  <div className="task-column">
    <div className="task-column-header">{title}</div>
    {tasks.map(task => (
      <TaskCard key={task.vtid} task={task} />
    ))}
  </div>
);

const TaskBoard = () => {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/v1/oasis/tasks?limit=50')
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch tasks');
        return res.json();
      })
      .then(data => {
        const rawTasks = data.tasks || [];
        const normalizedTasks = rawTasks.map(t => {
          let displayStatus = t.status;
          let column = 'Scheduled';

          if (t.status === 'OPEN') {
            displayStatus = 'Scheduled';
            column = 'Scheduled';
          } else if (t.status === 'IN_PROGRESS') {
            displayStatus = 'In Progress';
            column = 'In Progress';
          } else if (t.status === 'COMPLETED' || t.status === 'DONE') {
            displayStatus = 'Completed';
            column = 'Completed';
          } else {
            column = 'Scheduled';
          }
          
          return { ...t, displayStatus, column };
        });
        
        setTasks(normalizedTasks);
        setLoading(false);
      })
      .catch(err => {
        console.error('Error fetching tasks:', err);
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="loading">Loading tasks...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  const scheduled = tasks.filter(t => t.column === 'Scheduled');
  const inProgress = tasks.filter(t => t.column === 'In Progress');
  const completed = tasks.filter(t => t.column === 'Completed');

  return (
    <div className="task-board">
      <TaskColumn title="Scheduled" tasks={scheduled} />
      <TaskColumn title="In Progress" tasks={inProgress} />
      <TaskColumn title="Completed" tasks={completed} />
    </div>
  );
};

const LiveConsole = () => (
  <div className="live-console">
    <div className="event-ticker">
      <h2>Live Events</h2>
      <div id="events-list"><div className="loading">Live events placeholder</div></div>
    </div>
    <div className="chat-panel">
      <div className="chat-header">
        <h2>Command Hub</h2>
        <p className="chat-subtitle">Ask naturally | /help for commands</p>
      </div>
      <div className="chat-messages">
        <div className="message">System: Live Console React Port Active</div>
      </div>
      <div className="chat-input-box">
        <input type="text" className="chat-input" placeholder="Type message..." disabled />
        <button className="send-btn" disabled>Send</button>
      </div>
    </div>
  </div>
);

const CommandHub = () => {
  const [activeTab, setActiveTab] = useState('tasks');

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-top">
          <h1 className="app-title"><span>⚡</span><span>Vitana Command HUB</span></h1>
          <div className="status-indicator">
            <div className="status-dot"></div>
            <span>Connected</span>
          </div>
        </div>
        <nav className="nav-tabs">
          <button 
            className={`nav-tab ${activeTab === 'live' ? 'active' : ''}`}
            onClick={() => setActiveTab('live')}
          >
            LIVE Console
          </button>
          <button 
            className={`nav-tab ${activeTab === 'tasks' ? 'active' : ''}`}
            onClick={() => setActiveTab('tasks')}
          >
            Tasks
          </button>
        </nav>
      </header>
      <main className="app-content">
        <div className={`tab-panel ${activeTab === 'live' ? 'active' : ''}`}>
          <LiveConsole />
        </div>
        <div className={`tab-panel ${activeTab === 'tasks' ? 'active' : ''}`}>
          <TaskBoard />
        </div>
      </main>
    </div>
  );
};

const root = createRoot(document.getElementById('root'));
root.render(<CommandHub />);
EOF

echo "✅ Files updated."

echo "🔨 Building Frontend..."
cd "$FRONTEND_DIR"
npm install
npm run build

echo "🔨 Building Gateway..."
cd "$GATEWAY_DIR"
rm -rf dist
npm install
npm run build

echo "🚀 Deploying Gateway..."
cd "$HOME/vitana-platform"
./scripts/deploy/deploy-service.sh gateway services/gateway

echo "🎉 Done! Check the URL."
