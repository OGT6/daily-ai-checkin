// Complete Node.js Backend for Daily AI Check-in System
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const cron = require('node-cron');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Database setup
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/tasks.db' : './tasks.db';
const db = new sqlite3.Database(dbPath);

// Database schema
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'new',
    priority TEXT DEFAULT 'medium',
    category TEXT DEFAULT 'general',
    intent TEXT,
    source TEXT DEFAULT 'manual',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_touched DATETIME DEFAULT CURRENT_TIMESTAMP,
    next_review_date DATE,
    neglect_count INTEGER DEFAULT 0,
    completion_date DATETIME,
    archive_date DATETIME,
    original_transcription TEXT,
    ai_summary TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS daily_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_date DATE UNIQUE,
    completed BOOLEAN DEFAULT FALSE,
    yesterday_focus_status TEXT,
    today_priorities TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS voice_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_transcription TEXT,
    ai_analysis TEXT,
    processed BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    task_id INTEGER,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`);

  // Insert sample data for testing
  db.run(`INSERT OR IGNORE INTO tasks (id, title, description, status, priority, category, last_touched, neglect_count) VALUES 
    (1, 'Update Macbeth lesson plans with new assessment criteria', 'Need to align with latest GCSE requirements', 'active', 'high', 'teaching', datetime('now', '-8 days'), 8),
    (2, 'Research Lindy.AI vs n8n implementation costs', 'Compare platforms for voice-to-RAG workflow', 'active', 'medium', 'business', datetime('now', '-5 days'), 5),
    (3, 'Create TikTok content series for GCSE English revision', 'Short video content for student engagement', 'parked', 'medium', 'content', datetime('now', '-14 days'), 14),
    (4, 'Launch online course platform for premium students', 'Archived idea from earlier in the year', 'archived', 'high', 'business', datetime('now', '-180 days'), 180)`);
});

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Voice capture endpoint (for Apple Shortcut)
app.post('/api/voice-capture', async (req, res) => {
  try {
    const { transcription, timestamp, audio_data } = req.body;
    
    if (!transcription) {
      return res.status(400).json({ error: 'Transcription required' });
    }

    console.log('Received voice capture:', transcription.substring(0, 100));
    
    // Analyze transcription with AI
    const analysis = await analyzeVoiceCapture(transcription);
    
    // Store voice capture
    const stmt = db.prepare(`
      INSERT INTO voice_captures (audio_transcription, ai_analysis)
      VALUES (?, ?)
    `);
    
    stmt.run([transcription, JSON.stringify(analysis)], function(err) {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      // Create task if actionable
      if (analysis.actionable) {
        createTaskFromVoice(this.lastID, analysis, transcription);
      }
      
      res.json({ 
        success: true, 
        captureId: this.lastID,
        analysis: analysis,
        message: analysis.actionable ? 'Task created successfully' : 'Voice note captured'
      });
    });
    
  } catch (error) {
    console.error('Voice capture error:', error);
    res.status(500).json({ error: 'Processing failed: ' + error.message });
  }
});

// Get dashboard data
app.get('/api/dashboard', (req, res) => {
  const queries = {
    active: `SELECT * FROM tasks WHERE status = 'active' AND completion_date IS NULL ORDER BY priority DESC, updated_at DESC`,
    neglected: `SELECT *, 
      CASE 
        WHEN julianday('now') - julianday(last_touched) > 7 THEN 'high'
        WHEN julianday('now') - julianday(last_touched) > 3 THEN 'medium'
        ELSE 'low'
      END as neglect_level,
      CAST(julianday('now') - julianday(last_touched) AS INTEGER) as days_neglected
      FROM tasks 
      WHERE status IN ('active', 'parked') 
      AND julianday('now') - julianday(last_touched) > 3
      AND completion_date IS NULL
      ORDER BY days_neglected DESC`,
    parked: `SELECT *, 
      CAST(julianday('now') - julianday(updated_at) AS INTEGER) as days_parked
      FROM tasks 
      WHERE status = 'parked' 
      AND completion_date IS NULL
      ORDER BY days_parked DESC`,
    archived_review: `SELECT * FROM tasks 
      WHERE status = 'archived' 
      AND (next_review_date <= date('now') OR next_review_date IS NULL)
      ORDER BY archive_date ASC`,
    stats: `SELECT 
      COUNT(CASE WHEN status = 'active' AND completion_date IS NULL THEN 1 END) as active_count,
      COUNT(CASE WHEN status = 'parked' AND completion_date IS NULL THEN 1 END) as parked_count,
      COUNT(CASE WHEN status = 'archived' THEN 1 END) as archived_count,
      COUNT(CASE WHEN julianday('now') - julianday(last_touched) > 3 AND status IN ('active', 'parked') AND completion_date IS NULL THEN 1 END) as neglected_count
      FROM tasks`
  };

  Promise.all([
    queryAsync(queries.active),
    queryAsync(queries.neglected), 
    queryAsync(queries.parked),
    queryAsync(queries.archived_review),
    queryAsync(queries.stats)
  ]).then(([active, neglected, parked, archived, stats]) => {
    res.json({
      active_tasks: active,
      neglected_items: neglected,
      parked_items: parked,
      archived_review: archived,
      stats: stats[0] || { active_count: 0, parked_count: 0, archived_count: 0, neglected_count: 0 }
    });
  }).catch(err => {
    console.error('Dashboard query error:', err);
    res.status(500).json({ error: 'Database error' });
  });
});

// Update task status
app.put('/api/tasks/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  
  let updateQuery = `UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP, last_touched = CURRENT_TIMESTAMP`;
  let params = [status];
  
  // Handle different status changes
  if (status === 'completed') {
    updateQuery += `, completion_date = CURRENT_TIMESTAMP`;
  } else if (status === 'archived') {
    updateQuery += `, archive_date = CURRENT_TIMESTAMP, next_review_date = date('now', '+6 months')`;
  } else if (status === 'active') {
    updateQuery += `, next_review_date = date('now', '+7 days')`;
  }
  
  if (notes) {
    updateQuery += `, ai_summary = ?`;
    params.push(notes);
  }
  
  updateQuery += ` WHERE id = ?`;
  params.push(id);
  
  db.run(updateQuery, params, function(err) {
    if (err) {
      console.error('Update error:', err);
      return res.status(500).json({ error: 'Update failed' });
    }
    
    res.json({ 
      success: true, 
      changes: this.changes,
      message: `Task ${status} successfully` 
    });
  });
});

// Daily session management
app.post('/api/daily-session', async (req, res) => {
  const { yesterday_focus_status, today_priorities, notes } = req.body;
  const today = new Date().toISOString().split('T')[0];
  
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO daily_sessions 
    (session_date, yesterday_focus_status, today_priorities, notes, completed)
    VALUES (?, ?, ?, ?, TRUE)
  `);
  
  stmt.run([today, yesterday_focus_status, today_priorities, notes], function(err) {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ error: 'Session save failed' });
    }
    
    res.json({ success: true, sessionId: this.lastID });
  });
});

