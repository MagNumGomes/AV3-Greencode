-- CreateEnum
CREATE TYPE "EscopoChaveApi" AS ENUM ('RASTREABILIDADE_LEITURA', 'LOTES_LEITURA', 'LOTES_ESCRITA', 'RELATORIOS_ANALITICOS');

-- CreateEnum
CREATE TYPE "TipoAnalise" AS ENUM ('EFICIENCIA_OPERACIONAL', 'RENTABILIDADE', 'VIDA_UTIL');

-- CreateEnum
CREATE TYPE "OrigemAnalise" AS ENUM ('AGENDADA', 'API_INTERNA', 'API_PUBLICA');

-- CreateEnum
CREATE TYPE "DimensaoEficiencia" AS ENUM ('GERAL', 'OPERADOR', 'MES');

-- CreateEnum
CREATE TYPE "NivelRentabilidade" AS ENUM ('TIPO', 'TIPO_ESTADO', 'TIPO_MARCA_MODELO', 'TIPO_MARCA_MODELO_ESTADO');

-- CreateEnum
CREATE TYPE "StatusTarefa" AS ENUM ('PENDENTE', 'PROCESSANDO', 'CONCLUIDA', 'FALHOU');

-- CreateEnum
CREATE TYPE "FormatoRelatorio" AS ENUM ('JSON', 'CSV');

