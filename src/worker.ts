import "dotenv/config";
import { ServicoAnalitico } from "./application/analitico/ServicosAnaliticos.js";
import { lerConfiguracaoFila } from "./config.js";
import { BancoDados } from "./infrastructure/BancoDados.js";
import { FilaBullMqAnalitica } from "./infrastructure/FilaAnalitica.js";
import { criarPrisma } from "./infrastructure/prisma.js";

async function iniciarWorker() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error("Configure DATABASE_URL com a conexão PostgreSQL.");
  const filaConfig = lerConfiguracaoFila();
  if (!filaConfig.redisUrl) throw new Error("Configure REDIS_URL para executar um worker BullMQ dedicado.");

  const prisma = criarPrisma(databaseUrl);
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
  const banco = new BancoDados(prisma);
  const analitico = new ServicoAnalitico(banco);
  const fila = new FilaBullMqAnalitica({ ...filaConfig, workerEmbutido: true }, banco, analitico);
  await fila.iniciar();
  console.log("Worker analítico BullMQ iniciado e conectado ao Redis.");

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    console.log(`Encerrando worker analítico (${sinal})...`);
    try {
      await fila.fechar();
      await prisma.$disconnect();
    } catch (erro) {
      console.error(erro);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void encerrar("SIGINT"));
  process.once("SIGTERM", () => void encerrar("SIGTERM"));
}

iniciarWorker().catch(erro => {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exitCode = 1;
});