// AI response endpoint
app.post('/api/ai-response', async (req, res) => {
  try {
    const { query, context } = req.body;
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are Stephen's AI productivity assistant. You're direct, supportive, and help with accountability. 
          Current context: ${JSON.stringify(context)}
          
          Respond as if speaking directly to Stephen in his daily check-in. Be concise but helpful.
          Use his name occasionally. Reference specific tasks and timeframes when relevant.
          Apply gentle pressure for decisions on neglected items.`
        },
        {
          role: "user",
          content: query
        }
      ],
      max_tokens: 200,
      temperature: 0.7
    });
    
    res.json({ 
      response: response.choices[0].message.content.replace(/"/g, '')
    });
    
  } catch (error) {
    console.error('AI response error:', error);
    res.status(500).json({ error: 'AI processing failed' });
  }
});

// Helper Functions
async function analyzeVoiceCapture(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Analyze this voice note and respond with only valid JSON:
          {
            "transcription": "the full text",
            "intent": "task|idea|question|update|note",
            "priority": "high|medium|low", 
            "category": "teaching|business|personal|content|admin",
            "actionable": true|false,
            "summary": "one sentence summary",
            "suggested_title": "short task title if actionable"
          }`
        },
        {
          role: "user",
          content: transcription
        }
      ],
      temperature: 0.1,
      max_tokens: 150
    });
    
    const result = JSON.parse(response.choices[0].message.content);
    return result;
  } catch (error) {
    console.error('AI analysis error:', error);
    return {
      transcription,
      intent: "note",
      priority: "medium",
      category: "general", 
      actionable: false,
      summary: transcription.substring(0, 100),
      suggested_title: "Voice note"
    };
  }
}

function createTaskFromVoice(voiceCaptureId, analysis, transcription) {
  const stmt = db.prepare(`
    INSERT INTO tasks (title, description, status, priority, category, intent, source, original_transcription, ai_summary, next_review_date)
    VALUES (?, ?, 'new', ?, ?, ?, 'voice', ?, ?, date('now', '+3 days'))
  `);
  
  stmt.run([
    analysis.suggested_title || analysis.summary,
    transcription,
    analysis.priority,
    analysis.category,
    analysis.intent,
    transcription,
    analysis.summary
  ], function(err) {
    if (err) {
      console.error('Task creation error:', err);
    } else {
      // Link voice capture to task
      db.run(`UPDATE voice_captures SET task_id = ?, processed = TRUE WHERE id = ?`, 
        [this.lastID, voiceCaptureId]);
      console.log(`Created task ${this.lastID} from voice capture`);
    }
  });
}

function queryAsync(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Automated Jobs (disabled in production for now)
if (process.env.NODE_ENV !== 'production') {
  // Daily neglect tracking (runs every morning at 8 AM)
  cron.schedule('0 8 * * *', () => {
    console.log('Running daily neglect check...');
    
    db.run(`
      UPDATE tasks 
      SET neglect_count = CAST(julianday('now') - julianday(last_touched) AS INTEGER)
      WHERE status IN ('active', 'parked') 
      AND completion_date IS NULL
    `);
  });
}

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// ✅ FIXED: Bind to 0.0.0.0 so Railway can access your app
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Daily AI Check-in Backend running on port ${port}`);
  console.log(`📊 Dashboard available at: http://0.0.0.0:${port}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
