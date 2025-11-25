import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

let pool: Pool | null = null;
let db: any = null;

try {
  if (!process.env.DATABASE_URL) {
    console.warn("⚠️ DATABASE_URL not set - database features will be unavailable");
  } else {
    // Create PostgreSQL connection pool
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Handle pool errors
    pool.on("error", (err) => {
      console.error("❌ Unexpected error on idle client:", err);
    });

    // Create Drizzle instance
    db = drizzle(pool, { schema });
  }
} catch (error) {
  console.error("❌ Error initializing database pool:", error);
  pool = null;
  db = null;
}

export { db, pool };
