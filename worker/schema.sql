-- One row per player per daily course: their best run, ghost included.
CREATE TABLE IF NOT EXISTS scores (
  ph   TEXT    NOT NULL,  -- sha-256 of the player's private id, so nobody can overwrite someone else
  seed TEXT    NOT NULL,  -- daily course, d + yyyymmdd
  name TEXT    NOT NULL,
  col  INTEGER NOT NULL,
  d    INTEGER NOT NULL,  -- metres, recomputed by replaying f
  f    TEXT    NOT NULL,  -- the ghost: flip frames as a compact code
  v    INTEGER NOT NULL,  -- sim version the run was made with
  at   INTEGER NOT NULL,
  PRIMARY KEY (ph, seed)
);
CREATE INDEX IF NOT EXISTS scores_by_course ON scores (v, seed, d DESC);
CREATE INDEX IF NOT EXISTS scores_by_dist ON scores (v, d DESC);
