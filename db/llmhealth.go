package db

import "time"

// LLMHealth is the persisted circuit-breaker state of one LLM profile. The
// in-memory llmpool.Registry is authoritative; this table only lets a cooling-off
// window survive a restart (LoadLLMHealth filters out windows that already expired).
type LLMHealth struct {
	ProfileID int64
	Fails     int
	Trips     int
	OpenUntil *time.Time // nil = closed (usable)
	LastError string
	LastAt    time.Time
}

// SaveLLMHealth upserts one profile's breaker state (best-effort mirror of memory).
func (d *DB) SaveLLMHealth(h LLMHealth) error {
	_, err := d.Exec(`INSERT INTO llm_profile_health (profile_id, fails, trips, open_until, last_error, last_at)
VALUES ($1,$2,$3,$4,$5, now())
ON CONFLICT (profile_id) DO UPDATE SET
  fails=EXCLUDED.fails, trips=EXCLUDED.trips, open_until=EXCLUDED.open_until,
  last_error=EXCLUDED.last_error, last_at=now()`,
		h.ProfileID, h.Fails, h.Trips, h.OpenUntil, h.LastError)
	return err
}

// ClearLLMHealth drops a profile's breaker row (called when it recovers / is reset).
func (d *DB) ClearLLMHealth(id int64) error {
	_, err := d.Exec(`DELETE FROM llm_profile_health WHERE profile_id=$1`, id)
	return err
}

// LoadLLMHealth returns rows whose cooling-off window is still in the future (or that
// carry failure counters), so a profile that finished cooling while we were down comes
// back healthy without a stale open window.
func (d *DB) LoadLLMHealth() ([]LLMHealth, error) {
	rows, err := d.Query(`SELECT profile_id, fails, trips, open_until, COALESCE(last_error,''), last_at
FROM llm_profile_health WHERE open_until IS NULL OR open_until > now()`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LLMHealth
	for rows.Next() {
		var h LLMHealth
		if err := rows.Scan(&h.ProfileID, &h.Fails, &h.Trips, &h.OpenUntil, &h.LastError, &h.LastAt); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}
