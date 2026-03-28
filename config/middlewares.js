// Build the S3 base URL from env vars so it doesn't need to be hardcoded here.
// Falls back to the empty string (no S3 directive added) if the bucket isn't configured.
const s3Url =
  process.env.AWS_BUCKET && process.env.AWS_REGION
    ? `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/`
    : null;

const allowedOrigins = [
  "https://www.adatex.com.co",
  "https://adatex.com.co",
  "https://adatex-warehouse-production.up.railway.app",
  "http://localhost:3000",
  // Additional origins can be injected via CORS_ADDITIONAL_ORIGINS (comma-separated)
  ...(process.env.CORS_ADDITIONAL_ORIGINS
    ? process.env.CORS_ADDITIONAL_ORIGINS.split(",").map((o) => o.trim())
    : []),
];

module.exports = [
  "strapi::logger",
  {
    name: "global::error-handler",
    config: {},
  },
  {
    name: "strapi::cors",
    config: {
      enabled: true,
      origin: allowedOrigins,
      headers: ["Content-Type", "Authorization", "X-Frame-Options"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
      credentials: true,
    },
  },
  "strapi::errors",
  {
    name: "strapi::security",
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "connect-src": ["'self'", "https:"],
          "img-src": [
            "'self'",
            "data:",
            "blob:",
            "dl.airtable.com",
            ...(s3Url ? [s3Url] : []),
          ],
          "media-src": [
            "'self'",
            "data:",
            "blob:",
            "dl.airtable.com",
            ...(s3Url ? [s3Url] : []),
          ],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  "strapi::poweredBy",
  "strapi::query",
  "strapi::body",
  "strapi::session",
  "strapi::favicon",
  "strapi::public",
];
