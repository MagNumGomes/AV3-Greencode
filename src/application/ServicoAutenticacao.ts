import { randomBytes } from "node:crypto";
import { EscopoChaveApi, PapelUsuario } from "@prisma/client";
import { autorizar, type ParceiroAutenticado, type UsuarioAutenticado } from "../domain/autorizacao.js";
import type { AlteracaoChaveApi, DadosChaveApi, DadosUsuario, Paginacao } from "../domain/dados.js";
import { conferirVersao, encontrado, ErroAplicacao, exigir } from "../domain/erros.js";
import { dataValida, validarSenha } from "../domain/validacoes.js";
import { BancoDados } from "../infrastructure/BancoDados.js";
import { ChaveApiCripto } from "../infrastructure/ChaveApiCripto.js";
import { Senha } from "../infrastructure/Senha.js";

export interface ClaimsJWT { sub: string; papel: PapelUsuario; tokenVersao: number }

export class ServicoAutenticacao {
  private readonly hashFicticio = Senha.gerar(randomBytes(32).toString("hex"));

  constructor(private readonly banco: BancoDados) {}

  async login(nome: string, senha: string) {
    const usuario = await this.banco.repositorios.usuarios.buscarPorNome(nome.trim().toLowerCase());
    const valida = await Senha.verificar(senha, usuario?.hashSenha ?? await this.hashFicticio);
    if (!usuario?.ativo || !valida) throw new ErroAplicacao(401, "CREDENCIAIS_INVALIDAS", "Usuário ou senha inválidos.");
    const claims: ClaimsJWT = { sub: usuario.id, papel: usuario.papel, tokenVersao: usuario.tokenVersao };
    return { claims, usuario: { id: usuario.id, usuario: usuario.usuario, papel: usuario.papel, versao: usuario.versao } };
  }

  async autenticar(claims: ClaimsJWT): Promise<UsuarioAutenticado> {
    if (typeof claims.sub !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(claims.sub)
      || !Number.isInteger(claims.tokenVersao) || claims.tokenVersao < 1 || !Object.values(PapelUsuario).includes(claims.papel)) {
      throw new ErroAplicacao(401, "TOKEN_INVALIDO", "Token inválido.");
    }
    const usuario = await this.banco.repositorios.usuarios.buscar(claims.sub);
    if (!usuario?.ativo || usuario.tokenVersao !== claims.tokenVersao || usuario.papel !== claims.papel) {
      throw new ErroAplicacao(401, "TOKEN_INVALIDO", "Acesso expirado ou revogado. Autentique-se novamente.");
    }
    return { id: usuario.id, usuario: usuario.usuario, papel: usuario.papel };
  }

  // ---------- AV3: gerenciamento e autenticação de chaves de API ----------

  async autenticarChaveApi(chaveBruta: string | undefined): Promise<ParceiroAutenticado> {
    if (!chaveBruta) {
      throw new ErroAplicacao(401, "CHAVE_API_INVALIDA", "Informe a chave de API no cabeçalho X-API-Key.");
    }
    const prefixo = ChaveApiCripto.extrairPrefixo(chaveBruta);
    if (!prefixo) {
      throw new ErroAplicacao(401, "CHAVE_API_INVALIDA", "Chave de API malformada ou inválida.");
    }
    const registro = await this.banco.repositorios.chavesApi.buscarCompletaPorPrefixo(prefixo);
    if (!registro || !ChaveApiCripto.verificar(chaveBruta, registro.hashSegredo)) {
      throw new ErroAplicacao(401, "CHAVE_API_INVALIDA", "Chave de API inválida.");
    }
    if (!registro.ativa || registro.revogadaEm) {
      throw new ErroAplicacao(401, "CHAVE_API_REVOGADA", "Esta chave de API foi revogada ou desativada.");
    }
    if (registro.expiraEm && registro.expiraEm <= new Date()) {
      throw new ErroAplicacao(401, "CHAVE_API_EXPIRADA", "Esta chave de API expirou.");
    }
    if (!registro.organizacao.ativo) {
      throw new ErroAplicacao(403, "ORGANIZACAO_INATIVA", "A organização vinculada à chave de API está inativa.");
    }
    await this.banco.repositorios.chavesApi.registrarUso(registro.id);
    return {
      id: registro.id, parceiro: registro.parceiro, prefixo: registro.prefixo,
      organizacaoId: registro.organizacaoId, escopos: registro.escopos,
      limitePorMinuto: registro.limitePorMinuto,
    };
  }

