import {
  DimensaoEficiencia, EstadoFisico, NivelRentabilidade, OrigemAnalise, Prisma,
  TipoAnalise, TipoEquipamento,
} from "@prisma/client";
import { linearRegression, linearRegressionLine, mean, median, quantile, rSquared, sampleStandardDeviation } from "simple-statistics";
import {
  autorizar, autorizarEscopo, paraAtor,
  type AtorAuditoria, type ParceiroAutenticado, type UsuarioAutenticado,
} from "../../domain/autorizacao.js";
import type { FiltroAnalise, FiltroHistoricoAnalises, FiltroRentabilidade } from "../../domain/dados.js";
import { encontrado } from "../../domain/erros.js";
import { RegrasEquipamento } from "../../domain/RegrasEquipamento.js";
import { validarPeriodo } from "../../domain/validacoes.js";
import { BancoDados } from "../../infrastructure/BancoDados.js";

const VERSAO_MODELO = "av3-ols-1.0";
const MS_POR_HORA = 3_600_000;
const MS_POR_ANO = 365.25 * 86_400_000;

function arredondar(valor: number, casas = 4): number {
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}

function estatisticas(valores: number[]) {
  if (valores.length === 0) return { media: 0, mediana: 0, desvio: 0, p90: 0 };
  const desvio = valores.length > 1 ? sampleStandardDeviation(valores) : 0;
  return {
    media: arredondar(mean(valores)),
    mediana: arredondar(median(valores)),
    desvio: arredondar(desvio),
    p90: arredondar(quantile(valores, 0.9)),
  };
}

function solicitante(ator?: AtorAuditoria) {
  if (!ator) return { solicitanteUsuarioId: null, solicitanteChaveApiId: null };
  return ator.tipo === "USUARIO"
    ? { solicitanteUsuarioId: ator.usuario.id, solicitanteChaveApiId: null }
    : { solicitanteUsuarioId: null, solicitanteChaveApiId: ator.parceiro.id };
}

function json(dados: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(dados)) as Prisma.InputJsonValue;
}

// ============================================================================
// 1. Análise de eficiência operacional
// ============================================================================

interface AmostraLote {
  operador: string;
  mes: string;
  esperaHoras: number;
  triagemHoras: number;
  totalHoras: number;
}

export class ServicoEficienciaOperacional {
  constructor(private readonly banco: BancoDados) {}

  executarComoUsuario(ator: UsuarioAutenticado, filtro: FiltroAnalise) {
    autorizar(ator, "AUDITOR");
    return this.executar(filtro, "API_INTERNA", paraAtor(ator));
  }

  executarComoParceiro(parceiro: ParceiroAutenticado, filtro: Omit<FiltroAnalise, "organizacaoId">) {
    autorizarEscopo(parceiro, "RELATORIOS_ANALITICOS");
    return this.executar({ ...filtro, organizacaoId: parceiro.organizacaoId }, "API_PUBLICA", paraAtor(parceiro));
  }

