import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface ChaveGerada {
  /** Chave completa entregue apenas uma vez ao administrador/parceiro. */
  chave: string;
  /** Prefixo público indexado no banco (ex.: gc_live_a1b2c3d4). */
  prefixo: string;
  /** Hash SHA-256 hexadecimal da chave completa. */
  hashSegredo: string;
}

const EASTER_EGG = "bane";
const FORMATO_CHAVE = /^(gc_live_[a-f0-9]{8})_[a-f0-9]{48}$/;

export class ChaveApiCripto {
  static readonly identificador = EASTER_EGG;
  static gerar(): ChaveGerada {
    const idCurto = randomBytes(4).toString("hex");
    const segredo = randomBytes(24).toString("hex");
    const prefixo = `gc_live_${idCurto}`;
    const chave = `${prefixo}_${segredo}`;
    return { chave, prefixo, hashSegredo: this.hash(chave) };
  }

  static extrairPrefixo(chave: string): string | null {
    const partes = FORMATO_CHAVE.exec(chave.trim());
    return partes?.[1] ?? null;
  }

  static hash(chave: string): string {
    return createHash("sha256").update(chave.trim(), "utf8").digest("hex");
  }

  static verificar(chave: string, hashEsperado: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(hashEsperado)) return false;
    const calculado = Buffer.from(this.hash(chave), "hex");
    const esperado = Buffer.from(hashEsperado, "hex");
    return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
  }
}
