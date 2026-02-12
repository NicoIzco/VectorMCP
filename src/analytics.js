import fs from 'node:fs';
import path from 'node:path';

export class ActivityTracker {
  constructor(dataDir) {
    this.queriesPath = path.join(dataDir, 'queries.json');
    this.activityPath = path.join(dataDir, 'activity.json');
    this.queries = {};
    this.activity = [];
  }

  load() {
    if (fs.existsSync(this.queriesPath)) {
      this.queries = JSON.parse(fs.readFileSync(this.queriesPath, 'utf8'));
    }
    if (fs.existsSync(this.activityPath)) {
      this.activity = JSON.parse(fs.readFileSync(this.activityPath, 'utf8'));
    }
  }

  saveQueries() {
    fs.writeFileSync(this.queriesPath, JSON.stringify(this.queries, null, 2));
  }

  saveActivity() {
    fs.writeFileSync(this.activityPath, JSON.stringify(this.activity, null, 2));
  }

  recordQuery(text) {
    const value = String(text || '').trim();
    if (!value) return;
    const current = this.queries[value] || { text: value, count: 0, lastUsed: null };
    current.count += 1;
    current.lastUsed = new Date().toISOString();
    this.queries[value] = current;
    this.saveQueries();
  }

  recordEvent(type, message) {
    const event = {
      type: String(type || 'info'),
      message: String(message || ''),
      timestamp: new Date().toISOString()
    };
    this.activity.unshift(event);
    this.activity = this.activity.slice(0, 50);
    this.saveActivity();
  }

  getQueryFrequency(topN = 10) {
    return Object.values(this.queries)
      .sort((a, b) => b.count - a.count || String(b.lastUsed).localeCompare(String(a.lastUsed)))
      .slice(0, topN);
  }

  getActivity(limit = 50) {
    return this.activity.slice(0, limit);
  }
}
