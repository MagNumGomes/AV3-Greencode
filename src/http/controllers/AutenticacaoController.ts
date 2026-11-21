import type { FastifyInstance } from "fastify";
import type { ServicoAutenticacao } from "../../application/ServicoAutenticacao.js";
import * as S from "../schemas.js";
import type { ComId, Consulta, Corpo } from "../tipos.js";

export function registrarLogin(app: FastifyInstance, servico: ServicoAutenticacao, expiraEm: string, loginPorMinuto = 10, prefixo = "/api") {
  app.post<Corpo<typeof S.LoginEntrada>>(`${prefixo}/auth/login`, {
    config: { rateLimit: { max: loginPorMinuto, timeWindow: 60000 } },
    schema: { ...S.documentar("Autenticação", "Autenticar e emitir JWT", S.LoginResposta, 200, true), body: S.LoginEntrada },
  }, async request => {
    const { claims, usuario } = await servico.login(request.body.usuario, request.body.senha);
    return { token: app.jwt.sign(claims), tipo: "Bearer", expiraEm, usuario };
  });
}

export function registrarAutenticacao(app: FastifyInstance, servico: ServicoAutenticacao) {
  app.get("/auth/me", { schema: S.documentar("Autenticação", "Consultar usuário autenticado", S.UsuarioResposta) }, request => servico.me(request.ator));

  app.patch<Corpo<typeof S.SenhaAlteracao>>("/auth/senha", {
    schema: { ...S.documentar("Autenticação", "Alterar senha e revogar os tokens anteriores", S.UsuarioResposta), body: S.SenhaAlteracao },
  }, request => servico.alterarSenha(request.ator, request.body));

  app.get<Consulta<typeof S.Paginacao>>("/usuarios", {
    schema: { ...S.documentar("Usuários", "Listar usuários (administrador)", S.paginaDe(S.UsuarioResposta)), querystring: S.Paginacao },
  }, request => servico.listar(request.ator, request.query));

  app.post<Corpo<typeof S.UsuarioEntrada>>("/usuarios", {
    schema: { ...S.documentar("Usuários", "Criar usuário (administrador)", S.UsuarioResposta, 201), body: S.UsuarioEntrada },
  }, async (request, reply) => reply.code(201).send(await servico.criar(request.ator, request.body)));

  app.patch<ComId & Corpo<typeof S.UsuarioAlteracao>>("/usuarios/:id", {
    schema: { ...S.documentar("Usuários", "Alterar papel/ativação e revogar tokens (administrador)", S.UsuarioResposta), params: S.IdParams, body: S.UsuarioAlteracao },
  }, request => servico.alterar(request.ator, request.params.id, request.body));

  // ---------- AV3: gerenciamento administrativo de chaves de API ----------

  app.get<Consulta<typeof S.ChaveApiFiltro>>("/chaves-api", {
    schema: { ...S.documentar("Chaves de API", "Listar chaves de API de parceiros (administrador)", S.paginaDe(S.ChaveApiResposta)), querystring: S.ChaveApiFiltro },
  }, request => servico.listarChavesApi(request.ator, request.query));

  app.post<Corpo<typeof S.ChaveApiEntrada>>("/chaves-api", {
    schema: { ...S.documentar("Chaves de API", "Emitir nova chave de API única para parceiro (administrador)", S.ChaveApiCriadaResposta, 201), body: S.ChaveApiEntrada },
  }, async (request, reply) => reply.code(201).send(await servico.criarChaveApi(request.ator, request.body)));

  app.patch<ComId & Corpo<typeof S.ChaveApiAlteracao>>("/chaves-api/:id", {
    schema: { ...S.documentar("Chaves de API", "Atualizar escopos, limite de taxa ou revogar chave de API (administrador)", S.ChaveApiResposta), params: S.IdParams, body: S.ChaveApiAlteracao },
  }, request => servico.alterarChaveApi(request.ator, request.params.id, request.body));
}
