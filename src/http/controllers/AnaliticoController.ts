import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServicoAnalitico } from "../../application/analitico/ServicosAnaliticos.js";
import type { ServicoTarefaAnalitica } from "../../application/ServicoTarefaAnalitica.js";
import * as S from "../schemas.js";
import type { ComId, Consulta, Corpo } from "../tipos.js";

export function responderDownload(
  reply: FastifyReply,
  resultado: Awaited<ReturnType<ServicoTarefaAnalitica["baixarComoUsuario"]>>,
) {
  return reply
    .header("Content-Type", resultado.contentType)
    .header("Content-Disposition", `attachment; filename="${resultado.nomeArquivo}"`)
    .send(resultado.conteudo);
}

export function registrarAnaliticoInterno(
  app: FastifyInstance,
  analitico: ServicoAnalitico,
  tarefas: ServicoTarefaAnalitica,
) {
  app.get<Consulta<typeof S.AnaliseFiltro>>("/analitico/eficiencia", {
    schema: { ...S.documentar("Camada Analítica", "Calcular e persistir eficiência operacional de triagem (auditor/administrador)", S.RelatorioAnaliticoResposta), querystring: S.AnaliseFiltro },
  }, request => analitico.eficiencia.executarComoUsuario(request.ator, request.query));

  app.get<Consulta<typeof S.RentabilidadeFiltro>>("/analitico/rentabilidade", {
    schema: { ...S.documentar("Camada Analítica", "Calcular e persistir rentabilidade por tipo, marca, modelo e estado físico (auditor/administrador)", S.RelatorioAnaliticoResposta), querystring: S.RentabilidadeFiltro },
  }, request => analitico.rentabilidade.executarComoUsuario(request.ator, request.query));

  app.get<Consulta<typeof S.AnaliseFiltro>>("/analitico/vida-util", {
    schema: { ...S.documentar("Camada Analítica", "Projetar vida útil remanescente via regressão linear OLS e persistir modelo (auditor/administrador)", S.RelatorioAnaliticoResposta), querystring: S.AnaliseFiltro },
  }, request => analitico.vidaUtil.executarComoUsuario(request.ator, request.query));

  app.get<Consulta<typeof S.HistoricoAnaliseFiltro>>("/analitico/relatorios", {
    schema: { ...S.documentar("Camada Analítica", "Listar histórico de relatórios analíticos persistidos (auditor/administrador)", S.paginaDe(S.RelatorioAnaliticoResumoResposta)), querystring: S.HistoricoAnaliseFiltro },
  }, request => analitico.listarHistorico(request.ator, request.query));

  app.get<ComId>("/analitico/relatorios/:id", {
    schema: { ...S.documentar("Camada Analítica", "Consultar relatório analítico histórico com modelos e previsões (auditor/administrador)", S.RelatorioAnaliticoResposta), params: S.IdParams },
  }, request => analitico.buscar(request.ator, request.params.id));

  app.post<Corpo<typeof S.TarefaEntrada>>("/analitico/tarefas", {
    schema: { ...S.documentar("Tarefas Assíncronas", "Enfileirar geração assíncrona de relatório analítico CSV ou JSON (auditor/administrador)", S.TarefaResposta, 202), body: S.TarefaEntrada },
  }, async (request, reply) => {
    const tarefa = await tarefas.solicitarComoUsuario(request.ator, request.body);
    return reply.code(202).header("Location", `/api/analitico/tarefas/${tarefa.id}`).send(tarefa);
  });

  app.get<Consulta<typeof S.TarefaFiltro>>("/analitico/tarefas", {
    schema: { ...S.documentar("Tarefas Assíncronas", "Listar tarefas analíticas assíncronas (auditor/administrador)", S.paginaDe(S.TarefaResposta)), querystring: S.TarefaFiltro },
  }, request => tarefas.listarComoUsuario(request.ator, request.query));

  app.get<ComId>("/analitico/tarefas/:id", {
    schema: { ...S.documentar("Tarefas Assíncronas", "Consultar status da tarefa analítica assíncrona (polling)", S.TarefaResposta), params: S.IdParams },
  }, request => tarefas.consultarStatusComoUsuario(request.ator, request.params.id));

  app.get<ComId>("/analitico/tarefas/:id/download", {
    schema: {
      ...S.documentar("Tarefas Assíncronas", "Baixar relatório analítico concluído em JSON ou CSV", Type.Union([S.RelatorioAnaliticoResposta, Type.String()])),
      params: S.IdParams,
    },
  }, async (request, reply) => responderDownload(reply, await tarefas.baixarComoUsuario(request.ator, request.params.id)));
}