-- AlterTable
ALTER TABLE "Auditoria" ADD COLUMN "chaveApiId" UUID,
ALTER COLUMN "usuarioResponsavelId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Equipamento" ADD COLUMN "valorRecuperado" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "Movimentacao" ADD COLUMN "chaveApiId" UUID,
ALTER COLUMN "responsavelId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ChaveApi" (
    "id" UUID NOT NULL,
    "parceiro" VARCHAR(200) NOT NULL,
    "prefixo" VARCHAR(16) NOT NULL,
    "hashSegredo" CHAR(64) NOT NULL,
    "escopos" "EscopoChaveApi"[],
    "organizacaoId" UUID NOT NULL,
    "limitePorMinuto" INTEGER NOT NULL DEFAULT 60,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "expiraEm" TIMESTAMPTZ(3),
    "ultimoUsoEm" TIMESTAMPTZ(3),
    "revogadaEm" TIMESTAMPTZ(3),
    "criadoEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criadoPorId" UUID NOT NULL,
    "versao" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ChaveApi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelatorioAnalitico" (
    "id" UUID NOT NULL,
    "tipo" "TipoAnalise" NOT NULL,
    "origem" "OrigemAnalise" NOT NULL,
    "organizacaoId" UUID,
    "parametros" JSONB NOT NULL,
    "resumo" JSONB NOT NULL,
    "versaoModelo" VARCHAR(20) NOT NULL,
    "amostras" INTEGER NOT NULL,
    "duracaoMs" INTEGER NOT NULL,
    "geradoEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "solicitanteUsuarioId" UUID,
    "solicitanteChaveApiId" UUID,

    CONSTRAINT "RelatorioAnalitico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndicadorEficiencia" (
    "id" UUID NOT NULL,
    "relatorioId" UUID NOT NULL,
    "dimensao" "DimensaoEficiencia" NOT NULL,
    "chave" VARCHAR(100) NOT NULL,
    "lotes" INTEGER NOT NULL,
    "esperaMediaHoras" DOUBLE PRECISION NOT NULL,
    "triagemMediaHoras" DOUBLE PRECISION NOT NULL,
    "totalMediaHoras" DOUBLE PRECISION NOT NULL,
    "totalMedianaHoras" DOUBLE PRECISION NOT NULL,
    "totalDesvioHoras" DOUBLE PRECISION NOT NULL,
    "totalP90Horas" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "IndicadorEficiencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndicadorRentabilidade" (
    "id" UUID NOT NULL,
    "relatorioId" UUID NOT NULL,
    "nivel" "NivelRentabilidade" NOT NULL,
    "tipoEquipamento" "TipoEquipamento" NOT NULL,
    "marca" VARCHAR(100),
    "modelo" VARCHAR(100),
    "estadoFisico" "EstadoFisico",
    "amostras" INTEGER NOT NULL,
    "valorMedio" DECIMAL(14,2) NOT NULL,
    "valorMediano" DECIMAL(14,2) NOT NULL,
    "desvioPadrao" DECIMAL(14,2) NOT NULL,
    "valorTotal" DECIMAL(16,2) NOT NULL,

    CONSTRAINT "IndicadorRentabilidade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModeloVidaUtil" (
    "id" UUID NOT NULL,
    "relatorioId" UUID NOT NULL,
    "tipoEquipamento" "TipoEquipamento" NOT NULL,
    "amostras" INTEGER NOT NULL,
    "intercepto" DOUBLE PRECISION,
    "inclinacao" DOUBLE PRECISION,
    "r2" DOUBLE PRECISION,
    "idadeInservivelAnos" DOUBLE PRECISION,
    "confiavel" BOOLEAN NOT NULL,
    "observacao" VARCHAR(300) NOT NULL,

    CONSTRAINT "ModeloVidaUtil_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrevisaoVidaUtil" (
    "id" UUID NOT NULL,
    "relatorioId" UUID NOT NULL,
    "modeloId" UUID NOT NULL,
    "equipamentoId" UUID NOT NULL,
    "idadeAtualAnos" DOUBLE PRECISION NOT NULL,
    "vidaRemanescenteAnos" DOUBLE PRECISION NOT NULL,
    "dataPrevistaInservivel" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PrevisaoVidaUtil_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TarefaAnalitica" (
    "id" UUID NOT NULL,
    "tipo" "TipoAnalise" NOT NULL,
    "formato" "FormatoRelatorio" NOT NULL,
    "status" "StatusTarefa" NOT NULL DEFAULT 'PENDENTE',
    "organizacaoId" UUID,
    "solicitanteUsuarioId" UUID,
    "solicitanteChaveApiId" UUID,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "ultimoErro" VARCHAR(1000),
    "relatorioId" UUID,
    "criadaEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "iniciadaEm" TIMESTAMPTZ(3),
    "concluidaEm" TIMESTAMPTZ(3),

    CONSTRAINT "TarefaAnalitica_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChaveApi_prefixo_key" ON "ChaveApi"("prefixo");

-- CreateIndex
CREATE INDEX "ChaveApi_organizacaoId_idx" ON "ChaveApi"("organizacaoId");

-- CreateIndex
CREATE INDEX "RelatorioAnalitico_tipo_organizacaoId_geradoEm_idx" ON "RelatorioAnalitico"("tipo", "organizacaoId", "geradoEm");

-- CreateIndex
CREATE INDEX "RelatorioAnalitico_geradoEm_idx" ON "RelatorioAnalitico"("geradoEm");

-- CreateIndex
CREATE UNIQUE INDEX "IndicadorEficiencia_relatorioId_dimensao_chave_key" ON "IndicadorEficiencia"("relatorioId", "dimensao", "chave");

-- CreateIndex
CREATE INDEX "IndicadorRentabilidade_relatorioId_nivel_valorMedio_idx" ON "IndicadorRentabilidade"("relatorioId", "nivel", "valorMedio");

-- CreateIndex
CREATE UNIQUE INDEX "ModeloVidaUtil_relatorioId_tipoEquipamento_key" ON "ModeloVidaUtil"("relatorioId", "tipoEquipamento");

-- CreateIndex
CREATE INDEX "PrevisaoVidaUtil_equipamentoId_dataPrevistaInservivel_idx" ON "PrevisaoVidaUtil"("equipamentoId", "dataPrevistaInservivel");

-- CreateIndex
CREATE UNIQUE INDEX "PrevisaoVidaUtil_relatorioId_equipamentoId_key" ON "PrevisaoVidaUtil"("relatorioId", "equipamentoId");

-- CreateIndex
CREATE INDEX "TarefaAnalitica_status_criadaEm_idx" ON "TarefaAnalitica"("status", "criadaEm");

-- CreateIndex
CREATE INDEX "TarefaAnalitica_solicitanteChaveApiId_criadaEm_idx" ON "TarefaAnalitica"("solicitanteChaveApiId", "criadaEm");

-- CreateIndex
CREATE INDEX "Equipamento_tipo_estadoFisico_idx" ON "Equipamento"("tipo", "estadoFisico");

-- CreateIndex
CREATE INDEX "Movimentacao_tipo_destino_dataHora_idx" ON "Movimentacao"("tipo", "destino", "dataHora");

-- AddForeignKey
ALTER TABLE "Movimentacao" ADD CONSTRAINT "Movimentacao_chaveApiId_fkey" FOREIGN KEY ("chaveApiId") REFERENCES "ChaveApi"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auditoria" ADD CONSTRAINT "Auditoria_chaveApiId_fkey" FOREIGN KEY ("chaveApiId") REFERENCES "ChaveApi"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChaveApi" ADD CONSTRAINT "ChaveApi_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChaveApi" ADD CONSTRAINT "ChaveApi_criadoPorId_fkey" FOREIGN KEY ("criadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatorioAnalitico" ADD CONSTRAINT "RelatorioAnalitico_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatorioAnalitico" ADD CONSTRAINT "RelatorioAnalitico_solicitanteUsuarioId_fkey" FOREIGN KEY ("solicitanteUsuarioId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatorioAnalitico" ADD CONSTRAINT "RelatorioAnalitico_solicitanteChaveApiId_fkey" FOREIGN KEY ("solicitanteChaveApiId") REFERENCES "ChaveApi"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndicadorEficiencia" ADD CONSTRAINT "IndicadorEficiencia_relatorioId_fkey" FOREIGN KEY ("relatorioId") REFERENCES "RelatorioAnalitico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndicadorRentabilidade" ADD CONSTRAINT "IndicadorRentabilidade_relatorioId_fkey" FOREIGN KEY ("relatorioId") REFERENCES "RelatorioAnalitico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModeloVidaUtil" ADD CONSTRAINT "ModeloVidaUtil_relatorioId_fkey" FOREIGN KEY ("relatorioId") REFERENCES "RelatorioAnalitico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrevisaoVidaUtil" ADD CONSTRAINT "PrevisaoVidaUtil_relatorioId_fkey" FOREIGN KEY ("relatorioId") REFERENCES "RelatorioAnalitico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrevisaoVidaUtil" ADD CONSTRAINT "PrevisaoVidaUtil_modeloId_fkey" FOREIGN KEY ("modeloId") REFERENCES "ModeloVidaUtil"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrevisaoVidaUtil" ADD CONSTRAINT "PrevisaoVidaUtil_equipamentoId_fkey" FOREIGN KEY ("equipamentoId") REFERENCES "Equipamento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TarefaAnalitica" ADD CONSTRAINT "TarefaAnalitica_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TarefaAnalitica" ADD CONSTRAINT "TarefaAnalitica_solicitanteUsuarioId_fkey" FOREIGN KEY ("solicitanteUsuarioId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TarefaAnalitica" ADD CONSTRAINT "TarefaAnalitica_solicitanteChaveApiId_fkey" FOREIGN KEY ("solicitanteChaveApiId") REFERENCES "ChaveApi"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TarefaAnalitica" ADD CONSTRAINT "TarefaAnalitica_relatorioId_fkey" FOREIGN KEY ("relatorioId") REFERENCES "RelatorioAnalitico"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restrições complementares de integridade (AV3)
ALTER TABLE "Equipamento"
  ADD CONSTRAINT "Equipamento_valor_nao_negativo" CHECK ("valorRecuperado" IS NULL OR "valorRecuperado" >= 0);

ALTER TABLE "Movimentacao"
  ADD CONSTRAINT "Movimentacao_responsavel_exclusivo" CHECK (("responsavelId" IS NOT NULL) <> ("chaveApiId" IS NOT NULL));

ALTER TABLE "Auditoria"
  ADD CONSTRAINT "Auditoria_responsavel_exclusivo" CHECK (("usuarioResponsavelId" IS NOT NULL) <> ("chaveApiId" IS NOT NULL));

ALTER TABLE "ChaveApi"
  ADD CONSTRAINT "ChaveApi_versao_positiva" CHECK ("versao" > 0),
  ADD CONSTRAINT "ChaveApi_limite_valido" CHECK ("limitePorMinuto" BETWEEN 1 AND 10000),
  ADD CONSTRAINT "ChaveApi_escopos_nao_vazios" CHECK (cardinality("escopos") > 0),
  ADD CONSTRAINT "ChaveApi_hash_hex" CHECK ("hashSegredo" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "ChaveApi_parceiro_obrigatorio" CHECK (length(btrim("parceiro")) > 0);

ALTER TABLE "RelatorioAnalitico"
  ADD CONSTRAINT "RelatorioAnalitico_metricas_validas" CHECK ("amostras" >= 0 AND "duracaoMs" >= 0),
  ADD CONSTRAINT "RelatorioAnalitico_solicitante_unico" CHECK (NOT ("solicitanteUsuarioId" IS NOT NULL AND "solicitanteChaveApiId" IS NOT NULL));

ALTER TABLE "IndicadorEficiencia"
  ADD CONSTRAINT "IndicadorEficiencia_lotes_positivos" CHECK ("lotes" > 0),
  ADD CONSTRAINT "IndicadorEficiencia_tempos_nao_negativos" CHECK (
    "esperaMediaHoras" >= 0 AND "triagemMediaHoras" >= 0 AND "totalMediaHoras" >= 0 AND
    "totalMedianaHoras" >= 0 AND "totalDesvioHoras" >= 0 AND "totalP90Horas" >= 0
  );

ALTER TABLE "IndicadorRentabilidade"
  ADD CONSTRAINT "IndicadorRentabilidade_amostras_positivas" CHECK ("amostras" > 0),
  ADD CONSTRAINT "IndicadorRentabilidade_valores_nao_negativos" CHECK (
    "valorMedio" >= 0 AND "valorMediano" >= 0 AND "desvioPadrao" >= 0 AND "valorTotal" >= 0
  );

ALTER TABLE "ModeloVidaUtil"
  ADD CONSTRAINT "ModeloVidaUtil_amostras_nao_negativas" CHECK ("amostras" >= 0);

ALTER TABLE "PrevisaoVidaUtil"
  ADD CONSTRAINT "PrevisaoVidaUtil_idades_nao_negativas" CHECK ("idadeAtualAnos" >= 0 AND "vidaRemanescenteAnos" >= 0);

ALTER TABLE "TarefaAnalitica"
  ADD CONSTRAINT "TarefaAnalitica_tentativas_nao_negativas" CHECK ("tentativas" >= 0),
  ADD CONSTRAINT "TarefaAnalitica_solicitante_unico" CHECK (NOT ("solicitanteUsuarioId" IS NOT NULL AND "solicitanteChaveApiId" IS NOT NULL));

-- Relatórios analíticos históricos e seus detalhes são imutáveis após geração.
CREATE TRIGGER relatorio_analitico_imutavel BEFORE UPDATE OR DELETE ON "RelatorioAnalitico"
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico();
CREATE TRIGGER indicador_eficiencia_imutavel BEFORE UPDATE OR DELETE ON "IndicadorEficiencia"
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico();
CREATE TRIGGER indicador_rentabilidade_imutavel BEFORE UPDATE OR DELETE ON "IndicadorRentabilidade"
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico();
CREATE TRIGGER modelo_vida_util_imutavel BEFORE UPDATE OR DELETE ON "ModeloVidaUtil"
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico();
CREATE TRIGGER previsao_vida_util_imutavel BEFORE UPDATE OR DELETE ON "PrevisaoVidaUtil"
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_historico();
