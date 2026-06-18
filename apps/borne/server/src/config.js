const env = process.env;

export const config = {
  port: parseInt(env.PORT ?? '3001', 10),
  techPassword: env.TECH_PASSWORD ?? 'tech123',
  jwtSecret: env.JWT_SECRET ?? 'change-me',
  dataDir: env.DATA_DIR ?? '/app/data',
  hubUrl: env.HUB_URL ?? '',
  boxToken: env.BOX_TOKEN ?? '',
maxDataBytes: parseInt(env.MAX_DATA_BYTES || '0', 10),
  previewMode: env.PREVIEW_MODE === 'true',
  hostPort: env.HOST_PORT ?? null,
};
