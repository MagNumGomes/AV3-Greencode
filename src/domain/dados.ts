import type {
  EscopoChaveApi, EstadoFisico, FormatoRelatorio, NivelRentabilidade, PapelUsuario,
  StatusLote, StatusRastreamento, StatusTarefa, TipoAnalise, TipoEquipamento,
} from "@prisma/client";

export interface Paginacao { pagina?: number; limite?: number }
export interface Periodo { inicio?: string; fim?: string }
export interface DadosContrato {
  dataAssinatura: string;
  dataVencimento: string;
  clausulas: string[];
  valorMensal: string;
  renovacaoAutomatica?: boolean;
}
export interface DadosOrganizacao {
  razaoSocial: string;
  cnpj: string;
  inscricaoEstadual?: string;
  enderecoCompleto: string;
  telefone: string;
  email: string;
  contrato?: DadosContrato;
}
export type AlteracaoOrganizacao = Partial<Omit<DadosOrganizacao, "contrato" | "cnpj">> & { versao: number; ativo?: boolean };
export interface DadosEquipamento {
  codigoBarrasInterno?: string;
  tipo: TipoEquipamento;
  marca: string;
  modelo: string;
  anoFabricacao: number;
  estadoFisico: EstadoFisico;
  pesoQuilogramas: string;
  valorRecuperado?: string;
}
export interface DadosLote {
  organizacaoId: string;
  dataEntrada: string;
  notaFiscal: string;
  transportadora: string;
  observacoes?: string;
  equipamentos?: DadosEquipamento[];
}
export type DadosLoteParceiro = Omit<DadosLote, "organizacaoId">;
export interface FiltroLotes extends Paginacao, Periodo { organizacaoId?: string; status?: StatusLote }
export interface FiltroEquipamentos extends Paginacao { loteId?: string; status?: StatusRastreamento; codigoBarrasInterno?: string }
export interface DadosUsuario { usuario: string; senha: string; papel: PapelUsuario }

// ---------- AV3: chaves de API, análises e tarefas ----------

export interface DadosChaveApi {
  parceiro: string;
  organizacaoId: string;
  escopos: EscopoChaveApi[];
  limitePorMinuto?: number;
  expiraEm?: string;
}

export interface AlteracaoChaveApi {
  versao: number;
  escopos?: EscopoChaveApi[];
  limitePorMinuto?: number;
  ativa?: boolean;
}

export interface FiltroAnalise extends Periodo {
  organizacaoId?: string;
}

export interface FiltroRentabilidade extends FiltroAnalise {
  nivel?: NivelRentabilidade;
  tipo?: TipoEquipamento;
}

export interface FiltroHistoricoAnalises extends Paginacao, Periodo {
  tipo?: TipoAnalise;
  organizacaoId?: string;
}

export interface SolicitacaoTarefa {
  tipo: TipoAnalise;
  formato?: FormatoRelatorio;
  organizacaoId?: string;
  inicio?: string;
  fim?: string;
}

export interface FiltroTarefas extends Paginacao {
  status?: StatusTarefa;
  tipo?: TipoAnalise;
}