  listarChavesApi(ator: UsuarioAutenticado, filtro: Paginacao & { organizacaoId?: string; ativa?: boolean }) {
    autorizar(ator);
    return this.banco.repositorios.chavesApi.listar({
      organizacaoId: filtro.organizacaoId, ativa: filtro.ativa,
    }, filtro);
  }

  async criarChaveApi(ator: UsuarioAutenticado, dados: DadosChaveApi) {
    autorizar(ator);
    const parceiro = dados.parceiro.trim();
    exigir(parceiro.length >= 2, "Informe o nome do parceiro.");
    const escopos = [...new Set(dados.escopos)];
    exigir(escopos.length > 0 && escopos.every(item => Object.values(EscopoChaveApi).includes(item)),
      "Informe ao menos um escopo válido para a chave de API.");
    const limitePorMinuto = dados.limitePorMinuto ?? 60;
    exigir(Number.isInteger(limitePorMinuto) && limitePorMinuto >= 1 && limitePorMinuto <= 10000,
      "O limite por minuto deve estar entre 1 e 10000.");
    const expiraEm = dados.expiraEm ? dataValida(dados.expiraEm) : null;
    exigir(!expiraEm || expiraEm > new Date(), "A data de expiração da chave deve ser futura.");
    const { chave, prefixo, hashSegredo } = ChaveApiCripto.gerar();
    return this.banco.transacao(async repos => {
      const organizacao = encontrado(await repos.organizacoes.buscar(dados.organizacaoId), "Organização");
      exigir(organizacao.ativo, "A organização vinculada à chave deve estar ativa.");
      const criada = await repos.chavesApi.criar({
        parceiro, prefixo, hashSegredo, escopos, organizacaoId: dados.organizacaoId,
        limitePorMinuto, expiraEm, criadoPorId: ator.id,
      });
      await repos.auditoria.registrar(ator, "CRIAR_CHAVE_API", "ChaveApi", criada.id, criada);
      return { ...criada, chave };
    });
  }

  async alterarChaveApi(ator: UsuarioAutenticado, id: string, dados: AlteracaoChaveApi) {
    autorizar(ator);
    exigir(dados.escopos !== undefined || dados.limitePorMinuto !== undefined || dados.ativa !== undefined,
      "Informe escopos, limitePorMinuto ou ativa.");
    const escopos = dados.escopos ? [...new Set(dados.escopos)] : undefined;
    exigir(!escopos || (escopos.length > 0 && escopos.every(item => Object.values(EscopoChaveApi).includes(item))),
      "A chave de API deve manter ao menos um escopo válido.");
    exigir(dados.limitePorMinuto === undefined || (Number.isInteger(dados.limitePorMinuto) && dados.limitePorMinuto >= 1 && dados.limitePorMinuto <= 10000),
      "O limite por minuto deve estar entre 1 e 10000.");
    return this.banco.transacao(async repos => {
      const anterior = encontrado(await repos.chavesApi.buscar(id), "Chave de API");
      conferirVersao(anterior.versao, dados.versao);
      const revogadaEm = dados.ativa === false ? (anterior.revogadaEm ?? new Date()) : dados.ativa === true ? null : undefined;
      const atualizada = await repos.chavesApi.atualizar(id, dados.versao, {
        escopos, limitePorMinuto: dados.limitePorMinuto, ativa: dados.ativa, revogadaEm,
      });
      await repos.auditoria.registrar(ator, dados.ativa === false ? "REVOGAR_CHAVE_API" : "ALTERAR_CHAVE_API", "ChaveApi", id, atualizada, anterior);
      return atualizada;
    });
  }