  async executar(filtro: FiltroAnalise = {}, origem: OrigemAnalise = "AGENDADA", ator?: AtorAuditoria) {
    const inicioExecucao = Date.now();
    const periodo = validarPeriodo(filtro.inicio, filtro.fim);
    return this.banco.transacao(async repos => {
      if (filtro.organizacaoId) encontrado(await repos.organizacoes.buscar(filtro.organizacaoId), "Organização");
      const lotes = await repos.lotes.listarComMovimentacoes({
        organizacaoId: filtro.organizacaoId, dataEntrada: periodo,
      });

      const amostras: AmostraLote[] = [];
      for (const lote of lotes) {
        const movimentos = lote.equipamentos.flatMap(item => item.historicoMovimentacao);
        const inicios = movimentos.filter(m => m.tipo === "STATUS" && m.destino === "EM_TRIAGEM");
        const conclusoes = movimentos.filter(m => m.tipo === "STATUS" && m.destino === "AGUARDANDO_DESMONTE");
        if (conclusoes.length === 0) continue;

        const entradaMs = lote.dataEntrada.getTime();
        const inicioMs = inicios.length > 0 ? Math.min(...inicios.map(m => m.dataHora.getTime())) : entradaMs;
        const conclusaoMaisRecente = conclusoes.reduce((a, b) => a.dataHora >= b.dataHora ? a : b);
        const conclusaoMs = conclusaoMaisRecente.dataHora.getTime();

        const esperaHoras = Math.max(0, (inicioMs - entradaMs) / MS_POR_HORA);
        const triagemHoras = Math.max(0, (conclusaoMs - Math.max(entradaMs, inicioMs)) / MS_POR_HORA);
        const totalHoras = Math.max(0, (conclusaoMs - entradaMs) / MS_POR_HORA);
        amostras.push({
          operador: conclusaoMaisRecente.responsavel,
          mes: lote.dataEntrada.toISOString().slice(0, 7),
          esperaHoras, triagemHoras, totalHoras,
        });
      }

      const criarIndicador = (dimensao: DimensaoEficiencia, chave: string, grupo: AmostraLote[]) => {
        const totais = estatisticas(grupo.map(a => a.totalHoras));
        return {
          dimensao, chave, lotes: grupo.length,
          esperaMediaHoras: arredondar(mean(grupo.map(a => a.esperaHoras))),
          triagemMediaHoras: arredondar(mean(grupo.map(a => a.triagemHoras))),
          totalMediaHoras: totais.media, totalMedianaHoras: totais.mediana,
          totalDesvioHoras: totais.desvio, totalP90Horas: totais.p90,
        };
      };

      const indicadores: ReturnType<typeof criarIndicador>[] = [];
      if (amostras.length > 0) {
        indicadores.push(criarIndicador("GERAL", "GLOBAL", amostras));
        const porOperador = new Map<string, AmostraLote[]>();
        const porMes = new Map<string, AmostraLote[]>();
        for (const amostra of amostras) {
          porOperador.set(amostra.operador, [...(porOperador.get(amostra.operador) ?? []), amostra]);
          porMes.set(amostra.mes, [...(porMes.get(amostra.mes) ?? []), amostra]);
        }
        for (const [chave, grupo] of [...porOperador.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          indicadores.push(criarIndicador("OPERADOR", chave, grupo));
        }
        for (const [chave, grupo] of [...porMes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          indicadores.push(criarIndicador("MES", chave, grupo));
        }
      }

      const geral = indicadores.find(i => i.dimensao === "GERAL");
      const operadores = indicadores.filter(i => i.dimensao === "OPERADOR").sort((a, b) => b.totalMediaHoras - a.totalMediaHoras);
      const gargaloEtapa = !geral ? "SEM_DADOS" : geral.esperaMediaHoras > geral.triagemMediaHoras ? "FILA_ESPERA_ANTES_TRIAGEM" : "EXECUCAO_TRIAGEM";
      const resumo = {
        lotesAvaliados: lotes.length,
        lotesComTriagemConcluida: amostras.length,
        lotesPendentesTriagem: lotes.length - amostras.length,
        tempoMedioTotalHoras: geral?.totalMediaHoras ?? 0,
        tempoMedianoTotalHoras: geral?.totalMedianaHoras ?? 0,
        gargaloEtapa,
        operadorMaiorTempoMedio: operadores[0]?.chave ?? null,
        operadorMenorTempoMedio: operadores.at(-1)?.chave ?? null,
      };

      const relatorio = await repos.analitico.criarRelatorio({
        tipo: "EFICIENCIA_OPERACIONAL", origem, organizacaoId: filtro.organizacaoId ?? null,
        parametros: json(filtro), resumo: json(resumo), versaoModelo: VERSAO_MODELO,
        amostras: amostras.length, duracaoMs: Math.max(0, Date.now() - inicioExecucao),
        ...solicitante(ator),
        indicadoresEficiencia: { create: indicadores },
      });
      if (ator) await repos.auditoria.registrar(ator, "GERAR_ANALISE_EFICIENCIA", "RelatorioAnalitico", relatorio.id, { tipo: relatorio.tipo, amostras: relatorio.amostras });
      return relatorio;
    });
  }
}

// ============================================================================
// 2. Análise de rentabilidade por tipo de equipamento
// ============================================================================

interface AmostraValor {
  tipo: TipoEquipamento;
  marca: string;
  modelo: string;
  estadoFisico: EstadoFisico;
  valor: number;
  realizado: boolean;
}

export class ServicoRentabilidadeEquipamento {
  constructor(private readonly banco: BancoDados) {}

  executarComoUsuario(ator: UsuarioAutenticado, filtro: FiltroRentabilidade) {
    autorizar(ator, "AUDITOR");
    return this.executar(filtro, "API_INTERNA", paraAtor(ator));
  }

  executarComoParceiro(parceiro: ParceiroAutenticado, filtro: Omit<FiltroRentabilidade, "organizacaoId">) {
    autorizarEscopo(parceiro, "RELATORIOS_ANALITICOS");
    return this.executar({ ...filtro, organizacaoId: parceiro.organizacaoId }, "API_PUBLICA", paraAtor(parceiro));
  }

  async executar(filtro: FiltroRentabilidade = {}, origem: OrigemAnalise = "AGENDADA", ator?: AtorAuditoria) {
    const inicioExecucao = Date.now();
    const periodo = validarPeriodo(filtro.inicio, filtro.fim);
    return this.banco.transacao(async repos => {
      if (filtro.organizacaoId) encontrado(await repos.organizacoes.buscar(filtro.organizacaoId), "Organização");
      const equipamentos = await repos.equipamentos.listarParaAnalise({
        tipo: filtro.tipo,
        lote: { organizacaoId: filtro.organizacaoId, dataEntrada: periodo },
      });

      const amostras: AmostraValor[] = equipamentos.map(item => {
        const valor = item.valorRecuperado !== null
          ? Number(item.valorRecuperado)
          : RegrasEquipamento.estimarValorRecuperacao(item.tipo, item.estadoFisico, Number(item.pesoQuilogramas), item.anoFabricacao);
        return {
          tipo: item.tipo, marca: item.marca, modelo: item.modelo,
          estadoFisico: item.estadoFisico, valor, realizado: item.valorRecuperado !== null,
        };
      });

      const niveis: NivelRentabilidade[] = filtro.nivel
        ? [filtro.nivel]
        : ["TIPO", "TIPO_ESTADO", "TIPO_MARCA_MODELO", "TIPO_MARCA_MODELO_ESTADO"];

      const indicadores: Prisma.IndicadorRentabilidadeCreateWithoutRelatorioInput[] = [];
      for (const nivel of niveis) {
        const grupos = new Map<string, AmostraValor[]>();
        for (const amostra of amostras) {
          const chave = [
            amostra.tipo,
            nivel === "TIPO_MARCA_MODELO" || nivel === "TIPO_MARCA_MODELO_ESTADO" ? amostra.marca : "",
            nivel === "TIPO_MARCA_MODELO" || nivel === "TIPO_MARCA_MODELO_ESTADO" ? amostra.modelo : "",
            nivel === "TIPO_ESTADO" || nivel === "TIPO_MARCA_MODELO_ESTADO" ? amostra.estadoFisico : "",
          ].join("|");
          grupos.set(chave, [...(grupos.get(chave) ?? []), amostra]);
        }
        for (const grupo of grupos.values()) {
          const primeiro = grupo[0]!;
          const valores = grupo.map(g => g.valor);
          const est = estatisticas(valores);
          const total = valores.reduce((soma, v) => soma.plus(v.toFixed(2)), new Prisma.Decimal(0));
          indicadores.push({
            nivel,
            tipoEquipamento: primeiro.tipo,
            marca: nivel === "TIPO_MARCA_MODELO" || nivel === "TIPO_MARCA_MODELO_ESTADO" ? primeiro.marca : null,
            modelo: nivel === "TIPO_MARCA_MODELO" || nivel === "TIPO_MARCA_MODELO_ESTADO" ? primeiro.modelo : null,
            estadoFisico: nivel === "TIPO_ESTADO" || nivel === "TIPO_MARCA_MODELO_ESTADO" ? primeiro.estadoFisico : null,
            amostras: grupo.length,
            valorMedio: est.media.toFixed(2),
            valorMediano: est.mediana.toFixed(2),
            desvioPadrao: est.desvio.toFixed(2),
            valorTotal: total.toFixed(2),
          });
        }
      }

      const porTipo = indicadores
        .filter(i => i.nivel === (filtro.nivel ?? "TIPO"))
        .sort((a, b) => Number(b.valorMedio) - Number(a.valorMedio));
      const valorTotalEstimado = amostras.reduce((soma, a) => soma.plus(a.valor.toFixed(2)), new Prisma.Decimal(0));
      const resumo = {
        moeda: "BRL",
        equipamentosAnalisados: amostras.length,
        amostrasComValorRealizado: amostras.filter(a => a.realizado).length,
        amostrasComValorEstimado: amostras.filter(a => !a.realizado).length,
        valorTotalRecuperacao: valorTotalEstimado.toFixed(2),
        tipoMaiorRetornoMedio: porTipo[0]?.tipoEquipamento ?? null,
        maiorValorMedio: porTipo[0]?.valorMedio ?? "0.00",
      };

      const relatorio = await repos.analitico.criarRelatorio({
        tipo: "RENTABILIDADE", origem, organizacaoId: filtro.organizacaoId ?? null,
        parametros: json(filtro), resumo: json(resumo), versaoModelo: VERSAO_MODELO,
        amostras: amostras.length, duracaoMs: Math.max(0, Date.now() - inicioExecucao),
        ...solicitante(ator),
        indicadoresRentabilidade: { create: indicadores },
      });
      if (ator) await repos.auditoria.registrar(ator, "GERAR_ANALISE_RENTABILIDADE", "RelatorioAnalitico", relatorio.id, { tipo: relatorio.tipo, amostras: relatorio.amostras });
      return relatorio;
    });
  }
}

// ============================================================================
// 3. Análise preditiva de vida útil remanescente (Mínimos Quadrados Ordinários)
// ============================================================================

const INDICE_INSERVIVEL = RegrasEquipamento.indiceEstado("INSERVIVEL"); // 6
const TAXA_DEGRADACAO_PADRAO = 0.6; // categorias de estado físico por ano (10 anos de NOVO a INSERVIVEL)

export class ServicoVidaUtilPreditiva {
  constructor(private readonly banco: BancoDados) {}

  executarComoUsuario(ator: UsuarioAutenticado, filtro: FiltroAnalise) {
    autorizar(ator, "AUDITOR");
    return this.executar(filtro, "API_INTERNA", paraAtor(ator));
  }

  executarComoParceiro(parceiro: ParceiroAutenticado, filtro: Omit<FiltroAnalise, "organizacaoId">) {
    autorizarEscopo(parceiro, "RELATORIOS_ANALITICOS");
    return this.executar({ ...filtro, organizacaoId: parceiro.organizacaoId }, "API_PUBLICA", paraAtor(parceiro));
  }

  async executar(filtro: FiltroAnalise = {}, origem: OrigemAnalise = "AGENDADA", ator?: AtorAuditoria, referencia = new Date()) {
    const inicioExecucao = Date.now();
    const periodo = validarPeriodo(filtro.inicio, filtro.fim);
    const anoReferencia = referencia.getUTCFullYear() + (referencia.getUTCMonth() / 12);

    return this.banco.transacao(async repos => {
      if (filtro.organizacaoId) encontrado(await repos.organizacoes.buscar(filtro.organizacaoId), "Organização");
      const equipamentos = await repos.equipamentos.listarParaAnalise({
        lote: { organizacaoId: filtro.organizacaoId, dataEntrada: periodo },
      });

      const porTipo = new Map<TipoEquipamento, typeof equipamentos>();
      for (const item of equipamentos) {
        porTipo.set(item.tipo, [...(porTipo.get(item.tipo) ?? []), item]);
      }

      const modelosParaCriar: {
        modelo: Omit<Prisma.ModeloVidaUtilUncheckedCreateWithoutRelatorioInput, "previsoes">;
        previsoes: Omit<Prisma.PrevisaoVidaUtilUncheckedCreateWithoutModeloInput, "relatorioId">[];
      }[] = [];

      for (const [tipo, itens] of [...porTipo.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        // Pontos (x = idade em anos no evento, y = índice severidade 0..6 de NOVO a INSERVIVEL).
        const pontos: [number, number][] = [];
        for (const item of itens) {
          const anoEntrada = item.lote.dataEntrada.getUTCFullYear() + (item.lote.dataEntrada.getUTCMonth() / 12);
          pontos.push([Math.max(0, anoEntrada - item.anoFabricacao), RegrasEquipamento.indiceEstado(item.estadoFisico)]);
          for (const mov of item.historicoMovimentacao) {
            if (mov.tipo === "ESTADO_FISICO" && Object.values(EstadoFisico).includes(mov.destino as EstadoFisico)) {
              const anoMov = mov.dataHora.getUTCFullYear() + (mov.dataHora.getUTCMonth() / 12);
              pontos.push([Math.max(0, anoMov - item.anoFabricacao), RegrasEquipamento.indiceEstado(mov.destino as EstadoFisico)]);
            }
          }
        }

        const idadesDistintas = new Set(pontos.map(p => Math.round(p[0] * 100))).size;
        let intercepto: number | null = null;
        let inclinacao: number | null = null;
        let r2: number | null = null;
        let confiavel = false;
        let observacao = "Amostras com baixa variância de idade; aplicada taxa física padrão de 0,6 categoria/ano.";

        if (pontos.length >= 2 && idadesDistintas >= 2) {
          const reta = linearRegression(pontos);
          const preditor = linearRegressionLine(reta);
          const coefR2 = rSquared(pontos, preditor);
          intercepto = arredondar(reta.b);
          inclinacao = arredondar(reta.m);
          r2 = Number.isFinite(coefR2) ? arredondar(Math.max(0, Math.min(1, coefR2))) : 0;
          if (reta.m > 0.05) {
            confiavel = true;
            observacao = `Regressão OLS ajustada com ${pontos.length} observações (R² = ${r2}).`;
          } else {
            observacao = "Inclinação OLS não positiva; aplicada taxa física padrão para projeção conservadora.";
          }
        }

        const taxaAnual = confiavel && inclinacao ? inclinacao : TAXA_DEGRADACAO_PADRAO;
        const baseIntercepto = confiavel && intercepto !== null ? intercepto : 0;
        const idadeInservivelAnos = arredondar(Math.max(0, (INDICE_INSERVIVEL - baseIntercepto) / taxaAnual));

        const ativos = itens.filter(item => item.statusRastreamento !== "BAIXA_DEFINITIVA");
        const previsoes = ativos.map(item => {
          const idadeAtualAnos = arredondar(Math.max(0, anoReferencia - item.anoFabricacao));
          const severidadeAtual = RegrasEquipamento.indiceEstado(item.estadoFisico);
          const severidadeProjetada = confiavel && intercepto !== null && inclinacao !== null
            ? Math.max(severidadeAtual, intercepto + inclinacao * idadeAtualAnos)
            : severidadeAtual;
          const vidaRemanescenteAnos = item.estadoFisico === "INSERVIVEL"
            ? 0
            : arredondar(Math.max(0, (INDICE_INSERVIVEL - severidadeProjetada) / taxaAnual));
          const dataPrevistaInservivel = new Date(referencia.getTime() + vidaRemanescenteAnos * MS_POR_ANO);
          return {
            equipamentoId: item.id,
            idadeAtualAnos,
            vidaRemanescenteAnos,
            dataPrevistaInservivel,
          };
        });

        modelosParaCriar.push({
          modelo: {
            tipoEquipamento: tipo, amostras: pontos.length, intercepto, inclinacao, r2,
            idadeInservivelAnos, confiavel, observacao,
          },
          previsoes,
        });
      }

      const todasPrevisoes = modelosParaCriar.flatMap(m => m.previsoes);
      const resumo = {
        equipamentosAvaliados: equipamentos.length,
        equipamentosAtivosProjetados: todasPrevisoes.length,
        modelosAjustados: modelosParaCriar.length,
        modelosConfiaveisOls: modelosParaCriar.filter(m => m.modelo.confiavel).length,
        vidaRemanescenteMediaAnos: todasPrevisoes.length > 0 ? arredondar(mean(todasPrevisoes.map(p => p.vidaRemanescenteAnos))) : 0,
        equipamentosCriticosMenosDeUmAno: todasPrevisoes.filter(p => p.vidaRemanescenteAnos <= 1).length,
      };

      const criado = await repos.analitico.criarRelatorio({
        tipo: "VIDA_UTIL", origem, organizacaoId: filtro.organizacaoId ?? null,
        parametros: json(filtro), resumo: json(resumo), versaoModelo: VERSAO_MODELO,
        amostras: equipamentos.length, duracaoMs: Math.max(0, Date.now() - inicioExecucao),
        ...solicitante(ator),
      });

      for (const item of modelosParaCriar) {
        await repos.analitico.criarModeloVidaUtil({
          ...item.modelo,
          relatorioId: criado.id,
          previsoes: {
            create: item.previsoes.map(p => ({ ...p, relatorioId: criado.id })),
          },
        });
      }

      const relatorio = encontrado(await repos.analitico.buscarRelatorio(criado.id), "Relatório analítico");
      if (ator) await repos.auditoria.registrar(ator, "GERAR_ANALISE_VIDA_UTIL", "RelatorioAnalitico", relatorio.id, { tipo: relatorio.tipo, amostras: relatorio.amostras });
      return relatorio;
    });
  }
}

// ============================================================================
// Fachada de consulta histórica, execução unificada e exportação CSV/JSON
// ============================================================================

export type RelatorioAnaliticoCompleto = NonNullable<Awaited<ReturnType<ServicoAnalitico["buscarInterno"]>>>;

function escaparCsv(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  const texto = valor instanceof Date ? valor.toISOString() : String(valor);
  return /[",\r\n]/.test(texto) ? `"${texto.replace(/"/g, "\"\"")}"` : texto;
}

function montarCsv(cabecalhos: string[], linhas: unknown[][]): string {
  return [cabecalhos.join(","), ...linhas.map(linha => linha.map(escaparCsv).join(","))].join("\n") + "\n";
}

export class ServicoAnalitico {
  readonly eficiencia: ServicoEficienciaOperacional;
  readonly rentabilidade: ServicoRentabilidadeEquipamento;
  readonly vidaUtil: ServicoVidaUtilPreditiva;

  constructor(private readonly banco: BancoDados) {
    this.eficiencia = new ServicoEficienciaOperacional(banco);
    this.rentabilidade = new ServicoRentabilidadeEquipamento(banco);
    this.vidaUtil = new ServicoVidaUtilPreditiva(banco);
  }

  executarPorTipo(tipo: TipoAnalise, filtro: FiltroAnalise, origem: OrigemAnalise, ator?: AtorAuditoria) {
    if (tipo === "EFICIENCIA_OPERACIONAL") return this.eficiencia.executar(filtro, origem, ator);
    if (tipo === "RENTABILIDADE") return this.rentabilidade.executar(filtro, origem, ator);
    return this.vidaUtil.executar(filtro, origem, ator);
  }

  async executarCicloAgendado(organizacaoId?: string) {
    const filtro = organizacaoId ? { organizacaoId } : {};
    const eficiencia = await this.eficiencia.executar(filtro, "AGENDADA");
    const rentabilidade = await this.rentabilidade.executar(filtro, "AGENDADA");
    const vidaUtil = await this.vidaUtil.executar(filtro, "AGENDADA");
    return { eficiencia, rentabilidade, vidaUtil };
  }

  listarHistorico(ator: UsuarioAutenticado, filtro: FiltroHistoricoAnalises) {
    autorizar(ator, "AUDITOR");
    return this.banco.repositorios.analitico.listarRelatorios({
      tipo: filtro.tipo, organizacaoId: filtro.organizacaoId,
      geradoEm: validarPeriodo(filtro.inicio, filtro.fim),
    }, filtro);
  }

  listarHistoricoComoParceiro(parceiro: ParceiroAutenticado, filtro: Omit<FiltroHistoricoAnalises, "organizacaoId">) {
    autorizarEscopo(parceiro, "RELATORIOS_ANALITICOS");
    return this.banco.repositorios.analitico.listarRelatorios({
      tipo: filtro.tipo, organizacaoId: parceiro.organizacaoId,
      geradoEm: validarPeriodo(filtro.inicio, filtro.fim),
    }, filtro);
  }

  async buscar(ator: UsuarioAutenticado, id: string) {
    autorizar(ator, "AUDITOR");
    return encontrado(await this.buscarInterno(id), "Relatório analítico");
  }

  async buscarComoParceiro(parceiro: ParceiroAutenticado, id: string) {
    autorizarEscopo(parceiro, "RELATORIOS_ANALITICOS");
    const relatorio = encontrado(await this.buscarInterno(id), "Relatório analítico");
    if (relatorio.organizacaoId !== parceiro.organizacaoId) encontrado(null, "Relatório analítico");
    return relatorio;
  }

  buscarInterno(id: string) {
    return this.banco.repositorios.analitico.buscarRelatorio(id);
  }

  static paraCsv(relatorio: RelatorioAnaliticoCompleto): string {
    if (relatorio.tipo === "EFICIENCIA_OPERACIONAL") {
      return montarCsv(
        ["relatorioId", "geradoEm", "dimensao", "chave", "lotes", "esperaMediaHoras", "triagemMediaHoras", "totalMediaHoras", "totalMedianaHoras", "totalDesvioHoras", "totalP90Horas"],
        relatorio.indicadoresEficiencia.map(i => [
          relatorio.id, relatorio.geradoEm, i.dimensao, i.chave, i.lotes,
          i.esperaMediaHoras, i.triagemMediaHoras, i.totalMediaHoras, i.totalMedianaHoras, i.totalDesvioHoras, i.totalP90Horas,
        ]),
      );
    }
    if (relatorio.tipo === "RENTABILIDADE") {
      return montarCsv(
        ["relatorioId", "geradoEm", "nivel", "tipoEquipamento", "marca", "modelo", "estadoFisico", "amostras", "valorMedio", "valorMediano", "desvioPadrao", "valorTotal"],
        relatorio.indicadoresRentabilidade.map(i => [
          relatorio.id, relatorio.geradoEm, i.nivel, i.tipoEquipamento, i.marca, i.modelo, i.estadoFisico,
          i.amostras, i.valorMedio, i.valorMediano, i.desvioPadrao, i.valorTotal,
        ]),
      );
    }
    return montarCsv(
      ["relatorioId", "geradoEm", "equipamentoId", "codigoBarrasInterno", "tipo", "marca", "modelo", "anoFabricacao", "estadoFisico", "idadeAtualAnos", "vidaRemanescenteAnos", "dataPrevistaInservivel"],
      relatorio.previsoesVidaUtil.map(p => [
        relatorio.id, relatorio.geradoEm, p.equipamentoId, p.equipamento.codigoBarrasInterno,
        p.equipamento.tipo, p.equipamento.marca, p.equipamento.modelo, p.equipamento.anoFabricacao,
        p.equipamento.estadoFisico, p.idadeAtualAnos, p.vidaRemanescenteAnos, p.dataPrevistaInservivel,
      ]),
    );
  }
}
