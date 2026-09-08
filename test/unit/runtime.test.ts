// CRV · La guardia de engines.node convierte "corrió con el Node equivocado"
// en un fallo explícito (PHASES F0).
import { describe, expect, it } from "vitest";
import { MIN_NODE_MAJOR, nodeMajor, isSupportedNode, assertSupportedNode } from "../../src/config/runtime.js";

describe("guardia de versión de Node", () => {
  it("parsea la versión del runtime", () => {
    expect(nodeMajor("v22.23.1")).toBe(22);
    expect(nodeMajor("20.20.2")).toBe(20);
    expect(Number.isNaN(nodeMajor("desconocida"))).toBe(true);
  });

  it("acepta >= 22 y rechaza lo anterior", () => {
    expect(isSupportedNode(`v${MIN_NODE_MAJOR}.0.0`)).toBe(true);
    expect(isSupportedNode("v24.0.0")).toBe(true);
    expect(isSupportedNode("v20.20.2")).toBe(false);
    expect(isSupportedNode("desconocida")).toBe(false);
  });

  it("assertSupportedNode explica cómo arreglarlo", () => {
    expect(() => assertSupportedNode("v20.20.2")).toThrowError(/nvm use|with-node22/);
    expect(() => assertSupportedNode(process.version)).not.toThrow();
  });

  it("el runtime que corre los tests cumple el contrato", () => {
    expect(isSupportedNode()).toBe(true);
  });
});
