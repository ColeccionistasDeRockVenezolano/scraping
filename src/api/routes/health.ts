import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getPool } from "../../db/client.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/health", {
    schema: {
      tags: ["health"],
      response: { 200: z.object({ ok: z.boolean(), database: z.boolean() }) },
    },
  }, async () => {
    let database = true;
    try {
      await getPool().query("SELECT 1");
    } catch {
      database = false;
    }
    return { ok: database, database };
  });
}