  // ---------- Gestão de usuários internos (AV2) ----------

  listar(ator: UsuarioAutenticado, filtro: Paginacao) {
    autorizar(ator);
    return this.banco.repositorios.usuarios.listar(filtro);
  }

  async me(ator: UsuarioAutenticado) {
    const usuario = encontrado(await this.banco.repositorios.usuarios.buscar(ator.id), "Usuário");
    return { id: usuario.id, usuario: usuario.usuario, papel: usuario.papel, ativo: usuario.ativo, versao: usuario.versao, criadoEm: usuario.criadoEm };
  }

  async criar(ator: UsuarioAutenticado, dados: DadosUsuario) {
    autorizar(ator);
    validarSenha(dados.senha);
    const usuario = dados.usuario.trim().toLowerCase();
    exigir(/^[a-z0-9._-]{3,60}$/.test(usuario), "Usuário deve ter de 3 a 60 letras, números, pontos, hífens ou sublinhados.");
    const hashSenha = await Senha.gerar(dados.senha);
    return this.banco.transacao(async repos => {
      const criado = await repos.usuarios.criar({ usuario, hashSenha, papel: dados.papel });
      await repos.auditoria.registrar(ator, "CRIAR", "Usuario", criado.id, criado);
      return criado;
    });
  }

  async alterar(ator: UsuarioAutenticado, id: string, dados: { versao: number; papel?: PapelUsuario; ativo?: boolean }) {
    autorizar(ator);
    exigir(id !== ator.id, "Um administrador não pode alterar o próprio papel ou desativar a própria conta.");
    exigir(dados.papel !== undefined || dados.ativo !== undefined, "Informe papel ou ativo.");
    return this.banco.transacao(async repos => {
      const contaAtor = encontrado(await repos.usuarios.buscar(ator.id), "Usuário");
      if (!contaAtor.ativo) throw new ErroAplicacao(401, "TOKEN_INVALIDO", "A conta foi desativada durante a operação.");
      autorizar(contaAtor);
      const anterior = encontrado(await repos.usuarios.buscar(id), "Usuário");
      conferirVersao(anterior.versao, dados.versao);
      if (anterior.ativo && anterior.papel === "ADMINISTRADOR"
        && (dados.ativo === false || (dados.papel !== undefined && dados.papel !== "ADMINISTRADOR"))) {
        exigir(await repos.usuarios.contarAdministradoresAtivos() > 1, "O sistema deve manter ao menos um administrador ativo.");
      }
      const atualizado = await repos.usuarios.atualizar(id, dados.versao, { papel: dados.papel, ativo: dados.ativo });
      await repos.auditoria.registrar(ator, "ALTERAR_ACESSO", "Usuario", id, atualizado, { papel: anterior.papel, ativo: anterior.ativo, versao: anterior.versao });
      return atualizado;
    });
  }

  async alterarSenha(ator: UsuarioAutenticado, dados: { versao: number; senhaAntiga: string; senhaNova: string }) {
    validarSenha(dados.senhaNova);
    const anterior = encontrado(await this.banco.repositorios.usuarios.buscar(ator.id), "Usuário");
    conferirVersao(anterior.versao, dados.versao);
    if (!await Senha.verificar(dados.senhaAntiga, anterior.hashSenha)) {
      throw new ErroAplicacao(401, "CREDENCIAIS_INVALIDAS", "Senha atual inválida.");
    }
    const hashSenha = await Senha.gerar(dados.senhaNova);
    return this.banco.transacao(async repos => {
      const atualizado = await repos.usuarios.atualizar(ator.id, dados.versao, { hashSenha });
      await repos.auditoria.registrar(ator, "ALTERAR_SENHA", "Usuario", ator.id, { versao: atualizado.versao });
      return atualizado;
    });
  }
}
