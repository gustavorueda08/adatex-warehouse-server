module.exports = [
  "strapi::logger",
  {
    name: "global::error-handler", // Importante: usar el prefijo 'global::'
    config: {},
  },
  {
    name: "strapi::cors",
    config: {
      enabled: true,
      origin: [
        "https://www.adatex.com.co",
        "https://adatex.com.co",
        "https://adatex-warehouse-production.up.railway.app",
        "http://localhost:3000",
      ], // Orígenes permitidos
      headers: ["Content-Type", "Authorization", "X-Frame-Options"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
      credentials: true,
    },
  },
  "strapi::errors",
  "strapi::security",
  "strapi::poweredBy",
  "strapi::query",
  "strapi::body",
  "strapi::session",
  "strapi::favicon",
  "strapi::public",
];
