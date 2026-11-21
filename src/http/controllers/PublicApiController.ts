import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { ServicoAnalitico } from "../../application/analitico/ServicosAnaliticos.js";
import type { ServicoEquipamento } from "../../application/ServicoEquipamento.js";
import type { ServicoLote } from "../../application/ServicoLote.js";
import type { ServicoTarefaAnalitica } from "../../application/ServicoTarefaAnalitica.js";
import * as S from "../schemas.js";
import type { ComCodigo, ComId, Consulta, Corpo } from "../tipos.js";
import { responderDownload } from "./AnaliticoController.js";

export function registrarApiPublica(
  app: FastifyInstance,
  servicos: {
    lotes: ServicoLote;
    equipamentos: ServicoEquipamento;
    analitico: ServicoAnalitico;
    tarefas: ServicoTarefaAnalitica;
  },
) {
  // ---------- Rastreabilidade de equipamentos ----------

  app.get<Consulta<typeof S.EquipamentoFiltro>>("/equipamentos", {
    schema: { ...S.documentar("API Pública — Rastreabilidade", "Listar equipamentos da organização do parceiro", S.paginaDe(S.EquipamentoResposta), 200, "apiKey"), querystring: S.EquipamentoFiltro },
  }, request => servicos.equipamentos.listarComoParceiro(request.parceiro, request.query));

  app.get<ComId>("/equipamentos/:id", {
    schema: { ...S.documentar("API Pública — Rastreabilidade", "Consultar rastreabilidade e depreciação por ID", S.RastreabilidadeResposta, 200, "apiKey"), params: S.IdParams },
  }, request => servicos.equipamentos.buscarComoParceiro(request.parceiro, request.params.id));

  app.get<ComCodigo>("/rastreabilidade/:codigo", {
    schema: { ...S.documentar("API Pública — Rastreabilidade", "Consultar rastreabilidade completa pelo código de barras interno", S.RastreabilidadeResposta, 200, "apiKey"), params: S.CodigoParams },
  }, request => servicos.equipamentos.buscarPorCodigoComoParceiro(request.parceiro, request.params.codigo));

  // ---------- Lotes do parceiro ----------

  app.get<Consulta<typeof S.LoteParceiroFiltro>>("/lotes", {
    schema: { ...S.documentar("API Pública — Lotes", "Listar lotes submetidos pela organização do parceiro", S.paginaDe(S.LoteResposta), 200, "apiKey"), querystring: S.LoteParceiroFiltro },
  }, request => servicos.lotes.listarComoParceiro(request.parceiro, request.query));

  app.get<ComId>("/lotes/:id", {
    schema: { ...S.documentar("API Pública — Lotes", "Consultar lote, equipamentos e peso total", S.LoteResposta, 200, "apiKey"), params: S.IdParams },
  }, request => servicos.lotes.buscarComoParceiro(request.parceiro, request.params.id));

  app.post<Corpo<typeof S.LoteParceiroEntrada>>("/lotes", {
    schema: { ...S.documentar("API Pública — Lotes", "Submeter novo lote e equipamentos atomicamente (escopo LOTES_ESCRITA)", S.LoteResposta, 201, "apiKey"), body: S.LoteParceiroEntrada },
  }, async (request, reply) => {
    const lote = await servicos.lotes.criarComoParceiro(request.parceiro, request.body);
    return reply.code(201).header("Location", `/api/v1/public/lotes/${lote.id}`).send(lote);
  });

  app.post<ComId & Corpo<typeof S.AdicionarEquipamentos>>("/lotes/:id/equipamentos", {
    schema: { ...S.documentar("API Pública — Lotes", "Adicionar equipamentos a lote recebido do parceiro (escopo LOTES_ESCRITA)", S.LoteResposta, 201, "apiKey"), params: S.IdParams, body: S.AdicionarEquipamentos },
  }, async (request, reply) => reply.code(201).send(await servicos.lotes.adicionarEquipamentosComoParceiro(request.parceiro, request.params.id, request.body)));

  // ---------- Relatórios analíticos síncronos ----------

  app.get<Consulta<typeof S.PeriodoOpcional>>("/analitico/eficiencia", {
    schema: { ...S.documentar("API Pública — Análises", "Gerar análise de eficiência operacional dos lotes do parceiro", S.RelatorioAnaliticoResposta, 200, "apiKey"), querystring: S.PeriodoOpcional },
  }, request => servicos.analitico.eficiencia.executarComoParceiro(request.parceiro, request.query));

  app.get<Consulta<typeof S.RentabilidadeParceiroFiltro>>("/analitico/rentabilidade", {
    schema: { ...S.documentar("API Pública — Análises", "Gerar análise de rentabilidade por tipo, marca, modelo e estado físico", S.RelatorioAnaliticoResposta, 200, "apiKey"), querystring: S.RentabilidadeParceiroFiltro },
  }, request => servicos.analitico.rentabilidade.executarComoParceiro(request.parceiro, request.query));

  app.get<Consulta<typeof S.PeriodoOpcional>>("/analitico/vida-util", {
    schema: { ...S.documentar("API Pública — Análises", "Gerar previsão de vida útil remanescente (OLS) dos equipamentos do parceiro", S.RelatorioAnaliticoResposta, 200, "apiKey"), querystring: S.PeriodoOpcional },
  }, request => servicos.analitico.vidaUtil.executarComoParceiro(request.parceiro, request.query));

  app.get<Consulta<typeof S.HistoricoAnaliseParceiroFiltro>>("/analitico/relatorios", {
    schema: { ...S.documentar("API Pública — Análises", "Listar relatórios analíticos anteriores da organização do parceiro", S.paginaDe(S.RelatorioAnaliticoResumoResposta), 200, "apiKey"), querystring: S.HistoricoAnaliseParceiroFiltro },
  }, request => servicos.analitico.listarHistoricoComoParceiro(request.parceiro, request.query));

  app.get<ComId>("/analitico/relatorios/:id", {
    schema: { ...S.documentar("API Pública — Análises", "Consultar relatório analítico histórico da organização do parceiro", S.RelatorioAnaliticoResposta, 200, "apiKey"), params: S.IdParams },
  }, request => servicos.analitico.buscarComoParceiro(request.parceiro, request.params.id));

  // ---------- Orquestração assíncrona (fila + polling + download CSV/JSON) ----------

  app.post<Corpo<typeof S.TarefaParceiroEntrada>>("/relatorios/tarefas", {
    schema: { ...S.documentar("API Pública — Tarefas Assíncronas", "Solicitar geração assíncrona de relatório analítico CSV ou JSON", S.TarefaResposta, 202, "apiKey"), body: S.TarefaParceiroEntrada },
  }, async (request, reply) => {
    const tarefa = await servicos.tarefas.solicitarComoParceiro(request.parceiro, request.body);
    return reply.code(202).header("Location", `/api/v1/public/relatorios/tarefas/${tarefa.id}`).send(tarefa);
  });

  app.get<Consulta<typeof S.TarefaFiltro>>("/relatorios/tarefas", {
    schema: { ...S.documentar("API Pública — Tarefas Assíncronas", "Listar tarefas analíticas assíncronas do parceiro", S.paginaDe(S.TarefaResposta), 200, "apiKey"), querystring: S.TarefaFiltro },
  }, request => servicos.tarefas.listarComoParceiro(request.parceiro, request.query));

  app.get<ComId>("/relatorios/tarefas/:id", {
    schema: { ...S.documentar("API Pública — Tarefas Assíncronas", "Consultar status da tarefa de relatório assíncrono (polling)", S.TarefaResposta, 200, "apiKey"), params: S.IdParams },
  }, request => servicos.tarefas.consultarStatusComoParceiro(request.parceiro, request.params.id));

  app.get<ComId>("/relatorios/tarefas/:id/download", {
    schema: {
      ...S.documentar("API Pública — Tarefas Assíncronas", "Fazer download do relatório analítico concluído (CSV ou JSON)", Type.Union([S.RelatorioAnaliticoResposta, Type.String()]), 200, "apiKey"),
      params: S.IdParams,
    },
  }, async (request, reply) => responderDownload(reply, await servicos.tarefas.baixarComoParceiro(request.parceiro, request.params.id)));
}
