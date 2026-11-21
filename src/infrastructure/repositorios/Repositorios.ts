import { Prisma, type TipoAnalise } from "@prisma/client";
import type { AtorAuditoria, UsuarioAutenticado } from "../../domain/autorizacao.js";
import type { Paginacao } from "../../domain/dados.js";
import { conflitoVersao } from "../../domain/erros.js";

type Conexao = Prisma.TransactionClient;

export const usuarioPublico = {
  id: true, usuario: true, papel: true, ativo: true, versao: true, criadoEm: true,
} satisfies Prisma.UsuarioSelect;

export const chaveApiPublica = {
  id: true, parceiro: true, prefixo: true, escopos: true, organizacaoId: true,
  limitePorMinuto: true, ativa: true, expiraEm: true, ultimoUsoEm: true,
  revogadaEm: true, criadoEm: true, criadoPorId: true, versao: true,
} satisfies Prisma.ChaveApiSelect;

function paginar(filtro: Paginacao) {
  const pagina = filtro.pagina ?? 1;
  const limite = filtro.limite ?? 20;
  return { skip: (pagina - 1) * limite, take: limite };
}

function resultadoPagina<T>(dados: T[], total: number, filtro: Paginacao) {
  return { dados, total, pagina: filtro.pagina ?? 1, limite: filtro.limite ?? 20 };
}

function normalizarAtor(ator: UsuarioAutenticado | AtorAuditoria): AtorAuditoria {
  return "tipo" in ator ? ator : { tipo: "USUARIO", usuario: ator };
}

export class RepositorioUsuario {
  constructor(private readonly db: Conexao) {}
  buscar(id: string) { return this.db.usuario.findUnique({ where: { id } }); }
  buscarPorNome(usuario: string) { return this.db.usuario.findUnique({ where: { usuario } }); }
  contarAdministradoresAtivos() { return this.db.usuario.count({ where: { ativo: true, papel: "ADMINISTRADOR" } }); }
  criar(data: Prisma.UsuarioCreateInput) {
    return this.db.usuario.create({ data, select: usuarioPublico });
  }
  async listar(filtro: Paginacao) {
    const [dados, total] = await Promise.all([
      this.db.usuario.findMany({ ...paginar(filtro), select: usuarioPublico, orderBy: { usuario: "asc" } }),
      this.db.usuario.count(),
    ]);
    return resultadoPagina(dados, total, filtro);
  }
  async atualizar(id: string, versao: number, data: Prisma.UsuarioUpdateManyMutationInput) {
    const resultado = await this.db.usuario.updateMany({
      where: { id, versao }, data: { ...data, versao: { increment: 1 }, tokenVersao: { increment: 1 } },
    });
    if (resultado.count !== 1) conflitoVersao();
    return this.db.usuario.findUniqueOrThrow({ where: { id }, select: usuarioPublico });
  }
}

export class RepositorioChaveApi {
  constructor(private readonly db: Conexao) {}
  buscar(id: string) { return this.db.chaveApi.findUnique({ where: { id }, select: chaveApiPublica }); }
  buscarCompletaPorPrefixo(prefixo: string) {
    return this.db.chaveApi.findUnique({ where: { prefixo }, include: { organizacao: true } });
  }
  criar(data: Prisma.ChaveApiUncheckedCreateInput) {
    return this.db.chaveApi.create({ data, select: chaveApiPublica });
  }
  async listar(where: Prisma.ChaveApiWhereInput, filtro: Paginacao) {
    const [dados, total] = await Promise.all([
      this.db.chaveApi.findMany({ where, ...paginar(filtro), select: chaveApiPublica, orderBy: [{ criadoEm: "desc" }, { id: "asc" }] }),
      this.db.chaveApi.count({ where }),
    ]);
    return resultadoPagina(dados, total, filtro);
  }
  async atualizar(id: string, versao: number, data: Prisma.ChaveApiUpdateInput) {
    const resultado = await this.db.chaveApi.updateMany({ where: { id, versao }, data: { ...data, versao: { increment: 1 } } });
    if (resultado.count !== 1) conflitoVersao();
    return this.db.chaveApi.findUniqueOrThrow({ where: { id }, select: chaveApiPublica });
  }
  registrarUso(id: string, dataHora = new Date()) {
    return this.db.chaveApi.updateMany({ where: { id }, data: { ultimoUsoEm: dataHora } });
  }
}

export class RepositorioOrganizacao {
  constructor(private readonly db: Conexao) {}
  buscar(id: string) { return this.db.organizacao.findUnique({ where: { id }, include: { contrato: true } }); }
  criar(data: Prisma.OrganizacaoCreateInput) { return this.db.organizacao.create({ data, include: { contrato: true } }); }
  async listar(filtro: Paginacao & { ativo?: boolean }) {
    const where = { ativo: filtro.ativo };
    const [dados, total] = await Promise.all([
      this.db.organizacao.findMany({ where, ...paginar(filtro), include: { contrato: true }, orderBy: [{ dataCadastro: "desc" }, { id: "asc" }] }),
      this.db.organizacao.count({ where }),
    ]);
    return resultadoPagina(dados, total, filtro);
  }
  async atualizar(id: string, versao: number, data: Prisma.OrganizacaoUpdateManyMutationInput) {
    const resultado = await this.db.organizacao.updateMany({ where: { id, versao }, data: { ...data, versao: { increment: 1 } } });
    if (resultado.count !== 1) conflitoVersao();
    return this.db.organizacao.findUniqueOrThrow({ where: { id }, include: { contrato: true } });
  }
}

