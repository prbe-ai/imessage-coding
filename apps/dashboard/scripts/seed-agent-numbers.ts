/**
 * Seed `agent_numbers` from the live AgentPhone API.
 *
 * Pulls the agent's numbers[] and upserts the active ones into the pool. The
 * number is NEVER hardcoded — AgentPhone is the source of truth, which keeps the
 * repo de-branded and auto-discovers numbers when we add more (Phase 2). Safe to
 * re-run (ON CONFLICT upsert).
 *
 * Env required (load .env.control for the AgentPhone creds + the product
 * DATABASE_URL, or pass inline):
 *   AGENTPHONE_API_BASE   (default https://api.agentphone.ai)
 *   AGENTPHONE_API_KEY
 *   AGENTPHONE_AGENT_ID
 *   DATABASE_URL          (the product Neon DB — same one the dashboard uses)
 *
 * Run:  bun run apps/dashboard/scripts/seed-agent-numbers.ts
 */

import { Pool } from "pg";

interface AgentNumber {
  id: string;
  phoneNumber: string;
  status: string;
  type: string;
}

interface AgentResponse {
  id: string;
  numbers?: AgentNumber[];
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const base = process.env["AGENTPHONE_API_BASE"] ?? "https://api.agentphone.ai";
  const apiKey = reqEnv("AGENTPHONE_API_KEY");
  const agentId = reqEnv("AGENTPHONE_AGENT_ID");
  const databaseUrl = reqEnv("DATABASE_URL");

  const res = await fetch(`${base}/v1/agents/${agentId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    console.error(
      `AgentPhone GET /v1/agents/${agentId} -> ${res.status} ${res.statusText}`,
    );
    process.exit(1);
  }

  const agent = (await res.json()) as AgentResponse;
  const active = (agent.numbers ?? []).filter((n) => n.status === "active");
  if (active.length === 0) {
    console.error("No active numbers on the agent — nothing to seed.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    for (const n of active) {
      await pool.query(
        `INSERT INTO agent_numbers (phone_number, agent_id, provider_id, active)
           VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (phone_number)
           DO UPDATE SET agent_id = EXCLUDED.agent_id,
                         provider_id = EXCLUDED.provider_id,
                         active = TRUE`,
        [n.phoneNumber, agent.id, n.id],
      );
      console.log(`seeded ${n.phoneNumber} (${n.type})`);
    }
    console.log(`Done — ${active.length} active number(s) upserted.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
