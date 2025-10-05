module.exports = [
  "strapi::logger",
  {
    name: "global::error-handler", // Importante: usar el prefijo 'global::'
    config: {},
  },
  "strapi::errors",
  "strapi::security",
  "strapi::cors",
  "strapi::poweredBy",
  "strapi::query",
  "strapi::body",
  "strapi::session",
  "strapi::favicon",
  "strapi::public",
];