export class RepositorioContrato {
  constructor(private readonly db: Conexao) {}
  buscar(id: string) { return this.db.contrato.findUnique({ where: { id } }); }
  criar(data: Prisma.ContratoUncheckedCreateInput) { return this.db.contrato.create({ data }); }
  async renovar(id: string, versao: number, dataVencimento: Date) {
    const resultado = await this.db.contrato.updateMany({ where: { id, versao }, data: { dataVencimento, versao: { increment: 1 } } });
    if (resultado.count !== 1) conflitoVersao();
    return this.db.contrato.findUniqueOrThrow({ where: { id } });
  }
  listarVigentesNoPeriodo(inicio: Date, fim: Date) {
    return this.db.contrato.findMany({ where: { dataAssinatura: { lte: fim }, dataVencimento: { gte: inicio } }, orderBy: { id: "asc" } });
  }
}

export class RepositorioLote {
  constructor(private readonly db: Conexao) {}
  buscar(id: string) {
    return this.db.lote.findUnique({ where: { id }, include: { equipamentos: { orderBy: { posicaoNoLote: "asc" } } } });
  }
  criar(data: Prisma.LoteUncheckedCreateInput) { return this.db.lote.create({ data }); }
  async listar(where: Prisma.LoteWhereInput, filtro: Paginacao) {
    const [dados, total] = await Promise.all([
      this.db.lote.findMany({ where, ...paginar(filtro), orderBy: [{ dataEntrada: "desc" }, { id: "asc" }] }),
      this.db.lote.count({ where }),
    ]);
    return resultadoPagina(dados, total, filtro);
  }
  async atualizar(id: string, versao: number, data: Prisma.LoteUpdateManyMutationInput) {
    const resultado = await this.db.lote.updateMany({ where: { id, versao }, data: { ...data, versao: { increment: 1 } } });
    if (resultado.count !== 1) conflitoVersao();
    return this.db.lote.findUniqueOrThrow({ where: { id } });
  }
  listarParaRelatorio(organizacaoId: string, periodo: Prisma.DateTimeFilter) {
    return this.db.lote.findMany({ where: { organizacaoId, dataEntrada: periodo }, include: { equipamentos: true }, orderBy: { dataEntrada: "asc" } });
  }
  listarComMovimentacoes(where: Prisma.LoteWhereInput) {
    return this.db.lote.findMany({
      where,
      include: { equipamentos: { include: { historicoMovimentacao: { orderBy: { sequencia: "asc" } } } } },
      orderBy: [{ dataEntrada: "asc" }, { id: "asc" }],
    });
  }
}

export class RepositorioEquipamento {
  constructor(private readonly db: Conexao) {}
  buscar(id: string) {
    return this.db.equipamento.findUnique({
      where: { id },
      include: { lote: true, historicoMovimentacao: { orderBy: { sequencia: "asc" } } },
    });
  }
  buscarPorCodigo(codigoBarrasInterno: string) {
    return this.db.equipamento.findUnique({
      where: { codigoBarrasInterno },
      include: { lote: true, historicoMovimentacao: { orderBy: { sequencia: "asc" } } },
    });
  }
  criar(data: Prisma.EquipamentoUncheckedCreateInput) { return this.db.equipamento.create({ data }); }
  async listar(where: Prisma.EquipamentoWhereInput, filtro: Paginacao) {
    const [dados, total] = await Promise.all([
      this.db.equipamento.findMany({ where, ...paginar(filtro), orderBy: { codigoBarrasInterno: "asc" } }),
      this.db.equipamento.count({ where }),
    ]);
    return resultadoPagina(dados, total, filtro);
  }
  listarParaAnalise(where: Prisma.EquipamentoWhereInput) {
    return this.db.equipamento.findMany({
      where,
      include: { lote: true, historicoMovimentacao: { orderBy: { sequencia: "asc" } } },
      orderBy: [{ tipo: "asc" }, { anoFabricacao: "asc" }, { id: "asc" }],
    });
  }
  async atualizar(id: string, versao: number, data: Prisma.EquipamentoUpdateManyMutationInput) {
    const resultado = await this.db.equipamento.updateMany({ where: { id, versao }, data: { ...data, versao: { increment: 1 } } });
    if (resultado.count !== 1) conflitoVersao();
    return this.db.equipamento.findUniqueOrThrow({ where: { id } });
  }
  registrarMovimentacao(data: Prisma.MovimentacaoUncheckedCreateInput) {
    return this.db.movimentacao.create({ data });
  }
}

function json(dados: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(dados)) as Prisma.InputJsonValue;
}

