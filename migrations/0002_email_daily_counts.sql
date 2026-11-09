-- Daily send cap (beta: Resend free plan, 100 mails per day). One row per UTC day; a send reserves a slot with an
-- atomic conditional increment before the provider call, so concurrent workers never overshoot the cap.
create table email_daily_counts (
  day date primary key,                                  -- UTC day
  sent integer not null default 0 check (sent >= 0),    -- slots taken (a failed provider call keeps its slot)
  capped_at timestamptz);                                -- first time the cap refused a message that day
