import {
  autorizar, autorizarEscopo, paraAtor,
  type AtorAuditoria, type ParceiroAutenticado, type UsuarioAutenticado,
} from "../domain/autorizacao.js";
import type { FiltroTarefas, SolicitacaoTarefa } from "../domain/dados.js";
import { encontrado, ErroAplicacao } from "../domain/erros.js";
import { validarPeriodo } from "../domain/validacoes.js";
import { BancoDados } from "../infrastructure/BancoDados.js";
import type { FilaAnalitica } from "../infrastructure/FilaAnalitica.js";
import { ServicoAnalitico } from "./analitico/ServicosAnaliticos.js";

export class ServicoTarefaAnalitica {
  constructor(
    private readonly banco: BancoDados,
    private readonly fila: FilaAnalitica,
    private readonly analitico: ServicoAnalitico,
  ) {}

  solicitarComoUsuario(ator: UsuarioAutenticado, dados: SolicitacaoTarefa) {
    autorizar(ator, "AUDITOR");
    return this.solicitarInterno(paraAtor(ator), dados);
  }

  solicitarComoParceiro(parceiro: ParceiroAutenticado, dados: Omit<SolicitacaoTarefa, "organizacaoId">) {
    autorizarEscopo(parceiro, "RELATORIOS_ANALITICOS");
    return this.solicitarInterno(paraAtor(parceiro), { ...dados, organizacaoId: parceiro.organizacaoId });
  }

  private async solicitarInterno(ator: AtorAuditoria, dados: SolicitacaoTarefa) {
    validarPeriodo(dados.inicio, dados.fim);
    const formato = dados.formato ?? "JSON";
    const tarefa = await this.banco.transacao(async repos => {
      if (dados.organizacaoId) encontrado(await repos.organizacoes.buscar(dados.organizacaoId), "Organização");
      const criada = await repos.analitico.criarTarefa({
        tipo: dados.tipo, formato,
        organizacaoId: dados.organizacaoId ?? null,
        solicitanteUsuarioId: ator.tipo === "USUARIO" ? ator.usuario.id : null,
        solicitanteChaveApiId: ator.tipo === "PARCEIRO" ? ator.parceiro.id : null,
      });
      await repos.auditoria.registrar(ator, "ENFILEIRAR_RELATORIO_ANALITICO", "TarefaAnalitica", criada.id, {
        tipo: criada.tipo, formato: criada.formato, organizacaoId: criada.organizacaoId,
      });
      return criada;
    });

    await this.fila.enfileirarRelatorio({
      tarefaId: tarefa.id,
      tipo: dados.tipo,
      filtro: { organizacaoId: dados.organizacaoId, inicio: dados.inicio, fim: dados.fim },
      origem: ator.tipo === "USUARIO" ? "API_INTERNA" : "API_PUBLICA",
      ator,
    });
    return tarefa;
  }

  listarComoUsuario(ator: UsuarioAutenticado, filtro: FiltroTarefas) {
    autorizar(ator, "AUDITOR");
    return this.banco.repositorios.analitico.listarTarefas({ status: filtro.status, tipo: filtro.tipo }, filtro);
  }

  listarComoParceiro(parceiro: ParceiroAutenticado, filtro: FiltroTarefas) {
    autorizarEscopo(parceiro, "RELATORIOS_ANALITICOS");
    return this.banco.repositorios.analitico.listarTarefas({
      status: filtro.status, tipo: filtro.tipo, organizacaoId: parceiro.organizacaoId,
    }, filtro);
  }

  async consultarStatusComoUsuario(ator: UsuarioAutenticado, id: string) {
    autorizar(ator, "AUDITOR");
    return encontrado(await this.banco.repositorios.analitico.buscarTarefa(id), "Tarefa analítica");
  }

  async consultarStatusComoParceiro(parceiro: ParceiroAutenticado, id: string) {
    autorizarEscopo(parceiro, "RELATORIOS_ANALITICOS");
    const tarefa = encontrado(await this.banco.repositorios.analitico.buscarTarefa(id), "Tarefa analítica");
    if (tarefa.organizacaoId !== parceiro.organizacaoId) encontrado(null, "Tarefa analítica");
    return tarefa;
  }

  async baixarComoUsuario(ator: UsuarioAutenticado, id: string) {
    const tarefa = await this.consultarStatusComoUsuario(ator, id);
    return this.montarDownload(tarefa);
  }

  async baixarComoParceiro(parceiro: ParceiroAutenticado, id: string) {
    const tarefa = await this.consultarStatusComoParceiro(parceiro, id);
    return this.montarDownload(tarefa);
  }

  private async montarDownload(tarefa: Awaited<ReturnType<ServicoTarefaAnalitica["consultarStatusComoUsuario"]>>) {
    if (tarefa.status === "FALHOU") {
      throw new ErroAplicacao(422, "TAREFA_FALHOU", `A geração do relatório falhou: ${tarefa.ultimoErro ?? "erro não especificado"}.`);
    }
    if (tarefa.status !== "CONCLUIDA" || !tarefa.relatorioId) {
      throw new ErroAplicacao(409, "TAREFA_EM_PROCESSAMENTO", "O relatório ainda está em processamento. Consulte o endpoint de status antes do download.");
    }
    const relatorio = encontrado(await this.analitico.buscarInterno(tarefa.relatorioId), "Relatório analítico");
    const prefixo = `relatorio-${tarefa.tipo.toLowerCase()}-${tarefa.id}`;
    if (tarefa.formato === "CSV") {
      return {
        formato: "CSV" as const,
        contentType: "text/csv; charset=utf-8",
        nomeArquivo: `${prefixo}.csv`,
        conteudo: ServicoAnalitico.paraCsv(relatorio),
      };
    }
    return {
      formato: "JSON" as const,
      contentType: "application/json; charset=utf-8",
      nomeArquivo: `${prefixo}.json`,
      conteudo: relatorio,
    };
  }
}
