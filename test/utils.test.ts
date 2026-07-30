import { afterEach, describe, expect, it, vi } from "vitest";
import { inferPublicBaseUrl, withProtocol } from "../src/utils.js";

describe("withProtocol", () => {
  it.each([
    "HTTP://localhost:18789",
    "Https://localhost:18789",
  ])("preserves an existing HTTP(S) scheme case-insensitively: %s", (url) => {
    expect(withProtocol(url)).toBe(url);
  });

  it("adds HTTP when no protocol is present", () => {
    expect(withProtocol("localhost:18789")).toBe("http://localhost:18789");
  });
});

describe("inferPublicBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.CLAWSENSE_PUBLIC_HOST;
  });

  it("prefers explicit plugin publicBaseUrl", () => {
    const result = inferPublicBaseUrl({
      preferred: "https://example.com/clawsense/",
      config: {},
      gatewayPort: 18789,
    });

    expect(result).toBe("https://example.com/clawsense");
  });

  it("uses gateway allowed origin before bind alias", () => {
    const result = inferPublicBaseUrl({
      config: {
        gateway: {
          bind: "lan",
          controlUi: {
            allowedOrigins: ["http://47.74.52.61:11571"],
          },
        },
      },
      gatewayPort: 11571,
    });

    expect(result).toBe("http://47.74.52.61:11571");
  });

  it("maps lan bind to CLAWSENSE_PUBLIC_HOST with gateway port", () => {
    vi.stubEnv("CLAWSENSE_PUBLIC_HOST", "47.74.52.61");

    const result = inferPublicBaseUrl({
      config: {
        gateway: {
          bind: "lan",
        },
      },
      gatewayPort: 18789,
    });

    expect(result).toBe("http://47.74.52.61:18789");
  });

  it("falls back to localhost when bind is wildcard and no public host configured", () => {
    const result = inferPublicBaseUrl({
      config: {
        gateway: {
          bind: "0.0.0.0",
        },
      },
      gatewayPort: 18789,
    });

    expect(result).toBe("http://127.0.0.1:18789");
  });

  it("keeps explicit bind host untouched", () => {
    const result = inferPublicBaseUrl({
      config: {
        gateway: {
          bind: "https://gateway.example.com:11571",
        },
      },
      gatewayPort: 11571,
    });

    expect(result).toBe("https://gateway.example.com:11571");
  });
});