export class RepositorioAuditoria {
  constructor(private readonly db: Conexao) {}
  registrar(ator: UsuarioAutenticado | AtorAuditoria, operacao: string, entidade: string, entidadeId: string, dadosDepois: unknown, dadosAntes?: unknown) {
    const normalizado = normalizarAtor(ator);
    return this.db.auditoria.create({ data: {
      usuarioResponsavelId: normalizado.tipo === "USUARIO" ? normalizado.usuario.id : null,
      chaveApiId: normalizado.tipo === "PARCEIRO" ? normalizado.parceiro.id : null,
      operacao, entidade, entidadeId,
      dadosDepois: json(dadosDepois), dadosAntes: dadosAntes === undefined ? Prisma.DbNull : json(dadosAntes),
    } });
  }
  async listar(filtro: Paginacao & { entidade?: string; entidadeId?: string }) {
    const where = { entidade: filtro.entidade, entidadeId: filtro.entidadeId };
    const [dados, total] = await Promise.all([
      this.db.auditoria.findMany({ where, ...paginar(filtro), orderBy: [{ dataHora: "desc" }, { id: "asc" }] }),
      this.db.auditoria.count({ where }),
    ]);
    return resultadoPagina(dados, total, filtro);
  }
}

const incluirDetalhesAnaliticos = {
  indicadoresEficiencia: { orderBy: [{ dimensao: "asc" }, { chave: "asc" }] },
  indicadoresRentabilidade: { orderBy: [{ nivel: "asc" }, { valorMedio: "desc" }, { tipoEquipamento: "asc" }] },
  modelosVidaUtil: { orderBy: { tipoEquipamento: "asc" } },
  previsoesVidaUtil: {
    include: { equipamento: { select: { codigoBarrasInterno: true, tipo: true, marca: true, modelo: true, anoFabricacao: true, estadoFisico: true } } },
    orderBy: [{ vidaRemanescenteAnos: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.RelatorioAnaliticoInclude;

export class RepositorioAnalitico {
  constructor(private readonly db: Conexao) {}
  criarRelatorio(data: Prisma.RelatorioAnaliticoUncheckedCreateInput) {
    return this.db.relatorioAnalitico.create({ data, include: incluirDetalhesAnaliticos });
  }
  criarModeloVidaUtil(data: Prisma.ModeloVidaUtilUncheckedCreateInput) {
    return this.db.modeloVidaUtil.create({ data });
  }
  buscarRelatorio(id: string) {
    return this.db.relatorioAnalitico.findUnique({ where: { id }, include: incluirDetalhesAnaliticos });
  }
  buscarUltimoRelatorio(tipo: TipoAnalise, organizacaoId?: string | null) {
    return this.db.relatorioAnalitico.findFirst({
      where: { tipo, organizacaoId: organizacaoId === undefined ? undefined : organizacaoId },
      include: incluirDetalhesAnaliticos,
      orderBy: [{ geradoEm: "desc" }, { id: "asc" }],
    });
  }
  async listarRelatorios(where: Prisma.RelatorioAnaliticoWhereInput, filtro: Paginacao) {
    const [dados, total] = await Promise.all([
      this.db.relatorioAnalitico.findMany({ where, ...paginar(filtro), orderBy: [{ geradoEm: "desc" }, { id: "asc" }] }),
      this.db.relatorioAnalitico.count({ where }),
    ]);
    return resultadoPagina(dados, total, filtro);
  }
  criarTarefa(data: Prisma.TarefaAnaliticaUncheckedCreateInput) {
    return this.db.tarefaAnalitica.create({ data });
  }
  buscarTarefa(id: string) {
    return this.db.tarefaAnalitica.findUnique({ where: { id } });
  }
  atualizarTarefa(id: string, data: Prisma.TarefaAnaliticaUncheckedUpdateInput) {
    return this.db.tarefaAnalitica.update({ where: { id }, data });
  }
  async listarTarefas(where: Prisma.TarefaAnaliticaWhereInput, filtro: Paginacao) {
    const [dados, total] = await Promise.all([
      this.db.tarefaAnalitica.findMany({ where, ...paginar(filtro), orderBy: [{ criadaEm: "desc" }, { id: "asc" }] }),
      this.db.tarefaAnalitica.count({ where }),
    ]);
    return resultadoPagina(dados, total, filtro);
  }
}

export class Repositorios {
  readonly usuarios: RepositorioUsuario;
  readonly chavesApi: RepositorioChaveApi;
  readonly organizacoes: RepositorioOrganizacao;
  readonly contratos: RepositorioContrato;
  readonly lotes: RepositorioLote;
  readonly equipamentos: RepositorioEquipamento;
  readonly auditoria: RepositorioAuditoria;
  readonly analitico: RepositorioAnalitico;

  constructor(db: Conexao) {
    this.usuarios = new RepositorioUsuario(db);
    this.chavesApi = new RepositorioChaveApi(db);
    this.organizacoes = new RepositorioOrganizacao(db);
    this.contratos = new RepositorioContrato(db);
    this.lotes = new RepositorioLote(db);
    this.equipamentos = new RepositorioEquipamento(db);
    this.auditoria = new RepositorioAuditoria(db);
    this.analitico = new RepositorioAnalitico(db);
  }
}
