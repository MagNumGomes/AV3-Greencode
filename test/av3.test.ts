import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance, HTTPMethods } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Static } from "@sinclair/typebox";
import { criarApp } from "../src/app.js";
import { ServicoAnalitico } from "../src/application/analitico/ServicosAnaliticos.js";
import { ErroAplicacao } from "../src/domain/erros.js";
import * as S from "../src/http/schemas.js";
import { BancoDados } from "../src/infrastructure/BancoDados.js";
import { criarFilaAnalitica, type FilaAnalitica } from "../src/infrastructure/FilaAnalitica.js";
import { criarPrisma } from "../src/infrastructure/prisma.js";
import { CHAVE_API_DEMONSTRACAO, popularBanco } from "../prisma/dadosExemplo.js";
import { bancoTemporario } from "./bancoTemporario.js";

type Login = Static<typeof S.LoginResposta>;
type ChaveCriada = Static<typeof S.ChaveApiCriadaResposta>;
type ChaveResposta = Static<typeof S.ChaveApiResposta>;
type RelatorioAnalitico = Static<typeof S.RelatorioAnaliticoResposta>;
type Tarefa = Static<typeof S.TarefaResposta>;
type Lote = Static<typeof S.LoteResposta>;
type Equipamento = Static<typeof S.RastreabilidadeResposta>;

let app: FastifyInstance;
let prisma: PrismaClient;
let banco: Awaited<ReturnType<typeof bancoTemporario>>;
let fila: FilaAnalitica;
const senha = "Teste-Greencode-AV3-2026!";
const tokens: Record<string, string> = {};
let orgCircularId: string;
let orgCooperativaId: string;

async function reqInterna(method: HTTPMethods, url: string, payload?: object, usuario = "admin", status = 200) {
  const resposta = await app.inject({
    method, url, payload,
    headers: tokens[usuario] ? { authorization: `Bearer ${tokens[usuario]}` } : {},
  });
  assert.equal(resposta.statusCode, status, `${method} ${url}: ${resposta.body}`);
  return resposta;
}

async function reqPublica(
  method: HTTPMethods,
  url: string,
  chave: string | undefined,
  payload?: object,
  status = 200,
  headersExtras: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...headersExtras };
  if (chave) headers["x-api-key"] = chave;
  const resposta = await app.inject({ method, url, payload, headers });
  assert.equal(resposta.statusCode, status, `${method} ${url}: ${resposta.body}`);
  return resposta;
}

