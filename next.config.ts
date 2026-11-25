import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Todas las pantallas dependen de la sesión del usuario: no hay nada útil que prerenderizar,
  // así que dejamos Cache Components apagado y cada página se resuelve por request.
  cacheComponents: false,
  // pdfjs y sharp se cargan desde node_modules en el servidor (sin bundlear):
  // pdfjs trae su propio worker y sharp binarios nativos.
  serverExternalPackages: ["pdfjs-dist", "sharp"],
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", "./samples/planos-prueba.pdf"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
