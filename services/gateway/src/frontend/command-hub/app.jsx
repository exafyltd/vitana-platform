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
  const [activeTab, setActiveTab] = useState('tasks'); // Default to tasks for verification

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
