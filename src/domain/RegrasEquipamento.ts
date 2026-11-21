import { EstadoFisico, StatusLote, StatusRastreamento, TipoEquipamento } from "@prisma/client";
import { exigir } from "./erros.js";

const transicoes: Record<StatusRastreamento, StatusRastreamento[]> = {
  AGUARDANDO_TRIAGEM: [],
  EM_TRIAGEM: [],
  AGUARDANDO_DESMONTE: ["EM_DESMONTE", "PECAS_REAPROVEITADAS", "DESCARTE_SEGURO"],
  EM_DESMONTE: ["PECAS_REAPROVEITADAS", "MATERIAL_RECICLAVEL", "DESCARTE_SEGURO"],
  PECAS_REAPROVEITADAS: ["BAIXA_DEFINITIVA"],
  MATERIAL_RECICLAVEL: ["BAIXA_DEFINITIVA"],
  DESCARTE_SEGURO: ["BAIXA_DEFINITIVA"],
  BAIXA_DEFINITIVA: [],
};

// Valor base de mercado de componentes e matérias-primas secundárias por kg (BRL).
const valorPorQuilo: Record<TipoEquipamento, number> = {
  SERVIDOR: 110,
  NOTEBOOK: 95,
  ROTEADOR: 72,
  COMPUTADOR_MESA: 65,
  MONITOR: 45,
  IMPRESSORA: 38,
  FONTE_ALIMENTACAO: 30,
  CABO_ESTRUTURADO: 24,
};

// Fator de recuperação segundo a condição física dos subconjuntos.
const fatorEstado: Record<EstadoFisico, number> = {
  NOVO: 1.4,
  BOM_ESTADO: 1.2,
  USADO_LEVE: 1.0,
  USADO_MODERADO: 0.78,
  DANIFICADO_LEVE: 0.55,
  DANIFICADO_GRAVE: 0.35,
  INSERVIVEL: 0.18,
};

export const ordemEstadoFisico = [
  EstadoFisico.NOVO,
  EstadoFisico.BOM_ESTADO,
  EstadoFisico.USADO_LEVE,
  EstadoFisico.USADO_MODERADO,
  EstadoFisico.DANIFICADO_LEVE,
  EstadoFisico.DANIFICADO_GRAVE,
  EstadoFisico.INSERVIVEL,
] as const;

export class RegrasEquipamento {
  static validarStatus(atual: StatusRastreamento, novo: StatusRastreamento, lote: StatusLote, justificativa: string): void {
    exigir(lote === "TRIAGEM_CONCLUIDA" || lote === "ENCAMINHADO", "Conclua a triagem do lote antes de destinar o equipamento.");
    exigir(transicoes[atual].includes(novo), `Transição de ${atual} para ${novo} não permitida.`);
    exigir(justificativa.trim(), "A justificativa da mudança de status é obrigatória.");
  }

  static validarEstado(atual: EstadoFisico, novo: EstadoFisico, justificativa?: string): void {
    exigir(atual !== novo, "O equipamento já possui este estado físico.");
    if ( this.indiceEstado(novo) - this.indiceEstado(atual) >= 2) {
      exigir(justificativa?.trim(), "Justifique o rebaixamento de duas ou mais categorias do estado físico.");
    }
  }

  static indiceEstado(estado: EstadoFisico): number {
    return ordemEstadoFisico.indexOf(estado);
  }

  static calcularDepreciacao(anoFabricacao: number, estado: EstadoFisico, anoAtual = new Date().getUTCFullYear()): number {
    const penalidade: Record<EstadoFisico, number> = {
      NOVO: 0, BOM_ESTADO: 10, USADO_LEVE: 20, USADO_MODERADO: 40,
      DANIFICADO_LEVE: 60, DANIFICADO_GRAVE: 80, INSERVIVEL: 100,
    };
    return Math.min(100, Math.max(0, anoAtual - anoFabricacao) * 10 + penalidade[estado]);
  }

  /**
   * Estima o valor de recuperação de materiais (BRL) quando o equipamento ainda não teve
   * apuração financeira registrada na destinação.
   */
  static estimarValorRecuperacao(tipo: TipoEquipamento, estado: EstadoFisico, pesoQuilogramas: number, anoFabricacao: number, anoAtual = new Date().getUTCFullYear()): number {
    const idade = Math.max(0, anoAtual - anoFabricacao);
    const fatorIdade = Math.max(0.45, 1 - idade * 0.045);
    const bruto = pesoQuilogramas * valorPorQuilo[tipo] * fatorEstado[estado] * fatorIdade;
    return Math.round(bruto * 100) / 100;
  }
}
