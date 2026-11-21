import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { PrismaClient } from "@prisma/client";
import { Type } from "@sinclair/typebox";
import type { Configuracao } from "./config.js";
import { ServicoAutenticacao } from "./application/ServicoAutenticacao.js";
import { ServicoOrganizacao } from "./application/ServicoOrganizacao.js";
import { ServicoLote } from "./application/ServicoLote.js";
import { ServicoEquipamento } from "./application/ServicoEquipamento.js";
import { ServicoRelatorio } from "./application/ServicoRelatorio.js";
import { ServicoAnalitico } from "./application/analitico/ServicosAnaliticos.js";
import { ServicoTarefaAnalitica } from "./application/ServicoTarefaAnalitica.js";
import { BancoDados } from "./infrastructure/BancoDados.js";
import { criarFilaAnalitica, type FilaAnalitica } from "./infrastructure/FilaAnalitica.js";
import { criarPrisma } from "./infrastructure/prisma.js";
import { ErroAplicacao } from "./domain/erros.js";
import { registrarErros } from "./http/erros.js";
import { registrarAutenticacao, registrarLogin } from "./http/controllers/AutenticacaoController.js";
import { registrarOrganizacoes } from "./http/controllers/OrganizacaoController.js";
import { registrarLotes } from "./http/controllers/LoteController.js";
import { registrarEquipamentos } from "./http/controllers/EquipamentoController.js";
import { registrarRelatorios } from "./http/controllers/RelatorioController.js";
import { registrarAnaliticoInterno } from "./http/controllers/AnaliticoController.js";
import { registrarApiPublica } from "./http/controllers/PublicApiController.js";
import { documentar, VERSAO_API_PUBLICA } from "./http/schemas.js";
import "./http/tipos.js";

function validarVersaoSolicitada(cabecalho: string | string[] | undefined): void {
  if (!cabecalho) return;
  const solicitada = (Array.isArray(cabecalho) ? cabecalho[0] : cabecalho)?.trim();
  if (!solicitada) return;
  if (!/^(1|1\.0|1\.0\.0)$/.test(solicitada)) {
    throw new ErroAplicacao(400, "VERSAO_API_NAO_SUPORTADA", `Versão "${solicitada}" não suportada. Utilize a versão semântica ${VERSAO_API_PUBLICA} (ou major 1).`);
  }
}

