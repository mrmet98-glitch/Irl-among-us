const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const now = () => Date.now();
const id = () => crypto.randomUUID();
const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cleanName = (v) => String(v || '').trim().slice(0, 30);
const cleanText = (v, max = 120) => String(v || '').trim().slice(0, max);
const normalizeGameCode = (value) => String(value || '')
  .normalize('NFKC')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '')
  .slice(0, 6);

function randomCode(len = 6) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => codeChars[b % codeChars.length]).join('');
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const b = new Uint32Array(1); crypto.getRandomValues(b);
    const j = b[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function int(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
async function body(req) {
  try { return await req.json(); } catch { return {}; }
}
async function playerFromToken(env, token) {
  if (!token) return null;
  return env.DB.prepare('SELECT * FROM players WHERE token = ?').bind(token).first();
}
async function requirePlayer(req, env) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const player = await playerFromToken(env, token);
  if (!player) throw new Response(JSON.stringify({ error: 'Session expired. Rejoin the lobby.' }), { status: 401, headers: {'content-type':'application/json'} });
  await env.DB.prepare('UPDATE players SET last_seen=? WHERE id=?').bind(now(), player.id).run();
  return player;
}
function requireHost(player) {
  if (!player.is_host) throw new Response(JSON.stringify({ error: 'Host only.' }), { status: 403, headers: {'content-type':'application/json'} });
}

async function uniqueGameCode(env) {
  for (let i = 0; i < 20; i++) {
    const c = randomCode();
    const found = await env.DB.prepare('SELECT id FROM games WHERE code=?').bind(c).first();
    if (!found) return c;
  }
  throw new Error('Could not generate room code');
}

async function gameState(env, player) {
  const game = await env.DB.prepare('SELECT * FROM games WHERE id=?').bind(player.game_id).first();
  if (!game) return null;
  const players = (await env.DB.prepare('SELECT id,name,is_host,alive,role FROM players WHERE game_id=? ORDER BY joined_at').bind(game.id).all()).results;
  const myTasks = (await env.DB.prepare('SELECT id,title,description,is_fake,completed FROM player_tasks WHERE player_id=? ORDER BY title').bind(player.id).all()).results;
  const progress = await env.DB.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) completed FROM player_tasks WHERE game_id=? AND is_fake=0`).bind(game.id).first();
  const pool = player.is_host ? (await env.DB.prepare('SELECT id,title,description,enabled FROM task_pool WHERE game_id=? ORDER BY rowid').bind(game.id).all()).results : undefined;
  const myVote = game.meeting_status === 'voting' ? await env.DB.prepare('SELECT target_player_id FROM votes WHERE game_id=? AND meeting_number=? AND voter_player_id=?').bind(game.id, game.meeting_number, player.id).first() : null;
  return {
    game: {
      code: game.code, status: game.status, imposterCount: game.imposter_count,
      minTasks: game.min_tasks, maxTasks: game.max_tasks,
      meetingNumber: game.meeting_number, meetingStatus: game.meeting_status,
      meetingReason: game.meeting_reason, reportedPlayerId: game.reported_player_id,
      resultText: game.result_text,
      taskProgress: { completed: Number(progress?.completed || 0), total: Number(progress?.total || 0) }
    },
    me: { id: player.id, name: player.name, isHost: !!player.is_host, role: player.role, alive: !!player.alive },
    players: players.map(p => ({ id:p.id, name:p.name, isHost:!!p.is_host, alive:!!p.alive, role: (game.meeting_status === 'result' && game.result_text?.includes(p.name)) ? p.role : undefined })),
    myTasks: myTasks.map(t => ({...t, is_fake:!!t.is_fake, completed:!!t.completed})),
    taskPool: pool,
    myVote: myVote ? (myVote.target_player_id || 'SKIP') : null
  };
}

async function createGame(req, env) {
  const b = await body(req);
  const hostName = cleanName(b.name);
  if (!hostName) return json({error:'Enter your name.'}, 400);
  const gameId = id(), playerId = id(), token = id(), code = await uniqueGameCode(env), t=now();
  const imp = int(b.imposterCount, 1, 10, 1), minTasks=int(b.minTasks,1,20,3), maxTasks=int(b.maxTasks,minTasks,20,5);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO games(id,code,status,host_player_id,imposter_count,min_tasks,max_tasks,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(gameId,code,'lobby',playerId,imp,minTasks,maxTasks,t,t),
    env.DB.prepare('INSERT INTO players(id,game_id,name,token,is_host,joined_at,last_seen) VALUES(?,?,?,?,1,?,?)').bind(playerId,gameId,hostName,token,t,t)
  ]);
  return json({code, token});
}

async function joinGame(req, env) {
  const b = await body(req);
  const name = cleanName(b.name), code = normalizeGameCode(b.code);
  if (!name) return json({error:'Enter your name.'},400);
  if (code.length !== 6) return json({error:'Enter the full 6-character game code.'},400);
  // Be forgiving of codes pasted with spaces/dashes and of records created by
  // an older deployment with inconsistent casing or surrounding whitespace.
  const game = await env.DB.prepare('SELECT * FROM games WHERE upper(trim(code))=?').bind(code).first();
  if (!game) return json({error:'Game code not found.'},404);
  if (game.status !== 'lobby') return json({error:'That game has already started.'},409);
  const count = await env.DB.prepare('SELECT COUNT(*) c FROM players WHERE game_id=?').bind(game.id).first();
  if (count.c >= 30) return json({error:'Lobby is full (30 players max).'},409);
  const existing = await env.DB.prepare('SELECT id FROM players WHERE game_id=? AND lower(name)=lower(?)').bind(game.id,name).first();
  if (existing) return json({error:'That name is already in the lobby.'},409);
  const playerId=id(), token=id(), t=now();
  await env.DB.prepare('INSERT INTO players(id,game_id,name,token,is_host,joined_at,last_seen) VALUES(?,?,?,?,0,?,?)').bind(playerId,game.id,name,token,t,t).run();
  return json({code, token});
}

async function updateSettings(req, env, p) {
  requireHost(p); const b=await body(req);
  const imp=int(b.imposterCount,1,10,1), min=int(b.minTasks,1,20,3), max=int(b.maxTasks,min,20,5);
  const count = await env.DB.prepare('SELECT COUNT(*) c FROM players WHERE game_id=?').bind(p.game_id).first();
  if (imp >= count.c) return json({error:'There must be at least one crewmate.'},400);
  await env.DB.prepare('UPDATE games SET imposter_count=?,min_tasks=?,max_tasks=?,updated_at=? WHERE id=? AND status=\'lobby\'').bind(imp,min,max,now(),p.game_id).run();
  return json({ok:true});
}

async function addTask(req, env, p) {
  requireHost(p); const b=await body(req); const title=cleanText(b.title,80), desc=cleanText(b.description,240);
  if (!title) return json({error:'Task needs a title.'},400);
  await env.DB.prepare('INSERT INTO task_pool(id,game_id,title,description,enabled) VALUES(?,?,?,?,1)').bind(id(),p.game_id,title,desc).run();
  return json({ok:true});
}
async function deleteTask(req, env, p, taskId) {
  requireHost(p); await env.DB.prepare('DELETE FROM task_pool WHERE id=? AND game_id=?').bind(taskId,p.game_id).run(); return json({ok:true});
}

async function startGame(req, env, p) {
  requireHost(p);
  const game=await env.DB.prepare('SELECT * FROM games WHERE id=?').bind(p.game_id).first();
  if (game.status !== 'lobby') return json({error:'Game already started.'},409);
  const players=(await env.DB.prepare('SELECT * FROM players WHERE game_id=? ORDER BY joined_at').bind(p.game_id).all()).results;
  if (players.length < 3) return json({error:'You need at least 3 players.'},400);
  if (game.imposter_count >= players.length) return json({error:'Too many impostors for this lobby.'},400);
  const tasks=(await env.DB.prepare('SELECT * FROM task_pool WHERE game_id=? AND enabled=1').bind(p.game_id).all()).results;
  if (!tasks.length) return json({error:'Add at least one task first.'},400);
  const impostors = new Set(shuffle(players.map(x=>x.id)).slice(0, game.imposter_count));
  const statements=[env.DB.prepare("UPDATE games SET status='playing',meeting_status='none',result_text=NULL,updated_at=? WHERE id=?").bind(now(),p.game_id), env.DB.prepare('DELETE FROM player_tasks WHERE game_id=?').bind(p.game_id), env.DB.prepare('DELETE FROM votes WHERE game_id=?').bind(p.game_id)];
  for (const pl of players) {
    const role=impostors.has(pl.id)?'impostor':'crewmate';
    statements.push(env.DB.prepare('UPDATE players SET role=?,alive=1 WHERE id=?').bind(role,pl.id));
    const count = Math.min(tasks.length, game.min_tasks + Math.floor(Math.random() * (game.max_tasks - game.min_tasks + 1)));
    for (const task of shuffle(tasks).slice(0,count)) {
      statements.push(env.DB.prepare('INSERT INTO player_tasks(id,game_id,player_id,task_pool_id,title,description,is_fake,completed) VALUES(?,?,?,?,?,?,?,0)').bind(id(),p.game_id,pl.id,task.id,task.title,task.description,role==='impostor'?1:0));
    }
  }
  for (let i=0;i<statements.length;i+=80) await env.DB.batch(statements.slice(i,i+80));
  return json({ok:true});
}

async function toggleTask(req, env, p, taskId) {
  const task=await env.DB.prepare('SELECT * FROM player_tasks WHERE id=? AND player_id=?').bind(taskId,p.id).first();
  if (!task) return json({error:'Task not found.'},404);
  const completed=task.completed?0:1;
  await env.DB.prepare('UPDATE player_tasks SET completed=?, completed_at=? WHERE id=?').bind(completed,completed?now():null,task.id).run();
  return json({ok:true});
}

async function report(req, env, p) {
  if (!p.alive) return json({error:'Dead players cannot call a meeting.'},403);
  const b=await body(req); const game=await env.DB.prepare('SELECT * FROM games WHERE id=?').bind(p.game_id).first();
  if (game.status !== 'playing' || game.meeting_status === 'voting') return json({error:'A meeting cannot be called right now.'},409);
  let reported=null, reason='Emergency meeting';
  if (b.reportedPlayerId) {
    reported=await env.DB.prepare('SELECT * FROM players WHERE id=? AND game_id=?').bind(b.reportedPlayerId,p.game_id).first();
    if (!reported) return json({error:'Player not found.'},404);
    if (!reported.alive) return json({error:'That player is already marked dead.'},409);
    if (reported.id === p.id) return json({error:'You cannot report yourself.'},400);
    reason=`${p.name} reported ${reported.name}`;
  } else reason=`${p.name} called an emergency meeting`;
  const meeting=game.meeting_number+1;
  const q=[env.DB.prepare("UPDATE games SET meeting_number=?,meeting_status='voting',meeting_reason=?,reported_player_id=?,result_text=NULL,updated_at=? WHERE id=?").bind(meeting,reason,reported?.id||null,now(),p.game_id), env.DB.prepare('DELETE FROM votes WHERE game_id=? AND meeting_number=?').bind(p.game_id,meeting)];
  if (reported) q.push(env.DB.prepare('UPDATE players SET alive=0 WHERE id=?').bind(reported.id));
  await env.DB.batch(q); return json({ok:true});
}

async function vote(req, env, p) {
  if (!p.alive) return json({error:'Dead players cannot vote.'},403);
  const b=await body(req), game=await env.DB.prepare('SELECT * FROM games WHERE id=?').bind(p.game_id).first();
  if (game.meeting_status !== 'voting') return json({error:'Voting is not open.'},409);
  const target=b.targetPlayerId || null;
  if (target) {
    const tp=await env.DB.prepare('SELECT id,alive FROM players WHERE id=? AND game_id=?').bind(target,p.game_id).first();
    if (!tp || !tp.alive) return json({error:'That player cannot be voted for.'},400);
  }
  try { await env.DB.prepare('INSERT INTO votes(id,game_id,meeting_number,voter_player_id,target_player_id,created_at) VALUES(?,?,?,?,?,?)').bind(id(),p.game_id,game.meeting_number,p.id,target,now()).run(); }
  catch { return json({error:'You already voted this meeting.'},409); }
  return json({ok:true});
}

async function endVoting(req, env, p) {
  requireHost(p); const game=await env.DB.prepare('SELECT * FROM games WHERE id=?').bind(p.game_id).first();
  if (game.meeting_status !== 'voting') return json({error:'Voting is not open.'},409);
  const votes=(await env.DB.prepare('SELECT target_player_id,COUNT(*) c FROM votes WHERE game_id=? AND meeting_number=? GROUP BY target_player_id ORDER BY c DESC').bind(p.game_id,game.meeting_number).all()).results;
  if (!votes.length) { await env.DB.prepare("UPDATE games SET meeting_status='result',result_text='No votes were cast.',updated_at=? WHERE id=?").bind(now(),p.game_id).run(); return json({ok:true}); }
  const top=Number(votes[0].c), tied=votes.filter(v=>Number(v.c)===top);
  let result='';
  if (tied.length>1) result='Tie vote — nobody was ejected.';
  else if (!votes[0].target_player_id) result='Skip won — nobody was ejected.';
  else {
    const target=await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(votes[0].target_player_id).first();
    await env.DB.prepare('UPDATE players SET alive=0 WHERE id=?').bind(target.id).run();
    result=`${target.name} was ejected. ${target.name} was ${target.role === 'impostor' ? 'AN IMPOSTOR' : 'NOT an impostor'}.`;
  }
  await env.DB.prepare("UPDATE games SET meeting_status='result',result_text=?,updated_at=? WHERE id=?").bind(result,now(),p.game_id).run();
  return json({ok:true});
}

async function resume(req, env, p) {
  requireHost(p); await env.DB.prepare("UPDATE games SET meeting_status='none',meeting_reason=NULL,reported_player_id=NULL,result_text=NULL,updated_at=? WHERE id=?").bind(now(),p.game_id).run(); return json({ok:true});
}
async function endGame(req, env, p) {
  requireHost(p); await env.DB.prepare("UPDATE games SET status='ended',meeting_status='none',updated_at=? WHERE id=?").bind(now(),p.game_id).run(); return json({ok:true});
}

async function api(req, env, path) {
  try {
    if (req.method==='POST' && path==='/api/create') return createGame(req,env);
    if (req.method==='POST' && path==='/api/join') return joinGame(req,env);
    const p=await requirePlayer(req,env);
    if (req.method==='GET' && path==='/api/state') return json(await gameState(env,p));
    if (req.method==='POST' && path==='/api/settings') return updateSettings(req,env,p);
    if (req.method==='POST' && path==='/api/tasks') return addTask(req,env,p);
    if (req.method==='DELETE' && path.startsWith('/api/tasks/')) return deleteTask(req,env,p,path.split('/').pop());
    if (req.method==='POST' && path==='/api/start') return startGame(req,env,p);
    if (req.method==='POST' && path.startsWith('/api/task/')) return toggleTask(req,env,p,path.split('/').pop());
    if (req.method==='POST' && path==='/api/report') return report(req,env,p);
    if (req.method==='POST' && path==='/api/vote') return vote(req,env,p);
    if (req.method==='POST' && path==='/api/end-voting') return endVoting(req,env,p);
    if (req.method==='POST' && path==='/api/resume') return resume(req,env,p);
    if (req.method==='POST' && path==='/api/end-game') return endGame(req,env,p);
    return json({error:'Not found'},404);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error(e); return json({error:'Server error', detail:String(e?.message||e)},500);
  }
}

// Cloudflare Pages Function catch-all for /api/*.
// File location: functions/api/[[path]].js
export async function onRequest(context) {
  const req = context.request;
  const env = context.env;
  const url = new URL(req.url);
  return api(req, env, url.pathname);
}
