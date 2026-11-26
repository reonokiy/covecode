CREATE TABLE cove_relay_replicas (
  instance_id uuid PRIMARY KEY,
  relay_peer text NOT NULL UNIQUE,
  addresses jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE cove_relay_routes (
  instance_id uuid NOT NULL REFERENCES cove_relay_replicas ON DELETE CASCADE,
  endpoint_key text NOT NULL,
  registration jsonb NOT NULL,
  PRIMARY KEY (endpoint_key, instance_id)
);
--> statement-breakpoint
CREATE TABLE cove_push_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel text NOT NULL,
  device_id text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX cove_push_jobs_device ON cove_push_jobs (channel, device_id, id);
--> statement-breakpoint
CREATE INDEX cove_push_jobs_available ON cove_push_jobs (channel, available_at, id);
--> statement-breakpoint
CREATE TABLE cove_hook_windows (
  bucket text PRIMARY KEY,
  hits timestamptz[] NOT NULL,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE cove_held_hooks (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_key text NOT NULL,
  hook_key text NOT NULL,
  delivery_id text NOT NULL UNIQUE,
  request jsonb NOT NULL,
  body bytea NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now() + interval '30 seconds',
  lease_until timestamptz,
  attempt integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
--> statement-breakpoint
CREATE INDEX cove_held_hooks_endpoint ON cove_held_hooks(endpoint_key, hook_key, seq);
--> statement-breakpoint
CREATE INDEX cove_held_hooks_due ON cove_held_hooks(available_at, seq);
--> statement-breakpoint
CREATE TABLE cove_maintenance (
  task text PRIMARY KEY,
  next_run timestamptz NOT NULL
);
