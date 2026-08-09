PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'lobby',
  host_player_id TEXT,
  imposter_count INTEGER NOT NULL DEFAULT 1,
  min_tasks INTEGER NOT NULL DEFAULT 3,
  max_tasks INTEGER NOT NULL DEFAULT 5,
  meeting_number INTEGER NOT NULL DEFAULT 0,
  meeting_status TEXT NOT NULL DEFAULT 'none',
  meeting_reason TEXT,
  reported_player_id TEXT,
  result_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  is_host INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  alive INTEGER NOT NULL DEFAULT 1,
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id);
CREATE INDEX IF NOT EXISTS idx_players_token ON players(token);

CREATE TABLE IF NOT EXISTS task_pool (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_pool_game ON task_pool(game_id);

CREATE TABLE IF NOT EXISTS player_tasks (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  task_pool_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  is_fake INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_player_tasks_game ON player_tasks(game_id);
CREATE INDEX IF NOT EXISTS idx_player_tasks_player ON player_tasks(player_id);

CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  meeting_number INTEGER NOT NULL,
  voter_player_id TEXT NOT NULL,
  target_player_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(game_id, meeting_number, voter_player_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (voter_player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_votes_meeting ON votes(game_id, meeting_number);
