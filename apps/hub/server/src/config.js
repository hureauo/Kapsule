const env = process.env;

export const config = {
  port: parseInt(env.PORT ?? '3001', 10),
  jwtSecret: env.JWT_SECRET ?? 'change-me',
  dataDir: env.DATA_DIR ?? '/app/data',
  allowRegister: env.ALLOW_REGISTER === 'true',
};
