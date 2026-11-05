export interface Config {
  databaseUrl: string;
  databaseSsl: boolean;
  accountEmail: string;
  accountPasswordHash: string;
  jwtSecret: string;
  tokenTtlDays: number;
  port: number;
  staticDir: string | null;
  allowedOrigins: string[];
  cookieSecure: boolean | null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable ${name} (see packages/server/.env.example)`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = required(env, "JWT_SECRET");
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  const hash = required(env, "ACCOUNT_PASSWORD_HASH");
  if (!/^\$2[aby]\$\d\d\$/.test(hash)) throw new Error("ACCOUNT_PASSWORD_HASH must be a bcrypt hash (run: pnpm --filter @deskdo/server hash-password)");
  const cs = env.COOKIE_SECURE?.trim();
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    databaseSsl: env.DATABASE_SSL === "true",
    accountEmail: required(env, "ACCOUNT_EMAIL").toLowerCase(),
    accountPasswordHash: hash,
    jwtSecret,
    tokenTtlDays: Number(env.TOKEN_TTL_DAYS ?? 90) || 90,
    port: Number(env.PORT ?? 8080) || 8080,
    staticDir: env.STATIC_DIR?.trim() || null,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: cs === "true" ? true : cs === "false" ? false : null,
  };
}
