import cron from "node-cron";

export interface ConfiguracaoFila {
  /** URL do Redis. Ausente: fila em memória, apenas para desenvolvimento e testes. */
  redisUrl?: string;
  /** Executa o worker no mesmo processo da API. Com Redis, workers dedicados escalam horizontalmente. */
  workerEmbutido: boolean;
  concorrencia: number;
  tentativas: number;
  backoffMs: number;
  /** Expressão cron das análises recorrentes, ou null para desativar. */
  cronAnalises: string | null;
  fusoHorario: string;
}

export interface Configuracao {
  databaseUrl: string;
  host: string;
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigins: string[];
  fila: ConfiguracaoFila;
  loginPorMinuto: number;
}

function inteiro(valor: string | undefined, padrao: number, nome: string, minimo: number, maximo: number): number {
  const numero = Number(valor ?? padrao);
  if (!Number.isInteger(numero) || numero < minimo || numero > maximo) throw new Error(`${nome} deve ser um inteiro entre ${minimo} e ${maximo}.`);
  return numero;
}

export function lerConfiguracaoFila(env: NodeJS.ProcessEnv = process.env): ConfiguracaoFila {
  const redisUrl = env.REDIS_URL?.trim() || undefined;
  if (redisUrl && !/^rediss?:\/\//.test(redisUrl)) throw new Error("REDIS_URL deve começar com redis:// ou rediss://.");
  const expressao = (env.ANALISES_CRON ?? "0 3 * * *").trim();
  const cronAnalises = ["", "desativado", "off"].includes(expressao.toLowerCase()) ? null : expressao;
  if (cronAnalises && !cron.validate(cronAnalises)) throw new Error("ANALISES_CRON deve ser uma expressão cron válida ou \"desativado\".");
  const fusoHorario = env.ANALISES_FUSO ?? "America/Sao_Paulo";
  try { new Intl.DateTimeFormat("pt-BR", { timeZone: fusoHorario }); }
  catch { throw new Error("ANALISES_FUSO deve ser um fuso IANA, por exemplo America/Sao_Paulo."); }
  return {
    redisUrl,
    workerEmbutido: (env.WORKER_EMBUTIDO ?? "true").toLowerCase() !== "false",
    concorrencia: inteiro(env.WORKER_CONCORRENCIA, 2, "WORKER_CONCORRENCIA", 1, 32),
    tentativas: inteiro(env.FILA_TENTATIVAS, 4, "FILA_TENTATIVAS", 1, 20),
    backoffMs: inteiro(env.FILA_BACKOFF_MS, 5000, "FILA_BACKOFF_MS", 1, 3600000),
    cronAnalises, fusoHorario,
  };
}

export function lerConfiguracao(env: NodeJS.ProcessEnv = process.env): Configuracao {
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error("Configure DATABASE_URL com a conexão PostgreSQL.");
  const jwtSecret = env.JWT_SECRET ?? "";
  if (Buffer.byteLength(jwtSecret) < 32) throw new Error("JWT_SECRET deve conter pelo menos 32 bytes.");
  const port = inteiro(env.PORT, 3333, "PORT", 1, 65535);
  const jwtExpiresIn = env.JWT_EXPIRES_IN ?? "30m";
  if (!/^[1-9]\d*(s|m|h)$/.test(jwtExpiresIn)) throw new Error("JWT_EXPIRES_IN deve usar segundos, minutos ou horas, por exemplo 30m.");
  return {
    databaseUrl, jwtSecret, port, jwtExpiresIn, host: env.HOST ?? "127.0.0.1",
    corsOrigins: (env.CORS_ORIGINS ?? "").split(",").map(item => item.trim()).filter(Boolean),
    fila: lerConfiguracaoFila(env),
    loginPorMinuto: inteiro(env.LOGIN_POR_MINUTO, 10, "LOGIN_POR_MINUTO", 1, 10000),
  };
}
