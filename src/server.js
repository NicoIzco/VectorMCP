import express from 'express';
import { parseSource, parseSkillsDir } from './parsers.js';
import { ActivityTracker } from './analytics.js';
import { SourceMeta, ensureDataDir, LocalEmbedder, ToolRegistry, VectorStore, saveConfig } from './core.js';

export async function bootstrap(config) {
  ensureDataDir(config.dataDir);
  const tools = new ToolRegistry(config.dataDir);
  tools.load();
  const embedder = new LocalEmbedder();
  const index = new VectorStore(`${config.dataDir}/index.json`);
  index.load();
  const sourceMeta = new SourceMeta(config.dataDir);
  sourceMeta.load();
  const analytics = new ActivityTracker(config.dataDir);
  analytics.load();
  const sessionHistory = new Map();

  async function syncSource(source) {
    const sourceId = source.path || source.url;
    sourceMeta.set(sourceId, { status: 'syncing', lastSync: sourceMeta.get(sourceId)?.lastSync, toolCount: sourceMeta.get(sourceId)?.toolCount || 0, error: null });
    try {
      const parsed = await parseSource(source, config.dataDir);
      tools.removeBySource(sourceId);
      tools.upsertMany(parsed);
      index.rebuild(tools.tools, embedder);
      sourceMeta.set(sourceId, {
        status: 'synced',
        lastSync: new Date().toISOString(),
        toolCount: parsed.length,
        error: null
      });
      analytics.recordEvent('sync', `Synced: ${sourceId} — ${parsed.length} tools`);
      return parsed.length;
    } catch (error) {
      sourceMeta.set(sourceId, {
        status: 'error',
        lastSync: sourceMeta.get(sourceId)?.lastSync || null,
        toolCount: sourceMeta.get(sourceId)?.toolCount || 0,
        error: error.message
      });
      analytics.recordEvent('error', `Error syncing: ${sourceId} — ${error.message}`);
      throw error;
    }
  }

  async function syncAll() {
    for (const source of config.sources) {
      await syncSource(source);
    }
  }


  if (tools.tools.length === 0 && config.sources.length > 0) {
    await syncAll();
  }

  // Auto-discover Claude Skills from skillsDir
  const skillsDir = config.skillsDir || './skills';
  const skills = parseSkillsDir(skillsDir);
  if (skills.length > 0) {
    tools.upsertMany(skills);
    index.rebuild(tools.tools, embedder);
    console.log(`Loaded ${skills.length} Claude Skill(s) from ${skillsDir}`);
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, tools: tools.tools.length }));

  app.get('/mcp/tools', (_req, res) => {
    res.json({ tools: tools.tools.map(toMcpSchema) });
  });

  app.post('/mcp/query', (req, res) => {
    const query = req.body?.query || '';
    const topK = Number(req.body?.topK || config.topK || 5);
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : null;
    let matches = index.search(query, embedder, topK);

    if (sessionId) {
      const previousToolIds = new Set(sessionHistory.get(sessionId) || []);
      matches = matches
        .map((match) => ({
          ...match,
          score: previousToolIds.has(match.tool.id) ? match.score * 1.3 : match.score
        }))
        .sort((a, b) => b.score - a.score);
    }

    analytics.recordQuery(query);
    analytics.recordEvent('query', `Query: ${query} — ${matches.length} results`);

    if (sessionId) {
      const matchedToolIds = matches.map((match) => match.tool.id).slice(-20);
      sessionHistory.set(sessionId, matchedToolIds);
    }

    res.json({ query, matches });
  });

  app.post('/mcp/invoke', (req, res) => {
    const { toolId, args } = req.body || {};
    const tool = tools.tools.find((t) => t.id === toolId);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    if (tool.invoke.type === 'noop') {
      return res.json({ tool: tool.name, result: 'No-op tool registered', args });
    }
    return res.json({ tool: tool.name, result: 'Invocation proxy not yet implemented', args, invoke: tool.invoke });
  });

  app.post('/sources/sync', async (req, res) => {
    try {
      const target = req.body?.source;
      if (target) {
        const source = config.sources.find((s) => (s.path || s.url) === target);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        const added = await syncSource(source);
        return res.json({ synced: 1, added });
      }
      await syncAll();
      return res.json({ synced: config.sources.length });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/sources/add', async (req, res) => {
    const { type, path, url, category } = req.body || {};
    if (!type) return res.status(400).json({ error: 'type is required' });
    const normalizedType = String(type);
    const id = normalizedType === 'file' ? path : url;
    if (normalizedType === 'file' && !path) return res.status(400).json({ error: 'path is required for file source' });
    if ((normalizedType === 'repo' || normalizedType === 'webmcp') && !url) return res.status(400).json({ error: 'url is required for repo/webmcp source' });
    if (!['file', 'repo', 'webmcp'].includes(normalizedType)) return res.status(400).json({ error: 'invalid source type' });

    const exists = config.sources.some((s) => (s.path || s.url) === id);
    if (exists) return res.status(409).json({ error: 'Source already exists' });

    const source = {
      type: normalizedType,
      category: category || 'general',
      ...(normalizedType === 'file' ? { path } : { url })
    };

    config.sources.push(source);
    saveConfig(config);

    try {
      await syncSource(source);
      analytics.recordEvent('source', `Source added: ${id}`);
      return res.json({ ok: true, source });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.delete('/sources/remove', (req, res) => {
    const sourceId = req.body?.source;
    if (!sourceId) return res.status(400).json({ error: 'source is required' });
    const before = config.sources.length;
    config.sources = config.sources.filter((s) => (s.path || s.url) !== sourceId);
    if (before === config.sources.length) return res.status(404).json({ error: 'Source not found' });

    tools.removeBySource(sourceId);
    index.rebuild(tools.tools, embedder);
    sourceMeta.remove(sourceId);
    saveConfig(config);
    analytics.recordEvent('source', `Source deleted: ${sourceId}`);
    return res.json({ ok: true, removed: sourceId });
  });

  app.get('/sources/list', (_req, res) => {
    const sources = config.sources.map((source) => {
      const sourceId = source.path || source.url;
      const meta = sourceMeta.get(sourceId) || {};
      const toolCount = tools.tools.filter((tool) => tool.source === sourceId || String(tool.source || '').startsWith(`${sourceId}#`)).length;
      return {
        ...source,
        status: meta.status || 'idle',
        lastSync: meta.lastSync || null,
        toolCount,
        error: meta.error || null
      };
    });
    res.json({ sources });
  });

  app.get('/analytics/queries', (_req, res) => {
    res.json({ queries: analytics.getQueryFrequency(10) });
  });

  app.get('/analytics/activity', (_req, res) => {
    res.json({ events: analytics.getActivity(50) });
  });

  app.get('/dashboard', (_req, res) => {
    res.type('html').send(renderDashboard());
  });

  const server = app.listen(config.port, () => {
    console.log(`VectorMCP running on http://localhost:${config.port}`);
  });

  return { app, server, tools, index, syncAll, sourceMeta, analytics };
}

function toMcpSchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.params || {}
    },
    metadata: {
      toolId: tool.id,
      category: tool.category,
      source: tool.source,
      ...(tool.skillFormat && {
        skillFormat: true,
        version: tool.version || null,
        dependencies: tool.dependencies || []
      })
    }
  };
}