export function criarApp(
  config: Configuracao,
  opcoes: { prisma?: PrismaClient; fila?: FilaAnalitica; logger?: boolean } = {},
) {
  const app = Fastify({
    logger: opcoes.logger === false ? false : { redact: ["req.headers.authorization", 'req.headers["x-api-key"]'] },
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
    return503OnClosing: true,
  });
  const prisma = opcoes.prisma ?? criarPrisma(config.databaseUrl);
  const banco = new BancoDados(prisma);
  const autenticacao = new ServicoAutenticacao(banco);
  const organizacoes = new ServicoOrganizacao(banco);
  const lotes = new ServicoLote(banco);
  const equipamentos = new ServicoEquipamento(banco);
  const relatorios = new ServicoRelatorio(banco);
  const analitico = new ServicoAnalitico(banco);
  const fila = opcoes.fila ?? criarFilaAnalitica(config.fila, banco, analitico);
  const tarefas = new ServicoTarefaAnalitica(banco, fila, analitico);
  let encerrando = false;

  registrarErros(app);
  app.addHook("preClose", async () => { encerrando = true; });
  app.addHook("onSend", async (_request, reply, payload) => {
    if (encerrando) reply.header("Connection", "close");
    return payload;
  });
  app.addHook("onResponse", async () => {
    // Recolhe sockets que ficaram ociosos após o início do fechamento,
    // preservando as demais requisições ainda em andamento.
    if (encerrando) setImmediate(() => app.server.closeIdleConnections());
  });
  app.addHook("onReady", async () => {
    await prisma.$connect();
    // O adaptador pg cria o pool de forma preguiçosa; $connect sozinho não testa a conexão.
    await prisma.$queryRaw`SELECT 1`;
    await fila.iniciar();
  });
  app.addHook("onClose", async () => {
    await fila.fechar();
    await prisma.$disconnect();
  });
  app.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn, iss: "greencode", aud: "greencode-api" },
    verify: { allowedIss: "greencode", allowedAud: "greencode-api", algorithms: ["HS256"] },
  });
  app.register(cors, { origin: config.corsOrigins, methods: ["GET", "POST", "PATCH", "OPTIONS"] });
  app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (request, contexto) => new ErroAplicacao(
      429,
      "LIMITE_REQUISICOES_EXCEDIDO",
      `Limite de ${contexto.max} requisições por minuto excedido para este cliente (requestId: ${request.id}). Aguarde ${Math.ceil(contexto.ttl / 1000)}s.`,
    ),
  });
  app.register(swagger, {
    openapi: {
      info: {
        title: "GreenCode — AV3",
        version: VERSAO_API_PUBLICA,
        description: "Plataforma analítica e API pública/interna de logística reversa. Endpoints internos utilizam JWT Bearer (/api/v1/internal e /api); endpoints para parceiros utilizam X-API-Key (/api/v1/public) com escopos e rate limit por cliente.",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Token JWT emitido em POST /api/auth/login ou /api/v1/internal/auth/login." },
          apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key", description: "Chave única do parceiro externo no formato gc_live_<prefixo>_<segredo>." },
        },
      },
    },
  });
  app.register(swaggerUi, { routePrefix: "/docs" });

  const registrarRotasInternas = async (api: FastifyInstance) => {
    api.decorateRequest("ator");
    api.addHook("onRequest", async request => {
      try { await request.jwtVerify(); }
      catch { throw new ErroAplicacao(401, "TOKEN_INVALIDO", "Informe um token Bearer válido e não expirado."); }
      request.ator = await autenticacao.autenticar(request.user);
    });
    registrarAutenticacao(api, autenticacao);
    registrarOrganizacoes(api, organizacoes);
    registrarLotes(api, lotes);
    registrarEquipamentos(api, equipamentos);
    registrarRelatorios(api, relatorios);
    registrarAnaliticoInterno(api, analitico, tarefas);
  };

  app.register(async rotas => {
    rotas.get("/health", {
      schema: documentar("Sistema", "Verificar aplicação, banco PostgreSQL e fila assíncrona", Type.Object({
        status: Type.Literal("ok"),
        banco: Type.Literal("conectado"),
        fila: Type.Object({
          modo: Type.Union([Type.Literal("bullmq-redis"), Type.Literal("memoria")]),
          status: Type.Union([Type.Literal("conectado"), Type.Literal("ativo")]),
        }),
        versaoApi: Type.String(),
      }), 200, true),
    }, async () => {
      try { await prisma.$queryRaw`SELECT 1`; }
      catch { throw new ErroAplicacao(503, "BANCO_INDISPONIVEL", "Banco de dados indisponível."); }
      const estadoFila = await fila.saude();
      return { status: "ok" as const, banco: "conectado" as const, fila: estadoFila, versaoApi: VERSAO_API_PUBLICA };
    });

    // Rotas de login com rate limit por IP para mitigação de força bruta.
    registrarLogin(rotas, autenticacao, config.jwtExpiresIn, config.loginPorMinuto, "/api");
    registrarLogin(rotas, autenticacao, config.jwtExpiresIn, config.loginPorMinuto, "/api/v1/internal");

    // Segregação explícita (AV3): /api/v1/internal para gestão interna e /api mantido por retrocompatibilidade com AV2.
    rotas.register(registrarRotasInternas, { prefix: "/api" });
    rotas.register(registrarRotasInternas, { prefix: "/api/v1/internal" });

    // API pública segregada e versionada para parceiros externos.
    rotas.register(async publica => {
      publica.decorateRequest("parceiro");
      publica.addHook("onRequest", async (request, reply) => {
        reply.header("X-API-Version", VERSAO_API_PUBLICA);
        validarVersaoSolicitada(request.headers["x-api-version"]);
        const cabecalhoChave = request.headers["x-api-key"];
        const chave = Array.isArray(cabecalhoChave) ? cabecalhoChave[0] : cabecalhoChave;
        request.parceiro = await autenticacao.autenticarChaveApi(chave);
      });
      await publica.register(rateLimit, {
        global: true,
        timeWindow: 60000,
        keyGenerator: request => request.parceiro?.id ?? request.ip,
        max: request => request.parceiro?.limitePorMinuto ?? 60,
        errorResponseBuilder: (request, contexto) => new ErroAplicacao(
          429,
          "LIMITE_REQUISICOES_EXCEDIDO",
          `Limite de ${contexto.max} requisições por minuto excedido para esta chave de API (requestId: ${request.id}).`,
        ),
      });
      registrarApiPublica(publica, { lotes, equipamentos, analitico, tarefas });
    }, { prefix: "/api/v1/public" });
  });
  return app;
}
