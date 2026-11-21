import { EscopoChaveApi, PapelUsuario } from "@prisma/client";
import { ErroAplicacao } from "./erros.js";

export interface UsuarioAutenticado {
  id: string;
  usuario: string;
  papel: PapelUsuario;
}

export interface ParceiroAutenticado {
  id: string;
  parceiro: string;
  prefixo: string;
  organizacaoId: string;
  escopos: EscopoChaveApi[];
  limitePorMinuto: number;
}

/** Ator responsável por uma operação de domínio: usuário interno ou chave de API de parceiro. */
export type AtorAuditoria =
  | { tipo: "USUARIO"; usuario: UsuarioAutenticado }
  | { tipo: "PARCEIRO"; parceiro: ParceiroAutenticado };

export function autorizar(usuario: UsuarioAutenticado, ...papeis: PapelUsuario[]): void {
  if (usuario.papel !== PapelUsuario.ADMINISTRADOR && !papeis.includes(usuario.papel)) {
    throw new ErroAplicacao(403, "ACESSO_NEGADO", "Seu papel não permite esta operação.");
  }
}

export function autorizarConsulta(usuario: UsuarioAutenticado): void {
  autorizar(usuario, ...Object.values(PapelUsuario));
}

export function autorizarEscopo(parceiro: ParceiroAutenticado, ...necessarios: EscopoChaveApi[]): void {
  if (!necessarios.some(escopo => parceiro.escopos.includes(escopo))) {
    throw new ErroAplicacao(403, "ESCOPO_INSUFICIENTE", "A chave de API não possui permissão para esta operação.");
  }
}

export function paraAtor(ator: UsuarioAutenticado | ParceiroAutenticado): AtorAuditoria {
  return "papel" in ator ? { tipo: "USUARIO", usuario: ator } : { tipo: "PARCEIRO", parceiro: ator };
}