function renderDashboard() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VectorMCP Dashboard</title>
<style>
:root {
  --bg-primary: #0f1117; --bg-secondary: #1a1d27; --bg-card: #1e2130; --bg-card-hover: #252840;
  --border: #2a2d3a; --text-primary: #e4e6f0; --text-secondary: #8b8fa3; --text-muted: #5a5e72;
  --accent-blue: #4f8ff7; --accent-green: #34d399; --accent-purple: #a78bfa; --accent-red: #f87171;
  --accent-amber: #fbbf24; --radius: 12px; --radius-sm: 8px; --shadow: 0 4px 24px rgba(0,0,0,.3);
}
* { box-sizing: border-box; }
body { margin:0; font-family: Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; background:linear-gradient(180deg,var(--bg-primary),#0b0d14); color:var(--text-primary); }
.container { max-width:1100px; margin:0 auto; padding:24px 16px 80px; }
.card { background: rgba(30,33,48,.78); border:1px solid var(--border); border-radius:var(--radius); box-shadow: var(--shadow); backdrop-filter: blur(6px); }
header { display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:20px; padding:16px; }
.brand{display:flex;gap:12px;align-items:center}.logo{width:36px;height:36px}.sub{color:var(--text-secondary);font-size:.92rem}
.badges{display:flex;gap:10px;flex-wrap:wrap}.badge{padding:6px 10px;border:1px solid var(--border);border-radius:999px;background:var(--bg-secondary);font-size:.82rem}
.dot{display:inline-block;width:8px;height:8px;border-radius:999px;background:var(--accent-green);margin-right:6px}
section{margin-top:16px;padding:16px}.section-title{font-size:1.05rem;margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}.col-4{grid-column:span 4}.col-8{grid-column:span 8}.col-12{grid-column:span 12}
input,button,select{width:100%;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px}
button{cursor:pointer;transition:.2s}button:hover{background:var(--bg-card-hover)}
.type-toggle{display:flex;gap:8px}.pill{flex:1;text-align:center;padding:8px;border:1px solid var(--border);border-radius:999px;cursor:pointer}.pill.active{background:var(--accent-blue);border-color:transparent}
.sources{display:grid;gap:10px}.source{padding:12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-secondary)}
.row{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap}.muted{color:var(--text-secondary);font-size:.88rem}
.tag{font-size:.75rem;padding:3px 8px;border-radius:999px;background:#2a3045}.t-blue{background:rgba(79,143,247,.2)}.t-green{background:rgba(52,211,153,.2)}.t-purple{background:rgba(167,139,250,.2)}
.actions{display:flex;gap:8px}.icon{width:auto;padding:6px 10px}
.results{display:grid;gap:10px}.result{padding:12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-secondary)}
.bar{height:8px;background:#121522;border-radius:99px;overflow:hidden}.bar>span{display:block;height:100%;background:linear-gradient(90deg,var(--accent-blue),var(--accent-purple))}
.table{width:100%;border-collapse:collapse}.table th,.table td{padding:8px;border-bottom:1px solid var(--border);text-align:left;font-size:.88rem}.mono{font-family: ui-monospace, SFMono-Regular, Menlo, monospace}
.collapsible{max-height:420px;overflow:auto}
.activity{max-height:220px;overflow:auto;display:grid;gap:6px}.event{padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);font-size:.86rem}
#toast{position:fixed;right:16px;bottom:16px;display:grid;gap:8px;z-index:10}.toast{padding:10px 12px;border-radius:8px;background:#20283b;border:1px solid var(--border);animation:slideIn .2s ease}
@keyframes slideIn{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}} .spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.skeleton{height:56px;border-radius:8px;background:linear-gradient(90deg,#1a1d27,#252840,#1a1d27);background-size:200% 100%;animation:sk 1.2s infinite}.empty{padding:24px;text-align:center;color:var(--text-secondary)}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
@media (max-width: 800px){.col-4,.col-8{grid-column:span 12}}
</style>
</head>
<body>
<div class="container">
<header class="card"><div class="brand"><svg class="logo" viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="30" stroke="#4f8ff7"/><path d="M32 8l9 22 15 2-12 10 4 14-16-9-16 9 4-14-12-10 15-2 9-22z" stroke="#a78bfa"/></svg><div><h1 style="margin:0">VectorMCP</h1><div class="sub">Semantic Tool Router</div></div></div><div class="badges"><div class="badge" id="healthBadge"><span class="dot"></span>Online</div><div class="badge" id="toolCount">0 tools</div></div></header>

<section class="card">
  <h2 class="section-title">Source Manager</h2>
  <div class="grid">
    <div class="col-4">
      <div class="type-toggle" id="sourceTypes"><div class="pill active" data-type="file">File</div><div class="pill" data-type="repo">Repo</div><div class="pill" data-type="webmcp">Web</div></div>
      <label class="muted" id="sourceLabel">File path (e.g. ./skills.md)</label>
      <input id="sourceInput" placeholder="./skills.md" />
      <label class="muted">Category</label>
      <input id="categoryInput" placeholder="general" />
      <div class="muted" style="margin:6px 0 10px">Used for filtering</div>
      <button id="addSourceBtn">Add Source</button>
    </div>
    <div class="col-8">
      <div id="sourceList" class="sources"><div class="skeleton"></div><div class="skeleton"></div></div>
    </div>
  </div>
</section>

<section class="card">
  <h2 class="section-title">Semantic Search</h2>
  <div class="grid"><div class="col-8"><input id="queryInput" placeholder="manage tasks" /></div><div class="col-4"><div class="actions"><button id="searchBtn">Search</button><button id="clearSearchBtn" style="display:none">Clear</button></div></div></div>
  <div id="searchResults" class="results" style="margin-top:10px"><div class="empty">No tools indexed yet. Add a source and sync to get started.</div></div>
</section>

<section class="card">
  <details>
    <summary style="cursor:pointer"><strong id="invHeader">Tool Inventory (0 tools)</strong></summary>
    <div style="margin-top:10px" class="collapsible">
      <div class="grid"><div class="col-4"><select id="categoryFilter"><option value="">All categories</option></select></div><div class="col-4"><select id="sortBy"><option value="name">Sort: Name</option><option value="category">Sort: Category</option></select></div></div>
      <table class="table" id="toolTable"><thead><tr><th>Name</th><th>Description</th><th>Category</th><th>Source</th><th>ID</th></tr></thead><tbody></tbody></table>
    </div>
  </details>
</section>

<section class="card">
  <h2 class="section-title">Usage Analytics</h2>
  <h3 class="muted">Query Frequency</h3>
  <div id="queryChart"></div>
  <h3 class="muted">Activity Log</h3>
  <div id="activityLog" class="activity"></div>
</section>
</div>
<div id="toast"></div>
<script>
let currentType = 'file'; let allTools = []; let allSources = [];
const typeMeta = { file:{label:'File path (e.g. ./skills.md)',placeholder:'./skills.md'}, repo:{label:'Git URL (e.g. https://github.com/user/tools)',placeholder:'https://github.com/user/tools'}, webmcp:{label:'WebMCP URL (e.g. https://example.com)',placeholder:'https://example.com'} };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const truncate = (s,n=80) => (s && s.length>n ? s.slice(0,n)+'…' : (s||''));
const defaultSearchEmptyState = '<div class="empty">No tools indexed yet. Add a source and sync to get started.</div>';
function toast(msg,isErr=false){const t=document.createElement('div');t.className='toast';t.style.borderColor=isErr?'var(--accent-red)':'var(--border)';t.textContent=msg;toastEl.appendChild(t);setTimeout(()=>t.remove(),3000)}
function rel(ts){if(!ts) return 'Never'; const d=(Date.now()-new Date(ts))/1000; if(d<60)return Math.floor(d)+' sec ago'; if(d<3600)return Math.floor(d/60)+' min ago'; if(d<86400)return Math.floor(d/3600)+' hr ago'; return Math.floor(d/86400)+' day ago';}
async function refreshHealth(){const r=await fetch('/health');const j=await r.json();toolCount.textContent=j.tools+' tools';healthBadge.innerHTML='<span class="dot"></span>'+(j.ok?'Online':'Offline')}
async function refreshSources(){const r=await fetch('/sources/list');const j=await r.json();allSources=j.sources||[]; if(!allSources.length){sourceList.innerHTML='<div class="empty"><svg width="80" height="50" viewBox="0 0 80 50"><rect x="5" y="15" width="70" height="30" rx="6" stroke="#4f8ff7" fill="none"/><path d="M10 20h60" stroke="#8b8fa3"/></svg><div>No sources yet — add your first skill file, repo, or website above.</div></div>'; return;}
sourceList.innerHTML=allSources.map((s)=>{const id=s.path||s.url;const cls=s.type==='file'?'t-blue':(s.type==='repo'?'t-green':'t-purple');const icon=s.type==='file'?'📁 File':(s.type==='repo'?'🔗 Repo':'🌐 Web');const stat=s.status==='error'?'❌ Error':(s.status==='syncing'?'🔄 Syncing...':'✅ Synced');const escapedId=esc(id).replace(/'/g,'&apos;');return '<div class="source"><div class="row"><span class="tag '+cls+'">'+icon+'</span><strong title="'+esc(id)+'">'+esc(truncate(id,68))+'</strong><span class="tag">'+esc(s.category||'general')+'</span></div><div class="row muted"><span>'+rel(s.lastSync)+'</span><span>'+s.toolCount+' tools</span><span>'+stat+'</span></div>'+(s.error?'<details><summary class="muted">Error details</summary><div style="color:var(--accent-red)">'+esc(s.error)+'</div></details>':'')+'<div class="actions" style="margin-top:8px"><button class="icon" onclick="syncOne(&apos;'+escapedId+'&apos;, this)">🔄</button><button class="icon" data-id="'+esc(id)+'" onclick="confirmDelete(this)">🗑️</button></div></div>'}).join('');}
async function refreshTools(){const r=await fetch('/mcp/tools');const j=await r.json();allTools=(j.tools||[]).map((t)=>({name:t.name,description:t.description,category:t.metadata?.category||'',source:t.metadata?.source||'',id:t.metadata?.toolId||''}));renderToolInventory();}
function renderToolInventory(){invHeader.textContent='Tool Inventory ('+allTools.length+' tools)'; const categories=[...new Set(allTools.map(t=>t.category).filter(Boolean))].sort(); categoryFilter.innerHTML='<option value="">All categories</option>'+categories.map(c=>'<option>'+esc(c)+'</option>').join(''); applyFilters();}
function applyFilters(){const cat=categoryFilter.value;const sort=sortBy.value;let rows=allTools.filter(t=>!cat||t.category===cat);rows.sort((a,b)=>String(a[sort]||'').localeCompare(String(b[sort]||'')));toolTable.querySelector('tbody').innerHTML=rows.map(t=>'<tr><td>'+esc(t.name)+'</td><td title="'+esc(t.description)+'">'+esc(truncate(t.description,55))+'</td><td>'+esc(t.category)+'</td><td title="'+esc(t.source)+'">'+esc(truncate(t.source,30))+'</td><td class="mono" title="'+esc(t.id)+'">'+esc(truncate(t.id,24))+'</td></tr>').join('');}
function clearSearchResults(){queryInput.value='';searchResults.innerHTML=defaultSearchEmptyState;clearSearchBtn.style.display='none';}
async function runSearch(){const query=queryInput.value.trim();if(!query)return;searchBtn.disabled=true;searchBtn.textContent='Searching...';try{const r=await fetch('/mcp/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query,topK:5})});const j=await r.json();const m=j.matches||[];clearSearchBtn.style.display='block';if(!m.length){searchResults.innerHTML='<div class="empty">No matches found for your query.</div>';return;}searchResults.innerHTML=m.map((x)=>{const pct=Math.max(0,Math.min(100,Math.round((x.score||0)*100)));const t=x.tool||{};return '<div class="result"><div class="row"><strong>'+esc(t.name||'Unnamed')+'</strong><span>'+pct+'%</span></div><div class="muted" title="'+esc(t.description||'')+'">'+esc(truncate(t.description,120))+'</div><div class="bar" style="margin:8px 0"><span style="width:'+pct+'%"></span></div><div class="row"><span class="tag">'+esc(t.source||'unknown')+'</span><span class="tag">'+esc(t.category||'general')+'</span></div></div>';}).join('');await Promise.all([refreshAnalytics(),refreshActivity()]);}catch(e){toast(e.message,true)}finally{searchBtn.disabled=false;searchBtn.textContent='Search';}}
async function addSource(){const value=sourceInput.value.trim();if(!value) return;addSourceBtn.disabled=true;try{const body={type:currentType,category:categoryInput.value.trim()||'general'};if(currentType==='file') body.path=value; else body.url=value;const r=await fetch('/sources/add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok) throw new Error(j.error||'Failed');toast('Source added successfully');sourceInput.value='';await Promise.all([refreshSources(),refreshTools(),refreshHealth(),refreshActivity()]);}catch(e){toast(e.message,true)}finally{addSourceBtn.disabled=false;}}
async function syncOne(id,btn){btn.innerHTML='<span class="spin">⟳</span>';btn.disabled=true;try{const r=await fetch('/sources/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:id})});const j=await r.json();if(!r.ok) throw new Error(j.error||'Sync failed');toast('Sync completed');await Promise.all([refreshSources(),refreshTools(),refreshHealth(),refreshActivity()]);}catch(e){toast(e.message,true)}finally{btn.disabled=false;btn.textContent='🔄';}}
function confirmDelete(btn){const id=btn.dataset.id;if(btn.dataset.confirm==='1'){removeSource(id);return;}btn.dataset.confirm='1';btn.textContent='Confirm? ✓ ✗';setTimeout(()=>{btn.dataset.confirm='0';btn.textContent='🗑️';},3000)}
async function removeSource(id){try{const r=await fetch('/sources/remove',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({source:id})});const j=await r.json();if(!r.ok) throw new Error(j.error||'Delete failed');toast('Source deleted');await Promise.all([refreshSources(),refreshTools(),refreshHealth(),refreshActivity()]);}catch(e){toast(e.message,true)}}
async function refreshAnalytics(){const r=await fetch('/analytics/queries');const j=await r.json();const list=j.queries||[];if(!list.length){queryChart.innerHTML='<div class="empty">No queries recorded yet.</div>';return;}const max=Math.max(...list.map(x=>x.count),1);queryChart.innerHTML=list.map((q)=>'<div style="margin-bottom:8px"><div class="row muted"><span>'+esc(truncate(q.text,40))+'</span><span>'+q.count+'</span></div><div class="bar"><span style="width:'+Math.round((q.count/max)*100)+'%;background:linear-gradient(90deg,var(--accent-green),var(--accent-blue))"></span></div></div>').join('');}
async function refreshActivity(){const r=await fetch('/analytics/activity');const j=await r.json();const ev=j.events||[];activityLog.innerHTML=ev.length?ev.map((e)=>'<div class="event"><div>'+esc(e.message)+'</div><div class="muted">'+new Date(e.timestamp).toLocaleString()+'</div></div>').join(''):'<div class="empty">No activity yet.</div>';}
sourceTypes.querySelectorAll('.pill').forEach((p)=>p.onclick=()=>{sourceTypes.querySelectorAll('.pill').forEach((n)=>n.classList.remove('active'));p.classList.add('active');currentType=p.dataset.type;sourceLabel.textContent=typeMeta[currentType].label;sourceInput.placeholder=typeMeta[currentType].placeholder;});
addSourceBtn.onclick=addSource;searchBtn.onclick=runSearch;clearSearchBtn.onclick=clearSearchResults;categoryFilter.onchange=applyFilters;sortBy.onchange=applyFilters;queryInput.addEventListener('keydown',(e)=>{if(e.key==='Enter')runSearch();});
const toastEl=document.getElementById('toast');
Promise.all([refreshHealth(),refreshSources(),refreshTools(),refreshAnalytics(),refreshActivity()]);
setInterval(refreshSources,30000);setInterval(refreshHealth,15000);
</script>
</body>
</html>`;
}