async function aguardarTarefa(url: string, headers: Record<string, string>, esperado: "CONCLUIDA" | "FALHOU" = "CONCLUIDA"): Promise<Tarefa> {
  const limite = Date.now() + 8000;
  while (Date.now() < limite) {
    const resposta = await app.inject({ method: "GET", url, headers });
    assert.equal(resposta.statusCode, 200, resposta.body);
    const tarefa = resposta.json<Tarefa>();
    if (tarefa.status === esperado) return tarefa;
    if (tarefa.status === "FALHOU" && esperado !== "FALHOU") {
      assert.fail(`Tarefa falhou inesperadamente: ${tarefa.ultimoErro}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Tempo esgotado aguardando tarefa em ${url}`);
}

before(async () => {
  banco = await bancoTemporario();
  prisma = criarPrisma(banco.url);
  await popularBanco(prisma, senha);
  const unidade = new BancoDados(prisma);
  const analitico = new ServicoAnalitico(unidade);
  fila = criarFilaAnalitica({
    workerEmbutido: true, concorrencia: 2, tentativas: 3, backoffMs: 20,
    cronAnalises: "0 3 * * *", fusoHorario: "America/Sao_Paulo",
  }, unidade, analitico);
  app = criarApp({
    databaseUrl: banco.url, host: "127.0.0.1", port: 3333,
    jwtSecret: "chave-exclusiva-dos-testes-av3-32-caracteres", jwtExpiresIn: "30m", corsOrigins: [],
    loginPorMinuto: 100,
    fila: { workerEmbutido: true, concorrencia: 2, tentativas: 3, backoffMs: 20, cronAnalises: null, fusoHorario: "America/Sao_Paulo" },
  }, { prisma, fila, logger: false });
  await app.ready();

  for (const usuario of ["admin", "operador", "gestor", "auditor"]) {
    const resposta = await reqInterna("POST", "/api/v1/internal/auth/login", { usuario, senha });
    tokens[usuario] = resposta.json<Login>().token;
  }
  orgCircularId = (await prisma.organizacao.findUniqueOrThrow({ where: { cnpj: "11222333000181" } })).id;
  orgCooperativaId = (await prisma.organizacao.findUniqueOrThrow({ where: { cnpj: "04252011000110" } })).id;
}, { timeout: 120000 });

after(async () => {
  if (app) await app.close();
  else if (prisma) await prisma.$disconnect();
  if (banco) await banco.fechar();
});

test("OpenAPI documenta segregação /api/v1/internal e /api/v1/public com bearerAuth e apiKeyAuth", async () => {
  const saude = (await reqInterna("GET", "/health")).json<{ status: string; fila: { modo: string }; versaoApi: string }>();
  assert.equal(saude.status, "ok");
  assert.equal(saude.fila.modo, "memoria");
  assert.equal(saude.versaoApi, "1.0.0");

  const docs = (await reqInterna("GET", "/docs/json")).json<{
    paths: Record<string, unknown>;
    components: { securitySchemes: Record<string, unknown> };
  }>();
  assert.ok(docs.components.securitySchemes.bearerAuth);
  assert.ok(docs.components.securitySchemes.apiKeyAuth);
  assert.ok(docs.paths["/api/v1/internal/analitico/eficiencia"]);
  assert.ok(docs.paths["/api/v1/internal/analitico/rentabilidade"]);
  assert.ok(docs.paths["/api/v1/internal/analitico/vida-util"]);
  assert.ok(docs.paths["/api/v1/internal/chaves-api"]);
  assert.ok(docs.paths["/api/v1/public/rastreabilidade/{codigo}"]);
  assert.ok(docs.paths["/api/v1/public/lotes"]);
  assert.ok(docs.paths["/api/v1/public/relatorios/tarefas"]);
});

test("camada analítica: eficiência operacional, rentabilidade e vida útil OLS persistem resultados imutáveis", async () => {
  const eficiencia = (await reqInterna("GET", `/api/v1/internal/analitico/eficiencia?organizacaoId=${orgCircularId}`, undefined, "auditor")).json<RelatorioAnalitico>();
  assert.equal(eficiencia.tipo, "EFICIENCIA_OPERACIONAL");
  assert.equal(eficiencia.amostras, 2);
  assert.ok((eficiencia.indicadoresEficiencia?.length ?? 0) >= 3);
  const global = eficiencia.indicadoresEficiencia!.find(i => i.dimensao === "GERAL")!;
  assert.equal(global.lotes, 2);
  assert.ok(global.totalMediaHoras > 0);
  assert.ok(global.totalP90Horas >= global.totalMedianaHoras);

  const rentabilidade = (await reqInterna("GET", "/api/v1/internal/analitico/rentabilidade", undefined, "auditor")).json<RelatorioAnalitico>();
  assert.equal(rentabilidade.tipo, "RENTABILIDADE");
  assert.equal(rentabilidade.amostras, 4);
  assert.ok((rentabilidade.indicadoresRentabilidade?.length ?? 0) >= 4);
  const porTipo = rentabilidade.indicadoresRentabilidade!.find(i => i.nivel === "TIPO" && i.tipoEquipamento === "NOTEBOOK")!;
  assert.equal(porTipo.amostras, 4);
  assert.ok(Number(porTipo.valorTotal) > 0);

  const vidaUtil = (await reqInterna("GET", "/api/v1/internal/analitico/vida-util", undefined, "auditor")).json<RelatorioAnalitico>();
  assert.equal(vidaUtil.tipo, "VIDA_UTIL");
  assert.equal(vidaUtil.amostras, 4);
  const modeloNotebook = vidaUtil.modelosVidaUtil!.find(m => m.tipoEquipamento === "NOTEBOOK")!;
  assert.equal(modeloNotebook.confiavel, true);
  assert.ok((modeloNotebook.inclinacao ?? 0) > 0);
  assert.ok((modeloNotebook.r2 ?? 0) > 0.9);
  // Equipamento 4 do seed já está com BAIXA_DEFINITIVA, portanto 3 ativos são projetados.
  assert.equal(vidaUtil.previsoesVidaUtil!.length, 3);
  assert.ok(vidaUtil.previsoesVidaUtil![0]!.vidaRemanescenteAnos >= 0);

  // Histórico e imutabilidade no PostgreSQL
  const historico = (await reqInterna("GET", "/api/v1/internal/analitico/relatorios", undefined, "auditor")).json<{ total: number }>();
  assert.equal(historico.total, 3);
  const recuperado = (await reqInterna("GET", `/api/v1/internal/analitico/relatorios/${vidaUtil.id}`, undefined, "auditor")).json<RelatorioAnalitico>();
  assert.equal(recuperado.modelosVidaUtil!.length, 1);

  await assert.rejects(prisma.relatorioAnalitico.update({ where: { id: vidaUtil.id }, data: { amostras: 999 } }));
  await assert.rejects(prisma.previsaoVidaUtil.deleteMany({ where: { relatorioId: vidaUtil.id } }));
  await reqInterna("GET", "/api/v1/internal/analitico/eficiencia", undefined, "gestor", 403);
});

test("agendador analítico executa ciclo em segundo plano e persiste relatórios com origem AGENDADA", async () => {
  const antes = await prisma.relatorioAnalitico.count({ where: { origem: "AGENDADA" } });
  await fila.executarRecorrenteAgora();
  const depois = await prisma.relatorioAnalitico.count({ where: { origem: "AGENDADA" } });
  assert.equal(depois, antes + 3);
});

test("chaves de API: emissão única do segredo, armazenamento em hash, escopos, isolamento e revogação", async () => {
  await reqInterna("POST", "/api/v1/internal/chaves-api", {
    parceiro: "Tentativa sem permissão", organizacaoId: orgCircularId, escopos: ["RASTREABILIDADE_LEITURA"],
  }, "auditor", 403);

  const criada = (await reqInterna("POST", "/api/v1/internal/chaves-api", {
    parceiro: "Auditoria Externa Somente Leitura",
    organizacaoId: orgCircularId,
    escopos: ["RASTREABILIDADE_LEITURA"],
    limitePorMinuto: 50,
  }, "admin", 201)).json<ChaveCriada>();
  assert.match(criada.chave, /^gc_live_[a-f0-9]{8}_[a-f0-9]{48}$/);

  // A listagem jamais devolve o segredo nem o hash.
  const listagem = await reqInterna("GET", "/api/v1/internal/chaves-api", undefined, "admin");
  assert.doesNotMatch(listagem.body, new RegExp(criada.chave));
  assert.doesNotMatch(listagem.body, /hashSegredo/);

  // Autenticação e cabeçalhos de versão semântica na API pública
  await reqPublica("GET", "/api/v1/public/equipamentos", undefined, undefined, 401);
  await reqPublica("GET", "/api/v1/public/equipamentos", "gc_live_invalida_000", undefined, 401);
  await reqPublica("GET", "/api/v1/public/equipamentos", criada.chave, undefined, 400, { "x-api-version": "2.0.0" });

  const rastreio = await reqPublica("GET", "/api/v1/public/rastreabilidade/GC-DEMO-1", criada.chave, undefined, 200, { "x-api-version": "1.0.0" });
  assert.equal(rastreio.headers["x-api-version"], "1.0.0");
  assert.equal(rastreio.json<Equipamento>().codigoBarrasInterno, "GC-DEMO-1");

  // Escopo RASTREABILIDADE_LEITURA não permite submeter lotes nem gerar relatórios analíticos
  await reqPublica("POST", "/api/v1/public/lotes", criada.chave, {
    dataEntrada: new Date().toISOString(), notaFiscal: "NF-BLOQUEADA", transportadora: "Trans",
  }, 403);
  await reqPublica("GET", "/api/v1/public/analitico/vida-util", criada.chave, undefined, 403);

  // Elevação de escopo com controle otimista de versão
  const alterada = (await reqInterna("PATCH", `/api/v1/internal/chaves-api/${criada.id}`, {
    versao: criada.versao,
    escopos: ["RASTREABILIDADE_LEITURA", "LOTES_LEITURA", "LOTES_ESCRITA", "RELATORIOS_ANALITICOS"],
  }, "admin")).json<ChaveResposta>();
  assert.equal(alterada.versao, 2);
  await reqInterna("PATCH", `/api/v1/internal/chaves-api/${criada.id}`, { versao: 1, ativa: false }, "admin", 409);

  // Submissão de lote e equipamento via API pública vincula automaticamente à organização da chave
  const novoLote = (await reqPublica("POST", "/api/v1/public/lotes", criada.chave, {
    dataEntrada: new Date(Date.now() - 60000).toISOString(),
    notaFiscal: "NF-PARCEIRO-01",
    transportadora: "Logística Parceira",
    equipamentos: [{
      codigoBarrasInterno: "GC-PARCEIRO-01", tipo: "SERVIDOR", marca: "Dell", modelo: "PowerEdge",
      anoFabricacao: new Date().getUTCFullYear() - 3, estadoFisico: "USADO_MODERADO", pesoQuilogramas: "18.500",
    }],
  }, 201)).json<Lote>();
  assert.equal(novoLote.organizacaoId, orgCircularId);

  const atualizado = (await reqPublica("POST", `/api/v1/public/lotes/${novoLote.id}/equipamentos`, criada.chave, {
    versao: novoLote.versao,
    equipamentos: [{
      codigoBarrasInterno: "GC-PARCEIRO-02", tipo: "SERVIDOR", marca: "Dell", modelo: "PowerEdge",
      anoFabricacao: new Date().getUTCFullYear() - 5, estadoFisico: "DANIFICADO_LEVE", pesoQuilogramas: "19.000",
    }],
  }, 201)).json<Lote>();
  assert.equal(atualizado.equipamentos!.length, 2);

  // Isolamento multi-organização: outra organização não enxerga lotes nem equipamentos da Circular
  const chaveOutraOrg = (await reqInterna("POST", "/api/v1/internal/chaves-api", {
    parceiro: "Cooperativa Externa",
    organizacaoId: orgCooperativaId,
    escopos: ["RASTREABILIDADE_LEITURA", "LOTES_LEITURA", "RELATORIOS_ANALITICOS"],
  }, "admin", 201)).json<ChaveCriada>();
  await reqPublica("GET", `/api/v1/public/lotes/${novoLote.id}`, chaveOutraOrg.chave, undefined, 404);
  await reqPublica("GET", "/api/v1/public/rastreabilidade/GC-PARCEIRO-01", chaveOutraOrg.chave, undefined, 404);
  const listaIsolada = (await reqPublica("GET", "/api/v1/public/equipamentos", chaveOutraOrg.chave)).json<{ total: number }>();
  assert.equal(listaIsolada.total, 0);

  // Revogação bloqueia imediatamente novas requisições
  await reqInterna("PATCH", `/api/v1/internal/chaves-api/${criada.id}`, { versao: alterada.versao, ativa: false }, "admin");
  await reqPublica("GET", "/api/v1/public/equipamentos", criada.chave, undefined, 401);
});

test("rate limit por chave de API retorna 429 após esgotar a janela configurada para o parceiro", async () => {
  const chaveLimitada = (await reqInterna("POST", "/api/v1/internal/chaves-api", {
    parceiro: "Parceiro Cota Restrita",
    organizacaoId: orgCircularId,
    escopos: ["RASTREABILIDADE_LEITURA"],
    limitePorMinuto: 2,
  }, "admin", 201)).json<ChaveCriada>();

  await reqPublica("GET", "/api/v1/public/equipamentos", chaveLimitada.chave, undefined, 200);
  await reqPublica("GET", "/api/v1/public/equipamentos", chaveLimitada.chave, undefined, 200);
  const bloqueada = await reqPublica("GET", "/api/v1/public/equipamentos", chaveLimitada.chave, undefined, 429);
  assert.equal(bloqueada.json<{ erro: { codigo: string } }>().erro.codigo, "LIMITE_REQUISICOES_EXCEDIDO");

  // Outra chave de API mantém sua própria janela independente
  await reqPublica("GET", "/api/v1/public/equipamentos", CHAVE_API_DEMONSTRACAO, undefined, 200);
});

test("orquestração assíncrona: fila, polling e download de relatório preditivo em CSV e JSON", async () => {
  // Parceiro solicita relatório preditivo completo em CSV
  const solicitacaoCsv = await reqPublica("POST", "/api/v1/public/relatorios/tarefas", CHAVE_API_DEMONSTRACAO, {
    tipo: "VIDA_UTIL", formato: "CSV",
  }, 202);
  const tarefaCsv = solicitacaoCsv.json<Tarefa>();
  assert.equal(solicitacaoCsv.headers.location, `/api/v1/public/relatorios/tarefas/${tarefaCsv.id}`);

  const concluidaCsv = await aguardarTarefa(`/api/v1/public/relatorios/tarefas/${tarefaCsv.id}`, { "x-api-key": CHAVE_API_DEMONSTRACAO });
  assert.ok(concluidaCsv.relatorioId);

  const downloadCsv = await reqPublica("GET", `/api/v1/public/relatorios/tarefas/${tarefaCsv.id}/download`, CHAVE_API_DEMONSTRACAO);
  assert.match(String(downloadCsv.headers["content-type"]), /text\/csv/);
  assert.match(String(downloadCsv.headers["content-disposition"]), /attachment; filename="relatorio-vida_util-.*\.csv"/);
  assert.match(downloadCsv.body, /codigoBarrasInterno,tipo,marca,modelo,anoFabricacao,estadoFisico,idadeAtualAnos,vidaRemanescenteAnos/);
  assert.match(downloadCsv.body, /GC-DEMO-1/);

  // Auditor interno solicita relatório de rentabilidade em JSON
  const solicitacaoJson = (await reqInterna("POST", "/api/v1/internal/analitico/tarefas", {
    tipo: "RENTABILIDADE", formato: "JSON", organizacaoId: orgCircularId,
  }, "auditor", 202)).json<Tarefa>();

  await aguardarTarefa(`/api/v1/internal/analitico/tarefas/${solicitacaoJson.id}`, { authorization: `Bearer ${tokens.auditor}` });
  const downloadJson = await reqInterna("GET", `/api/v1/internal/analitico/tarefas/${solicitacaoJson.id}/download`, undefined, "auditor");
  assert.equal(downloadJson.json<RelatorioAnalitico>().tipo, "RENTABILIDADE");
});

test("política de retry: falha transitória é reprocessada com backoff exponencial até concluir", async () => {
  const original = ServicoAnalitico.prototype.executarPorTipo;
  let chamadas = 0;
  ServicoAnalitico.prototype.executarPorTipo = async function (...args) {
    chamadas++;
    if (chamadas === 1) throw new Error("Falha transitória simulada na primeira tentativa");
    return original.apply(this, args);
  };
  try {
    const tarefa = (await reqPublica("POST", "/api/v1/public/relatorios/tarefas", CHAVE_API_DEMONSTRACAO, {
      tipo: "EFICIENCIA_OPERACIONAL", formato: "JSON",
    }, 202)).json<Tarefa>();
    const concluida = await aguardarTarefa(`/api/v1/public/relatorios/tarefas/${tarefa.id}`, { "x-api-key": CHAVE_API_DEMONSTRACAO });
    assert.equal(concluida.tentativas, 2);
    assert.equal(concluida.ultimoErro, null);
  } finally {
    ServicoAnalitico.prototype.executarPorTipo = original;
  }
});

test("política de retry: erro de domínio não recuperável encerra na primeira tentativa com status FALHOU", async () => {
  const original = ServicoAnalitico.prototype.executarPorTipo;
  let chamadas = 0;
  ServicoAnalitico.prototype.executarPorTipo = async function () {
    chamadas++;
    throw new ErroAplicacao(422, "REGRA_NEGOCIO", "Parâmetro analítico inválido para o modelo.");
  };
  try {
    const tarefa = (await reqPublica("POST", "/api/v1/public/relatorios/tarefas", CHAVE_API_DEMONSTRACAO, {
      tipo: "RENTABILIDADE", formato: "JSON",
    }, 202)).json<Tarefa>();
    const falhou = await aguardarTarefa(`/api/v1/public/relatorios/tarefas/${tarefa.id}`, { "x-api-key": CHAVE_API_DEMONSTRACAO }, "FALHOU");
    assert.equal(chamadas, 1);
    assert.equal(falhou.tentativas, 1);
    assert.match(falhou.ultimoErro ?? "", /Parâmetro analítico inválido/);
    await reqPublica("GET", `/api/v1/public/relatorios/tarefas/${tarefa.id}/download`, CHAVE_API_DEMONSTRACAO, undefined, 422);
  } finally {
    ServicoAnalitico.prototype.executarPorTipo = original;
  }
});
