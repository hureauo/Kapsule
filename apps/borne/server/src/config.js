const env = process.env;

export const config = {
  port: parseInt(env.PORT ?? '3001', 10),
  adminPassword: env.ADMIN_PASSWORD ?? 'admin123',
  techPassword: env.TECH_PASSWORD ?? 'tech123',
  jwtSecret: env.JWT_SECRET ?? 'change-me',
  dataDir: env.DATA_DIR ?? '/app/data',
  hubUrl: env.HUB_URL ?? '',
  boxToken: env.BOX_TOKEN ?? '',
  pullIntervalMs: parseInt(env.PULL_INTERVAL_MS ?? '300000', 10),
};
